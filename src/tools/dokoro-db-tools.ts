/**
 * Devlog MCP Tools - Database Operations
 *
 * MCP tools for the new SQLite-based devlog system.
 * These tools work with per-project databases.
 */

import { z } from "zod";
import * as path from "node:path";
import * as fs from "node:fs";
import {
  getDb,
  createDoc,
  updateDoc,
  getDoc,
  searchDocs,
  addTagsToDoc,
  removeTagsFromDoc,
  getDocTags,
  getAllTags,
  findSectionsByTag,
  startSession,
  endSession,
  getActiveSession,
  startTimeEntry,
  endTimeEntry,
  getActiveTimeEntries,
  type DevlogDbConfig,
  type SearchOptions,
} from "../db/index.js";
import { migrateDevlog, type MigrationOptions } from "../db/migrate.js";

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

interface ToolResult {
  content: Array<{ type: "text"; text: string }>;
  isError?: boolean;
}

interface ToolDefinition {
  name: string;
  description: string;
  inputSchema: z.ZodObject<z.ZodRawShape>;
  handler: (args: Record<string, unknown>) => Promise<ToolResult>;
}

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function getDbConfig(projectPath?: string): DevlogDbConfig {
  const resolvedPath = projectPath || process.cwd();

  // Find devlog folder (check common locations)
  const possibleFolders = ["devlog", "docs/devlog", ".devlog"];
  let devlogFolder = "devlog";

  for (const folder of possibleFolders) {
    if (fs.existsSync(path.join(resolvedPath, folder))) {
      devlogFolder = folder;
      break;
    }
  }

  return {
    projectPath: resolvedPath,
    devlogFolder,
  };
}

function success(message: string | object): ToolResult {
  const text = typeof message === "string" ? message : JSON.stringify(message, null, 2);
  return { content: [{ type: "text", text }] };
}

function error(message: string): ToolResult {
  return { content: [{ type: "text", text: `Error: ${message}` }], isError: true };
}

// ═══════════════════════════════════════════════════════════════════════════
// INITIALIZATION TOOLS
// ═══════════════════════════════════════════════════════════════════════════

const devlogInitTool: ToolDefinition = {
  name: "dokoro_init",
  description:
    "Initialize devlog for a project. Creates the .devlog folder structure and SQLite database. Run this first before using other devlog tools.",
  inputSchema: z.object({
    project_path: z.string().optional().describe("Path to project root. Defaults to current directory."),
    dokoro_folder: z.string().optional().describe("Name of devlog folder. Defaults to 'devlog'."),
  }),
  handler: async (args) => {
    try {
      const config = getDbConfig(args.project_path as string | undefined);
      if (args.dokoro_folder) {
        config.devlogFolder = args.dokoro_folder as string;
      }

      const devlogPath = path.join(config.projectPath, config.devlogFolder!);
      const dbPath = path.join(devlogPath, ".devlog", "db");

      // Create folders
      const folders = [
        path.join(devlogPath, "inbox"),
        path.join(devlogPath, "active"),
        path.join(devlogPath, "backlog"),
        path.join(devlogPath, "archive"),
        path.join(devlogPath, "research"),
        path.join(devlogPath, "decisions"),
        path.join(devlogPath, ".devlog", "db"),
        path.join(devlogPath, ".devlog", "backup"),
      ];

      for (const folder of folders) {
        if (!fs.existsSync(folder)) {
          fs.mkdirSync(folder, { recursive: true });
        }
      }

      // Initialize database (this creates the schema)
      getDb(config);

      // Create config file
      const configPath = path.join(devlogPath, ".devlog", "config.json");
      if (!fs.existsSync(configPath)) {
        fs.writeFileSync(
          configPath,
          JSON.stringify(
            {
              version: "2.0",
              projectName: path.basename(config.projectPath),
              createdAt: new Date().toISOString(),
            },
            null,
            2
          )
        );
      }

      return success({
        message: "Devlog initialized successfully",
        path: devlogPath,
        database: path.join(dbPath, "devlog.sqlite"),
        folders: folders.map((f) => path.relative(config.projectPath, f)),
      });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
  },
};

const devlogMigrateTool: ToolDefinition = {
  name: "dokoro_migrate",
  description:
    "Migrate existing markdown files into the SQLite database. Extracts tags, frontmatter, and section tags. Safe to run multiple times - only updates changed files.",
  inputSchema: z.object({
    project_path: z.string().optional().describe("Path to project root. Defaults to current directory."),
    dokoro_folder: z.string().optional().describe("Name of devlog folder. Defaults to 'devlog'."),
    dry_run: z.boolean().optional().describe("Preview changes without modifying database."),
    force: z.boolean().optional().describe("Re-import all files even if unchanged."),
  }),
  handler: async (args) => {
    try {
      const options: MigrationOptions = {
        projectPath: (args.project_path as string) || process.cwd(),
        devlogFolder: (args.dokoro_folder as string) || "devlog",
        dryRun: args.dry_run as boolean,
        force: args.force as boolean,
        verbose: false,
      };

      const result = await migrateDevlog(options);

      return success({
        message: args.dry_run ? "Migration preview (dry run)" : "Migration complete",
        totalFiles: result.totalFiles,
        imported: result.imported,
        updated: result.updated,
        skipped: result.skipped,
        errors: result.errors.length,
        errorDetails: result.errors.slice(0, 5),
      });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// DOCUMENT TOOLS
// ═══════════════════════════════════════════════════════════════════════════

const devlogSearchTool: ToolDefinition = {
  name: "dokoro_search",
  description:
    "Search devlog documents. Supports full-text search, filtering by status/type/tags/priority, and pagination.",
  inputSchema: z.object({
    query: z.string().optional().describe("Search query (searches title and content)."),
    status: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("Filter by status: inbox, active, researched, backlog, done, archived."),
    doc_type: z
      .union([z.string(), z.array(z.string())])
      .optional()
      .describe("Filter by type: issue, prd, research, decision, note."),
    tags: z.array(z.string()).optional().describe("Filter by tags (documents must have ALL specified tags)."),
    priority: z.string().optional().describe("Filter by priority: low, medium, high, urgent."),
    prd_stage: z.string().optional().describe("Filter PRDs by stage: idea, breakdown, improve, finalize."),
    limit: z.number().optional().describe("Maximum results to return. Default: 20."),
    offset: z.number().optional().describe("Skip first N results for pagination."),
    order_by: z.enum(["created", "updated", "title", "priority"]).optional().describe("Sort field."),
    order_dir: z.enum(["asc", "desc"]).optional().describe("Sort direction."),
    project_path: z.string().optional().describe("Path to project root."),
  }),
  handler: async (args) => {
    try {
      const config = getDbConfig(args.project_path as string | undefined);
      const db = getDb(config);

      const options: SearchOptions = {
        query: args.query as string | undefined,
        status: args.status as string | string[] | undefined,
        docType: args.doc_type as string | string[] | undefined,
        tags: args.tags as string[] | undefined,
        priority: args.priority as string | undefined,
        prdStage: args.prd_stage as string | undefined,
        limit: (args.limit as number) || 20,
        offset: args.offset as number | undefined,
        orderBy: args.order_by as SearchOptions["orderBy"],
        orderDir: args.order_dir as SearchOptions["orderDir"],
      };

      const results = await searchDocs(db, options);

      return success({
        count: results.length,
        results: results.map((doc) => ({
          id: doc.id,
          title: doc.title,
          status: doc.status,
          type: doc.docType,
          priority: doc.priority,
          prdStage: doc.prdStage,
          filepath: doc.filepath,
          createdAt: doc.createdAt,
          updatedAt: doc.updatedAt,
        })),
      });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
  },
};

const devlogGetTool: ToolDefinition = {
  name: "dokoro_get",
  description: "Get a specific devlog document by ID with full content and tags.",
  inputSchema: z.object({
    id: z.string().describe("Document ID (usually the filename without .md extension)."),
    project_path: z.string().optional().describe("Path to project root."),
  }),
  handler: async (args) => {
    try {
      const config = getDbConfig(args.project_path as string | undefined);
      const db = getDb(config);

      const doc = await getDoc(db, args.id as string);
      if (!doc) {
        return error(`Document not found: ${args.id}`);
      }

      const tags = await getDocTags(db, doc.id);

      return success({
        ...doc,
        tags: tags.map((t) => t.name),
      });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
  },
};

const devlogCreateTool: ToolDefinition = {
  name: "dokoro_create",
  description: "Create a new devlog document. Creates both the markdown file and database entry. Use components to track which code files this PRD/issue affects.",
  inputSchema: z.object({
    title: z.string().describe("Document title."),
    content: z.string().optional().describe("Markdown content."),
    doc_type: z
      .enum(["issue", "prd", "research", "decision", "note"])
      .optional()
      .describe("Document type. Default: issue."),
    status: z.enum(["inbox", "active", "researched", "backlog"]).optional().describe("Initial status. Default: inbox."),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional().describe("Priority. Default: medium."),
    tags: z.array(z.string()).optional().describe("Tags to add."),
    prd_stage: z.enum(["idea", "breakdown", "improve", "finalize"]).optional().describe("PRD stage (for PRD docs)."),
    time_estimate: z.string().optional().describe("Time estimate (e.g., '2h', '30m')."),
    components: z.array(z.string()).optional().describe("Code file paths affected by this document (e.g., ['src/components/Button.tsx', 'src/api/auth.ts']). Useful for tracking which files a PRD or issue impacts."),
    project_path: z.string().optional().describe("Path to project root."),
  }),
  handler: async (args) => {
    try {
      const config = getDbConfig(args.project_path as string | undefined);
      const db = getDb(config);

      // Generate ID and filepath
      const date = new Date().toISOString().split("T")[0];
      const slug = (args.title as string)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .substring(0, 50);
      const id = `${date}-${slug}`;
      const folder = (args.status as string) || "inbox";
      const filepath = `${folder}/${id}.md`;

      // Parse time estimate
      let timeEstimatedMin: number | undefined;
      if (args.time_estimate) {
        const est = args.time_estimate as string;
        const hourMatch = est.match(/(\d+(?:\.\d+)?)\s*h/i);
        const minMatch = est.match(/(\d+)\s*m/i);
        if (hourMatch) {
          timeEstimatedMin = Math.round(parseFloat(hourMatch[1]) * 60);
        } else if (minMatch) {
          timeEstimatedMin = parseInt(minMatch[1], 10);
        }
      }

      // Create frontmatter
      const frontmatter = [
        "---",
        `title: "${args.title}"`,
        `status: ${args.status || "inbox"}`,
        `type: ${args.doc_type || "issue"}`,
        `priority: ${args.priority || "medium"}`,
        `created: ${new Date().toISOString()}`,
      ];

      if (args.tags && (args.tags as string[]).length > 0) {
        frontmatter.push(`tags: [${(args.tags as string[]).join(", ")}]`);
      }
      if (args.prd_stage) {
        frontmatter.push(`prd_stage: ${args.prd_stage}`);
      }
      if (args.time_estimate) {
        frontmatter.push(`time_est: ${args.time_estimate}`);
      }
      if (args.components && (args.components as string[]).length > 0) {
        frontmatter.push(`components: ${JSON.stringify(args.components)}`);
      }

      frontmatter.push("---", "", `# ${args.title}`, "");

      if (args.content) {
        frontmatter.push(args.content as string);
      }

      const content = frontmatter.join("\n");

      // Write markdown file
      const fullPath = path.join(config.projectPath, config.devlogFolder!, filepath);
      const dir = path.dirname(fullPath);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
      }
      fs.writeFileSync(fullPath, content);

      // Create database entry
      const doc = await createDoc(db, {
        id,
        filepath,
        title: args.title as string,
        content,
        docType: (args.doc_type as string) || "issue",
        status: (args.status as string) || "inbox",
        priority: (args.priority as string) || "medium",
        prdStage: args.prd_stage as string | undefined,
        timeEstimatedMin,
        tags: args.tags as string[] | undefined,
      });

      return success({
        message: "Document created",
        id: doc.id,
        filepath: doc.filepath,
        fullPath,
      });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
  },
};

const devlogUpdateTool: ToolDefinition = {
  name: "dokoro_update",
  description: "Update a devlog document status, priority, components, or other fields. Use components to track which code files this document affects.",
  inputSchema: z.object({
    id: z.string().describe("Document ID to update."),
    status: z.enum(["inbox", "active", "researched", "backlog", "done", "archived"]).optional().describe("New status."),
    priority: z.enum(["low", "medium", "high", "urgent"]).optional().describe("New priority."),
    prd_stage: z.enum(["idea", "breakdown", "improve", "finalize"]).optional().describe("New PRD stage."),
    parallel_slot: z.number().min(1).max(5).optional().describe("Terminal slot assignment (1-5)."),
    components: z.array(z.string()).optional().describe("Code file paths affected (replaces existing). E.g., ['src/Button.tsx']."),
    add_tags: z.array(z.string()).optional().describe("Tags to add."),
    remove_tags: z.array(z.string()).optional().describe("Tags to remove."),
    project_path: z.string().optional().describe("Path to project root."),
  }),
  handler: async (args) => {
    try {
      const config = getDbConfig(args.project_path as string | undefined);
      const db = getDb(config);

      const existing = await getDoc(db, args.id as string);
      if (!existing) {
        return error(`Document not found: ${args.id}`);
      }

      // Update database
      const updates: Record<string, unknown> = {};
      if (args.status) updates.status = args.status;
      if (args.priority) updates.priority = args.priority;
      if (args.prd_stage) updates.prdStage = args.prd_stage;
      if (args.parallel_slot) updates.parallelSlot = args.parallel_slot;
      if (args.components) updates.components = JSON.stringify(args.components);
      if (args.status === "done") updates.completedAt = new Date().toISOString();

      const doc = await updateDoc(db, args.id as string, updates);

      // Handle tags
      if (args.add_tags) {
        await addTagsToDoc(db, args.id as string, args.add_tags as string[]);
      }
      if (args.remove_tags) {
        await removeTagsFromDoc(db, args.id as string, args.remove_tags as string[]);
      }

      const tags = await getDocTags(db, args.id as string);

      return success({
        message: "Document updated",
        id: doc?.id,
        status: doc?.status,
        priority: doc?.priority,
        tags: tags.map((t) => t.name),
      });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// TAG TOOLS
// ═══════════════════════════════════════════════════════════════════════════

const devlogTagsTool: ToolDefinition = {
  name: "dokoro_tags",
  description: "List all tags with usage counts, or get tags for a specific document.",
  inputSchema: z.object({
    doc_id: z.string().optional().describe("Get tags for specific document."),
    project_path: z.string().optional().describe("Path to project root."),
  }),
  handler: async (args) => {
    try {
      const config = getDbConfig(args.project_path as string | undefined);
      const db = getDb(config);

      if (args.doc_id) {
        const tags = await getDocTags(db, args.doc_id as string);
        return success({
          docId: args.doc_id,
          tags: tags.map((t) => ({ name: t.name, color: t.color })),
        });
      }

      const tags = await getAllTags(db);
      return success({
        tags: tags.map((t) => ({
          name: t.name,
          usageCount: t.usageCount,
          color: t.color,
        })),
      });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
  },
};

const devlogSectionTagsTool: ToolDefinition = {
  name: "dokoro_section_tags",
  description:
    "Find all sections tagged with a specific tag (e.g., 'plan', 'future-sprint'). Useful for finding planned features across documents.",
  inputSchema: z.object({
    tag: z.string().describe("Tag to search for."),
    project_path: z.string().optional().describe("Path to project root."),
  }),
  handler: async (args) => {
    try {
      const config = getDbConfig(args.project_path as string | undefined);
      const db = getDb(config);

      const results = await findSectionsByTag(db, args.tag as string);

      return success({
        tag: args.tag,
        count: results.length,
        sections: results.map((r) => ({
          docId: r.doc.id,
          docTitle: r.doc.title,
          filepath: r.doc.filepath,
          sectionHeader: r.section.sectionHeader,
          lineNumber: r.section.lineNumber,
          preview: r.section.content?.substring(0, 200),
        })),
      });
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// SESSION & TIME TRACKING TOOLS
// ═══════════════════════════════════════════════════════════════════════════

const devlogSessionTool: ToolDefinition = {
  name: "dokoro_session",
  description: "Start, end, or check current devlog session.",
  inputSchema: z.object({
    action: z.enum(["start", "end", "status"]).describe("Action to perform."),
    focus_doc: z.string().optional().describe("Document to focus on (for start action)."),
    summary: z.string().optional().describe("Session summary (for end action)."),
    project_path: z.string().optional().describe("Path to project root."),
  }),
  handler: async (args) => {
    try {
      const config = getDbConfig(args.project_path as string | undefined);
      const db = getDb(config);

      switch (args.action) {
        case "start": {
          const session = await startSession(db, {
            focusDocId: args.focus_doc as string | undefined,
          });
          return success({
            message: "Session started",
            sessionId: session.id,
            startedAt: session.startedAt,
            focusDoc: session.focusDocId,
          });
        }

        case "end": {
          const active = await getActiveSession(db);
          if (!active) {
            return error("No active session to end");
          }
          const ended = await endSession(db, active.id, args.summary as string | undefined);
          return success({
            message: "Session ended",
            sessionId: ended?.id,
            duration: ended?.endedAt
              ? `${Math.round((new Date(ended.endedAt).getTime() - new Date(ended.startedAt).getTime()) / 60000)} minutes`
              : undefined,
            summary: ended?.summary,
          });
        }

        case "status": {
          const current = await getActiveSession(db);
          if (!current) {
            return success({ message: "No active session" });
          }
          const duration = Math.round((Date.now() - new Date(current.startedAt).getTime()) / 60000);
          return success({
            sessionId: current.id,
            startedAt: current.startedAt,
            durationMinutes: duration,
            focusDoc: current.focusDocId,
            status: current.status,
          });
        }

        default:
          return error(`Unknown action: ${args.action}`);
      }
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
  },
};

const devlogTimeTool: ToolDefinition = {
  name: "dokoro_time",
  description: "Track time spent on documents. Start/stop timers for tasks.",
  inputSchema: z.object({
    action: z.enum(["start", "stop", "status"]).describe("Action to perform."),
    doc_id: z.string().optional().describe("Document ID (required for start/stop)."),
    slot: z.number().min(1).max(5).optional().describe("Terminal slot (1-5) for parallel work tracking."),
    notes: z.string().optional().describe("Notes (for stop action)."),
    project_path: z.string().optional().describe("Path to project root."),
  }),
  handler: async (args) => {
    try {
      const config = getDbConfig(args.project_path as string | undefined);
      const db = getDb(config);

      switch (args.action) {
        case "start": {
          if (!args.doc_id) {
            return error("doc_id required for start action");
          }
          const entry = await startTimeEntry(db, args.doc_id as string, {
            terminalSlot: args.slot as number | undefined,
          });
          return success({
            message: "Timer started",
            entryId: entry.id,
            docId: entry.docId,
            slot: entry.terminalSlot,
            startedAt: entry.startedAt,
          });
        }

        case "stop": {
          const active = await getActiveTimeEntries(db);
          const entry = args.doc_id ? active.find((e) => e.docId === args.doc_id) : active[0];

          if (!entry) {
            return error("No active timer found");
          }

          const ended = await endTimeEntry(db, entry.id, args.notes as string | undefined);
          return success({
            message: "Timer stopped",
            docId: ended?.docId,
            durationMinutes: ended?.durationMin,
            notes: ended?.notes,
          });
        }

        case "status": {
          const entries = await getActiveTimeEntries(db);
          return success({
            activeTimers: entries.map((e) => ({
              docId: e.docId,
              docTitle: e.doc.title,
              slot: e.terminalSlot,
              startedAt: e.startedAt,
              runningMinutes: Math.round((Date.now() - new Date(e.startedAt).getTime()) / 60000),
            })),
          });
        }

        default:
          return error(`Unknown action: ${args.action}`);
      }
    } catch (err) {
      return error(err instanceof Error ? err.message : String(err));
    }
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT ALL TOOLS
// ═══════════════════════════════════════════════════════════════════════════

export const devlogDbTools: ToolDefinition[] = [
  // Initialization
  devlogInitTool,
  devlogMigrateTool,

  // Documents
  devlogSearchTool,
  devlogGetTool,
  devlogCreateTool,
  devlogUpdateTool,

  // Tags
  devlogTagsTool,
  devlogSectionTagsTool,

  // Sessions & Time
  devlogSessionTool,
  devlogTimeTool,
];

export default devlogDbTools;
