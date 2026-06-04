/**
 * Devlog Migration Tool
 *
 * Imports markdown files into SQLite database with:
 * - Frontmatter extraction (YAML)
 * - Tag extraction (YAML, hashtags, filename, folder)
 * - Section tag extraction (HTML comments after headers)
 * - Incremental updates (skip unchanged files via content hash)
 * - Backup before migration
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as crypto from "node:crypto";
import { glob } from "glob";
import matter from "gray-matter";
import {
  getDb,
  createDoc,
  updateDoc,
  getDoc,
  addTagsToDoc,
  addSectionTag,
  type DevlogDbConfig,
  type DocCreateInput,
} from "./index.js";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface MigrationOptions {
  projectPath: string;
  devlogFolder?: string; // Default: 'devlog'
  dryRun?: boolean;
  force?: boolean; // Re-import all files even if unchanged
  verbose?: boolean;
  backup?: boolean;
}

export interface MigrationResult {
  totalFiles: number;
  imported: number;
  updated: number;
  skipped: number;
  errors: Array<{ file: string; error: string }>;
}

interface ParsedMarkdown {
  id: string;
  filepath: string;
  title: string;
  content: string;
  contentHash: string;
  frontmatter: Record<string, unknown>;
  tags: Array<{ name: string; source: string }>;
  sectionTags: Array<{
    header: string;
    level: number;
    tags: string[];
    lineNumber: number;
    content: string;
  }>;
}

// ═══════════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════

const IGNORED_FOLDERS = [".mcp", ".obsidian", ".private", ".tags", ".git", "node_modules", ".devlog", ".dokoro-backup"];

const STATUS_MAP: Record<string, string> = {
  done: "done",
  completed: "done",
  finished: "done",
  active: "active",
  "in-progress": "active",
  "in_progress": "active",
  wip: "active",
  backlog: "backlog",
  todo: "backlog",
  planned: "backlog",
  inbox: "inbox",
  new: "inbox",
  archived: "archived",
};

const DOC_TYPE_MAP: Record<string, string> = {
  issue: "issue",
  bug: "issue",
  task: "issue",
  plan: "plan",
  prd: "prd",
  spec: "prd",
  requirement: "prd",
  research: "research",
  analysis: "research",
  investigation: "research",
  decision: "decision",
  adr: "decision",
  note: "note",
  meeting: "note",
  retrospective: "note",
};

const PRIORITY_MAP: Record<string, string> = {
  urgent: "urgent",
  critical: "urgent",
  p0: "urgent",
  high: "high",
  important: "high",
  p1: "high",
  medium: "medium",
  normal: "medium",
  p2: "medium",
  low: "low",
  minor: "low",
  p3: "low",
};

// ═══════════════════════════════════════════════════════════════════════════
// PARSING
// ═══════════════════════════════════════════════════════════════════════════

function parseMarkdownFile(filePath: string, devlogRoot: string): ParsedMarkdown {
  const content = fs.readFileSync(filePath, "utf-8");
  const relativePath = path.relative(devlogRoot, filePath);
  const filename = path.basename(filePath, ".md");

  // Parse frontmatter
  const { data: frontmatter, content: body } = matter(content);

  // Generate ID from filename
  const id = filename.toLowerCase().replace(/[^a-z0-9-]/g, "-");

  // Extract title
  const title = extractTitle(frontmatter, body, filename);

  // Calculate content hash
  const contentHash = crypto.createHash("md5").update(content).digest("hex");

  // Extract tags from multiple sources
  const tags = extractTags(frontmatter, body, filename, relativePath);

  // Extract section tags (HTML comments after headers)
  const sectionTags = extractSectionTags(body);

  return {
    id,
    filepath: relativePath,
    title,
    content,
    contentHash,
    frontmatter,
    tags,
    sectionTags,
  };
}

function extractTitle(frontmatter: Record<string, unknown>, body: string, filename: string): string {
  // Try frontmatter title
  if (frontmatter.title && typeof frontmatter.title === "string") {
    return frontmatter.title;
  }

  // Try first H1 header
  const h1Match = body.match(/^#\s+(.+)$/m);
  if (h1Match) {
    return h1Match[1].trim();
  }

  // Fall back to filename
  return filename
    .replace(/^\d{4}-\d{2}-\d{2}-?/, "") // Remove date prefix
    .replace(/-/g, " ")
    .replace(/\b\w/g, (c) => c.toUpperCase());
}

function extractTags(
  frontmatter: Record<string, unknown>,
  body: string,
  filename: string,
  relativePath: string
): Array<{ name: string; source: string }> {
  const tags: Array<{ name: string; source: string }> = [];
  const seen = new Set<string>();

  const addTag = (name: string, source: string) => {
    const normalized = name.toLowerCase().trim();
    if (normalized && !seen.has(normalized)) {
      seen.add(normalized);
      tags.push({ name: normalized, source });
    }
  };

  // 1. YAML frontmatter tags
  if (frontmatter.tags) {
    const yamlTags = Array.isArray(frontmatter.tags)
      ? frontmatter.tags
      : typeof frontmatter.tags === "string"
        ? frontmatter.tags.split(",")
        : [];

    for (const tag of yamlTags) {
      addTag(String(tag).trim(), "yaml");
    }
  }

  // 2. Inline hashtags
  const hashtagMatches = body.match(/#[\w-]+/g);
  if (hashtagMatches) {
    for (const tag of hashtagMatches) {
      // Skip markdown headers
      if (!body.includes("\n" + tag) || body.includes(" " + tag)) {
        addTag(tag.substring(1), "hashtag");
      }
    }
  }

  // 3. Filename patterns
  const filenameLower = filename.toLowerCase();
  for (const [keyword, tagName] of Object.entries(DOC_TYPE_MAP)) {
    if (filenameLower.includes(keyword)) {
      addTag(tagName, "filename");
    }
  }

  // Check for priority in filename
  for (const [keyword, priority] of Object.entries(PRIORITY_MAP)) {
    if (filenameLower.includes(keyword)) {
      addTag(priority, "filename");
    }
  }

  // 4. Folder location
  const folder = path.dirname(relativePath);
  if (folder && folder !== ".") {
    const folderParts = folder.split(path.sep);
    for (const part of folderParts) {
      const partLower = part.toLowerCase();
      // Map folder names to tags
      if (DOC_TYPE_MAP[partLower]) {
        addTag(DOC_TYPE_MAP[partLower], "folder");
      } else if (STATUS_MAP[partLower]) {
        addTag(STATUS_MAP[partLower], "folder");
      } else if (!["daily", "archive", "2024", "2025", "2026"].includes(partLower) && !/^\d{2}$/.test(partLower)) {
        addTag(partLower, "folder");
      }
    }
  }

  return tags;
}

function extractSectionTags(
  body: string
): Array<{ header: string; level: number; tags: string[]; lineNumber: number; content: string }> {
  const sectionTags: Array<{ header: string; level: number; tags: string[]; lineNumber: number; content: string }> = [];
  const lines = body.split("\n");

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // Match header with HTML comment tags: ## Header <!-- tags: tag1, tag2 -->
    const headerMatch = line.match(/^(#{1,6})\s+(.+?)\s*<!--\s*tags?:\s*(.+?)\s*-->\s*$/);
    if (headerMatch) {
      const level = headerMatch[1].length;
      const header = headerMatch[2].trim();
      const tagString = headerMatch[3];
      const tags = tagString.split(",").map((t) => t.trim().toLowerCase());

      // Extract section content (until next header of same or higher level)
      let content = "";
      for (let j = i + 1; j < lines.length; j++) {
        const nextLine = lines[j];
        const nextHeaderMatch = nextLine.match(/^(#{1,6})\s/);
        if (nextHeaderMatch && nextHeaderMatch[1].length <= level) {
          break;
        }
        content += nextLine + "\n";
      }

      sectionTags.push({
        header,
        level,
        tags,
        lineNumber: i + 1, // 1-indexed
        content: content.trim().substring(0, 500), // First 500 chars for preview
      });
    }
  }

  return sectionTags;
}

function inferDocType(frontmatter: Record<string, unknown>, filename: string, folder: string): string {
  // Check frontmatter.docType (used by planner_maker and workspace_dump)
  if (frontmatter.docType && typeof frontmatter.docType === "string") {
    const mapped = DOC_TYPE_MAP[frontmatter.docType.toLowerCase()];
    if (mapped) return mapped;
  }

  // Check frontmatter.type
  if (frontmatter.type && typeof frontmatter.type === "string") {
    const mapped = DOC_TYPE_MAP[frontmatter.type.toLowerCase()];
    if (mapped) return mapped;
  }

  // Check filename
  const filenameLower = filename.toLowerCase();
  for (const [keyword, docType] of Object.entries(DOC_TYPE_MAP)) {
    if (filenameLower.includes(keyword)) {
      return docType;
    }
  }

  // Check folder
  const folderLower = folder.toLowerCase();
  for (const [keyword, docType] of Object.entries(DOC_TYPE_MAP)) {
    if (folderLower.includes(keyword)) {
      return docType;
    }
  }

  return "issue"; // Default
}

function inferStatus(frontmatter: Record<string, unknown>, folder: string): string {
  // Check frontmatter
  if (frontmatter.status && typeof frontmatter.status === "string") {
    const mapped = STATUS_MAP[frontmatter.status.toLowerCase()];
    if (mapped) return mapped;
  }

  // Check folder
  const folderLower = folder.toLowerCase();
  for (const [keyword, status] of Object.entries(STATUS_MAP)) {
    if (folderLower.includes(keyword)) {
      return status;
    }
  }

  // Check if in archive folder
  if (folderLower.includes("archive")) {
    return "archived";
  }

  return "inbox"; // Default
}

function inferPriority(frontmatter: Record<string, unknown>, filename: string): string {
  // Check frontmatter
  if (frontmatter.priority && typeof frontmatter.priority === "string") {
    const mapped = PRIORITY_MAP[frontmatter.priority.toLowerCase()];
    if (mapped) return mapped;
  }

  // Check filename
  const filenameLower = filename.toLowerCase();
  for (const [keyword, priority] of Object.entries(PRIORITY_MAP)) {
    if (filenameLower.includes(keyword)) {
      return priority;
    }
  }

  return "medium"; // Default
}

function inferPrdStage(frontmatter: Record<string, unknown>): string | undefined {
  if (frontmatter.prd_stage && typeof frontmatter.prd_stage === "string") {
    return frontmatter.prd_stage;
  }
  if (frontmatter.stage && typeof frontmatter.stage === "string") {
    return frontmatter.stage;
  }
  return undefined;
}

function parseTimeEstimate(frontmatter: Record<string, unknown>): number | undefined {
  const estimate = frontmatter.time_est || frontmatter.estimate || frontmatter.time_estimated;
  if (!estimate) return undefined;

  const str = String(estimate);

  // Parse formats: "2h", "30m", "1.5h", "90min"
  const hourMatch = str.match(/(\d+(?:\.\d+)?)\s*h/i);
  if (hourMatch) {
    return Math.round(parseFloat(hourMatch[1]) * 60);
  }

  const minMatch = str.match(/(\d+)\s*m/i);
  if (minMatch) {
    return parseInt(minMatch[1], 10);
  }

  // Plain number assumed to be minutes
  const num = parseFloat(str);
  if (!isNaN(num)) {
    return Math.round(num);
  }

  return undefined;
}

// ═══════════════════════════════════════════════════════════════════════════
// MIGRATION
// ═══════════════════════════════════════════════════════════════════════════

export async function migrateDevlog(options: MigrationOptions): Promise<MigrationResult> {
  const devlogFolder = options.devlogFolder || "devlog";
  const devlogRoot = path.join(options.projectPath, devlogFolder);

  if (!fs.existsSync(devlogRoot)) {
    throw new Error(`Devlog folder not found: ${devlogRoot}`);
  }

  const result: MigrationResult = {
    totalFiles: 0,
    imported: 0,
    updated: 0,
    skipped: 0,
    errors: [],
  };

  // Find all markdown files
  const pattern = path.join(devlogRoot, "**/*.md");
  const files = await glob(pattern, {
    ignore: IGNORED_FOLDERS.map((f) => `**/${f}/**`),
  });

  result.totalFiles = files.length;

  if (options.dryRun) {
    console.log(`\nDRY RUN - Would migrate ${files.length} files\n`);
  }

  // Get database
  const dbConfig: DevlogDbConfig = {
    projectPath: options.projectPath,
    devlogFolder,
  };

  const db = getDb(dbConfig);

  for (const filePath of files) {
    try {
      const parsed = parseMarkdownFile(filePath, devlogRoot);

      // Check if document already exists
      const existing = await getDoc(db, parsed.id);

      if (existing) {
        // Check if content changed
        if (!options.force && existing.contentHash === parsed.contentHash) {
          result.skipped++;
          if (options.verbose) {
            console.log(`  Skipped (unchanged): ${parsed.filepath}`);
          }
          continue;
        }

        // Update existing document
        if (!options.dryRun) {
          await updateDoc(db, parsed.id, {
            title: parsed.title,
            content: parsed.content,
            docType: inferDocType(parsed.frontmatter, parsed.id, path.dirname(parsed.filepath)),
            status: inferStatus(parsed.frontmatter, path.dirname(parsed.filepath)),
            prdStage: inferPrdStage(parsed.frontmatter),
            priority: inferPriority(parsed.frontmatter, parsed.id),
            timeEstimatedMin: parseTimeEstimate(parsed.frontmatter),
            metadataJson: JSON.stringify(parsed.frontmatter),
          });

          // Update tags
          await addTagsToDoc(
            db,
            parsed.id,
            parsed.tags.map((t) => t.name),
            "migration"
          );

          // Add section tags
          for (const section of parsed.sectionTags) {
            for (const tagName of section.tags) {
              await addSectionTag(db, {
                docId: parsed.id,
                sectionHeader: section.header,
                sectionLevel: section.level,
                tagName,
                lineNumber: section.lineNumber,
                content: section.content,
                source: "comment",
              });
            }
          }
        }

        result.updated++;
        if (options.verbose) {
          console.log(`  Updated: ${parsed.filepath}`);
        }
      } else {
        // Create new document
        if (!options.dryRun) {
          const docInput: DocCreateInput = {
            id: parsed.id,
            filepath: parsed.filepath,
            title: parsed.title,
            content: parsed.content,
            docType: inferDocType(parsed.frontmatter, parsed.id, path.dirname(parsed.filepath)),
            status: inferStatus(parsed.frontmatter, path.dirname(parsed.filepath)),
            prdStage: inferPrdStage(parsed.frontmatter),
            priority: inferPriority(parsed.frontmatter, parsed.id),
            timeEstimatedMin: parseTimeEstimate(parsed.frontmatter),
            metadataJson: JSON.stringify(parsed.frontmatter),
            tags: parsed.tags.map((t) => t.name),
          };

          // Extract GitHub info from frontmatter
          if (parsed.frontmatter.gh_issue) {
            docInput.ghIssue = Number(parsed.frontmatter.gh_issue);
          }
          if (parsed.frontmatter.gh_pr) {
            docInput.ghPr = Number(parsed.frontmatter.gh_pr);
          }
          if (parsed.frontmatter.gh_repo) {
            docInput.ghRepo = String(parsed.frontmatter.gh_repo);
          }

          await createDoc(db, docInput);

          // Add section tags
          for (const section of parsed.sectionTags) {
            for (const tagName of section.tags) {
              await addSectionTag(db, {
                docId: parsed.id,
                sectionHeader: section.header,
                sectionLevel: section.level,
                tagName,
                lineNumber: section.lineNumber,
                content: section.content,
                source: "comment",
              });
            }
          }
        }

        result.imported++;
        if (options.verbose) {
          console.log(`  Imported: ${parsed.filepath}`);
        }
      }
    } catch (error) {
      result.errors.push({
        file: filePath,
        error: error instanceof Error ? error.message : String(error),
      });
      if (options.verbose) {
        console.error(`  Error: ${filePath} - ${error}`);
      }
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  const options: MigrationOptions = {
    projectPath: process.cwd(),
    devlogFolder: "devlog",
    dryRun: args.includes("--dry-run"),
    force: args.includes("--force"),
    verbose: args.includes("--verbose") || args.includes("-v"),
    backup: args.includes("--backup"),
  };

  // Parse --project path
  const projectIndex = args.indexOf("--project");
  if (projectIndex !== -1 && args[projectIndex + 1]) {
    options.projectPath = args[projectIndex + 1];
  }

  // Parse --devlog folder
  const devlogIndex = args.indexOf("--devlog");
  if (devlogIndex !== -1 && args[devlogIndex + 1]) {
    options.devlogFolder = args[devlogIndex + 1];
  }

  console.log("═".repeat(60));
  console.log("         DEVLOG MIGRATION");
  console.log("═".repeat(60));
  console.log(`Project: ${options.projectPath}`);
  console.log(`Devlog:  ${options.devlogFolder}`);
  console.log(`Mode:    ${options.dryRun ? "DRY RUN" : "EXECUTE"}`);
  console.log("─".repeat(60));

  const result = await migrateDevlog(options);

  console.log("\n" + "─".repeat(60));
  console.log("RESULTS:");
  console.log(`  Total files:  ${result.totalFiles}`);
  console.log(`  Imported:     ${result.imported}`);
  console.log(`  Updated:      ${result.updated}`);
  console.log(`  Skipped:      ${result.skipped}`);
  console.log(`  Errors:       ${result.errors.length}`);

  if (result.errors.length > 0) {
    console.log("\nERRORS:");
    for (const err of result.errors.slice(0, 10)) {
      console.log(`  ${err.file}: ${err.error}`);
    }
    if (result.errors.length > 10) {
      console.log(`  ... and ${result.errors.length - 10} more`);
    }
  }

  console.log("═".repeat(60));
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}
