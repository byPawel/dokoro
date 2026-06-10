#!/usr/bin/env node
/**
 * Dokoro CLI
 *
 * Command-line interface for dokoro management.
 * Run from your project folder to manage dokoro files and database.
 *
 * Usage:
 *   dokoro init              - Initialize dokoro in current project
 *   dokoro migrate           - Import markdown files into database
 *   dokoro search <query>    - Search dokoro documents
 *   dokoro list              - List recent documents
 *   dokoro create <title>    - Create new document
 *   dokoro status <id>       - Update document status
 *   dokoro tags              - List all tags
 *   dokoro cleanup           - Run cleanup script
 */

import * as path from "node:path";
import * as fs from "node:fs";
import {
  getDb,
  searchDocs,
  getDoc,
  updateDoc,
  getAllTags,
  getDocTags,
  addTagsToDoc,
  startSession,
  endSession,
  getActiveSession,
  startTimeEntry,
  endTimeEntry,
  getActiveTimeEntries,
  closeAllDbs,
  type DokoroDbConfig,
} from "./db/index.js";
import { migrateDokoro } from "./db/migrate.js";

// ═══════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════

function findProjectRoot(): string {
  let dir = process.cwd();

  // Walk up looking for dokoro folder or package.json
  while (dir !== path.dirname(dir)) {
    if (fs.existsSync(path.join(dir, "dokoro")) || fs.existsSync(path.join(dir, "package.json"))) {
      return dir;
    }
    dir = path.dirname(dir);
  }

  return process.cwd();
}

function getConfig(): DokoroDbConfig {
  const projectPath = findProjectRoot();
  const possibleFolders = ["dokoro", "docs/dokoro", ".dokoro"];
  let dokoroFolder = "dokoro";

  for (const folder of possibleFolders) {
    if (fs.existsSync(path.join(projectPath, folder))) {
      dokoroFolder = folder;
      break;
    }
  }

  return { projectPath, dokoroFolder };
}

function printHelp(): void {
  console.log(`
Dokoro CLI - Developer Knowledge Management

USAGE:
  dokoro <command> [options]

COMMANDS:
  init                    Initialize dokoro in current project
  migrate [--dry-run]     Import markdown files into database
  search <query>          Search documents by text
  list [--status=X]       List documents (filter by status)
  get <id>                Get document details
  create <title>          Create new document interactively
  update <id>             Update document status/priority
  tags [--doc=ID]         List tags (optionally for specific doc)
  tag <id> <tag>          Add tag to document
  untag <id> <tag>        Remove tag from document
  browse [--path=DIR]     Interactive workspace browser (TUI)

  session start [--focus=ID]   Start work session
  session end [--summary=X]    End work session
  session status               Show current session

  time start <id> [--slot=N]   Start timer on document
  time stop [<id>]             Stop timer
  time status                  Show active timers

  cleanup [--dry-run]     Preview/run cleanup script

OPTIONS:
  --project=PATH          Override project path
  --dokoro=FOLDER         Override dokoro folder name
  --path=DIR              Dokoro folder for 'browse' (default: auto-discover)
  --help                  Show this help

EXAMPLES:
  dokoro init                          # Initialize dokoro
  dokoro migrate --dry-run             # Preview migration
  dokoro search "rate limit"           # Search documents
  dokoro list --status=active          # List active documents
  dokoro create "Fix login bug"        # Create new issue
  dokoro update my-doc --status=done   # Mark as done
  dokoro tag my-doc urgent             # Add tag
  dokoro time start my-doc --slot=1    # Start timer
`);
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return "-";
  const date = new Date(dateStr);
  return date.toLocaleDateString() + " " + date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function parseArgs(args: string[]): { command: string; positional: string[]; flags: Record<string, string | boolean> } {
  const result = {
    command: args[0] || "help",
    positional: [] as string[],
    flags: {} as Record<string, string | boolean>,
  };

  for (let i = 1; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith("--")) {
      const [key, value] = arg.slice(2).split("=");
      result.flags[key] = value ?? true;
    } else if (arg.startsWith("-")) {
      result.flags[arg.slice(1)] = true;
    } else {
      result.positional.push(arg);
    }
  }

  return result;
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════════════════════

async function cmdInit(): Promise<void> {
  const config = getConfig();
  const dokoroPath = path.join(config.projectPath, config.dokoroFolder!);
  console.log("Initializing dokoro...\n");

  // Create folders
  const folders = ["inbox", "active", "backlog", "archive", "research", "decisions", ".dokoro/db", ".dokoro/backup"];

  for (const folder of folders) {
    const fullPath = path.join(dokoroPath, folder);
    if (!fs.existsSync(fullPath)) {
      fs.mkdirSync(fullPath, { recursive: true });
      console.log(`  Created: ${folder}/`);
    }
  }

  // Initialize database
  getDb(config);
  console.log(`  Database: .dokoro/db/dokoro.sqlite`);

  // Create config
  const configPath = path.join(dokoroPath, ".dokoro", "config.json");
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
    console.log(`  Config: .dokoro/config.json`);
  }

  console.log(`\nDokoro initialized at: ${dokoroPath}`);
  console.log("\nNext steps:");
  console.log("  1. Run 'dokoro migrate' to import existing markdown files");
  console.log("  2. Run 'dokoro list' to see your documents");
}

async function cmdMigrate(flags: Record<string, string | boolean>): Promise<void> {
  const config = getConfig();
  const dryRun = !!flags["dry-run"];

  console.log("═".repeat(60));
  console.log("         DOKORO MIGRATION");
  console.log("═".repeat(60));
  console.log(`Project: ${config.projectPath}`);
  console.log(`Dokoro:  ${config.dokoroFolder}`);
  console.log(`Mode:    ${dryRun ? "DRY RUN" : "EXECUTE"}`);
  console.log("─".repeat(60));

  const result = await migrateDokoro({
    projectPath: config.projectPath,
    dokoroFolder: config.dokoroFolder,
    dryRun,
    verbose: true,
  });

  console.log("\n" + "─".repeat(60));
  console.log("RESULTS:");
  console.log(`  Total files:  ${result.totalFiles}`);
  console.log(`  Imported:     ${result.imported}`);
  console.log(`  Updated:      ${result.updated}`);
  console.log(`  Skipped:      ${result.skipped}`);
  console.log(`  Errors:       ${result.errors.length}`);
  console.log("═".repeat(60));
}

async function cmdSearch(query: string, flags: Record<string, string | boolean>): Promise<void> {
  const config = getConfig();
  const db = getDb(config);

  const status = flags.status as string | undefined;
  const docType = flags.type as string | undefined;
  const limit = parseInt(flags.limit as string) || 20;

  const results = await searchDocs(db, {
    query: query || undefined,
    status,
    docType,
    limit,
    orderBy: "updated",
    orderDir: "desc",
  });

  if (results.length === 0) {
    console.log("No documents found.");
    return;
  }

  console.log(`Found ${results.length} document(s):\n`);

  for (const doc of results) {
    const tags = await getDocTags(db, doc.id);
    const tagStr = tags.length > 0 ? ` [${tags.map((t) => t.name).join(", ")}]` : "";

    console.log(`  ${doc.id}`);
    console.log(`    Title:    ${doc.title}`);
    console.log(`    Status:   ${doc.status}  |  Priority: ${doc.priority}  |  Type: ${doc.docType}`);
    console.log(`    Updated:  ${formatDate(doc.updatedAt)}${tagStr}`);
    console.log("");
  }
}

async function cmdList(flags: Record<string, string | boolean>): Promise<void> {
  const config = getConfig();
  const db = getDb(config);

  const status = (flags.status as string) || "active";
  const limit = parseInt(flags.limit as string) || 20;

  const results = await searchDocs(db, {
    status,
    limit,
    orderBy: "updated",
    orderDir: "desc",
  });

  if (results.length === 0) {
    console.log(`No documents with status '${status}'.`);
    return;
  }

  console.log(`\n${status.toUpperCase()} documents (${results.length}):\n`);

  for (const doc of results) {
    const slot = doc.parallelSlot ? `[Slot ${doc.parallelSlot}]` : "";
    const est = doc.timeEstimatedMin ? `~${doc.timeEstimatedMin}m` : "";
    console.log(`  ${slot.padEnd(10)} ${doc.id.substring(0, 40).padEnd(42)} ${est.padEnd(8)} ${doc.priority}`);
  }
  console.log("");
}

async function cmdGet(id: string): Promise<void> {
  const config = getConfig();
  const db = getDb(config);

  const doc = await getDoc(db, id);
  if (!doc) {
    console.error(`Document not found: ${id}`);
    process.exit(1);
  }

  const tags = await getDocTags(db, id);

  console.log("\n" + "═".repeat(60));
  console.log(`  ${doc.title}`);
  console.log("═".repeat(60));
  console.log(`  ID:       ${doc.id}`);
  console.log(`  File:     ${doc.filepath}`);
  console.log(`  Status:   ${doc.status}`);
  console.log(`  Type:     ${doc.docType}`);
  console.log(`  Priority: ${doc.priority}`);
  if (doc.prdStage) console.log(`  PRD Stage: ${doc.prdStage}`);
  if (doc.parallelSlot) console.log(`  Slot:     ${doc.parallelSlot}`);
  if (doc.timeEstimatedMin) console.log(`  Estimate: ${doc.timeEstimatedMin} minutes`);
  if (doc.timeActualMin) console.log(`  Actual:   ${doc.timeActualMin} minutes`);
  console.log(`  Created:  ${formatDate(doc.createdAt)}`);
  console.log(`  Updated:  ${formatDate(doc.updatedAt)}`);
  if (tags.length > 0) {
    console.log(`  Tags:     ${tags.map((t) => t.name).join(", ")}`);
  }
  console.log("─".repeat(60));
}

async function cmdUpdate(id: string, flags: Record<string, string | boolean>): Promise<void> {
  const config = getConfig();
  const db = getDb(config);

  const existing = await getDoc(db, id);
  if (!existing) {
    console.error(`Document not found: ${id}`);
    process.exit(1);
  }

  const updates: Record<string, unknown> = {};
  if (flags.status) updates.status = flags.status;
  if (flags.priority) updates.priority = flags.priority;
  if (flags.stage) updates.prdStage = flags.stage;
  if (flags.slot) updates.parallelSlot = parseInt(flags.slot as string);
  if (flags.status === "done") updates.completedAt = new Date().toISOString();

  if (Object.keys(updates).length === 0) {
    console.log("No updates specified. Use --status, --priority, --stage, or --slot.");
    return;
  }

  await updateDoc(db, id, updates);
  console.log(`Updated ${id}:`);
  for (const [key, value] of Object.entries(updates)) {
    console.log(`  ${key}: ${value}`);
  }
}

async function cmdTags(flags: Record<string, string | boolean>): Promise<void> {
  const config = getConfig();
  const db = getDb(config);

  if (flags.doc) {
    const tags = await getDocTags(db, flags.doc as string);
    console.log(`\nTags for ${flags.doc}:`);
    for (const tag of tags) {
      console.log(`  - ${tag.name}`);
    }
  } else {
    const tags = await getAllTags(db);
    console.log("\nAll tags:\n");
    for (const tag of tags) {
      console.log(`  ${tag.name.padEnd(20)} (${tag.usageCount} uses)`);
    }
  }
  console.log("");
}

async function cmdTag(id: string, tagName: string): Promise<void> {
  const config = getConfig();
  const db = getDb(config);

  await addTagsToDoc(db, id, [tagName]);
  console.log(`Added tag '${tagName}' to ${id}`);
}

async function cmdSession(action: string, flags: Record<string, string | boolean>): Promise<void> {
  const config = getConfig();
  const db = getDb(config);

  switch (action) {
    case "start": {
      const session = await startSession(db, {
        focusDocId: flags.focus as string | undefined,
      });
      console.log(`Session started: ${session.id}`);
      if (session.focusDocId) console.log(`Focus: ${session.focusDocId}`);
      break;
    }

    case "end": {
      const active = await getActiveSession(db);
      if (!active) {
        console.log("No active session.");
        return;
      }
      await endSession(db, active.id, flags.summary as string | undefined);
      const duration = Math.round((Date.now() - new Date(active.startedAt).getTime()) / 60000);
      console.log(`Session ended. Duration: ${duration} minutes`);
      break;
    }

    case "status":
    default: {
      const current = await getActiveSession(db);
      if (!current) {
        console.log("No active session.");
        return;
      }
      const duration = Math.round((Date.now() - new Date(current.startedAt).getTime()) / 60000);
      console.log(`\nActive session: ${current.id}`);
      console.log(`  Started:  ${formatDate(current.startedAt)}`);
      console.log(`  Duration: ${duration} minutes`);
      if (current.focusDocId) console.log(`  Focus:    ${current.focusDocId}`);
      break;
    }
  }
}

async function cmdTime(action: string, positional: string[], flags: Record<string, string | boolean>): Promise<void> {
  const config = getConfig();
  const db = getDb(config);

  switch (action) {
    case "start": {
      const docId = positional[0];
      if (!docId) {
        console.error("Usage: dokoro time start <doc-id> [--slot=N]");
        process.exit(1);
      }
      const entry = await startTimeEntry(db, docId, {
        terminalSlot: flags.slot ? parseInt(flags.slot as string) : undefined,
      });
      console.log(`Timer started for ${docId}`);
      if (entry.terminalSlot) console.log(`  Slot: ${entry.terminalSlot}`);
      break;
    }

    case "stop": {
      const entries = await getActiveTimeEntries(db);
      const docId = positional[0];
      const entry = docId ? entries.find((e) => e.docId === docId) : entries[0];

      if (!entry) {
        console.log("No active timer.");
        return;
      }

      const ended = await endTimeEntry(db, entry.id, flags.notes as string | undefined);
      console.log(`Timer stopped for ${ended?.docId}`);
      console.log(`  Duration: ${ended?.durationMin} minutes`);
      break;
    }

    case "status":
    default: {
      const entries = await getActiveTimeEntries(db);
      if (entries.length === 0) {
        console.log("No active timers.");
        return;
      }

      console.log("\nActive timers:\n");
      for (const entry of entries) {
        const minutes = Math.round((Date.now() - new Date(entry.startedAt).getTime()) / 60000);
        const slot = entry.terminalSlot ? `[Slot ${entry.terminalSlot}]` : "";
        console.log(`  ${slot.padEnd(10)} ${entry.doc.title.substring(0, 40).padEnd(42)} ${minutes}m`);
      }
      break;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// MAIN
// ═══════════════════════════════════════════════════════════════════════════

async function main(): Promise<void> {
  const { command, positional, flags } = parseArgs(process.argv.slice(2));

  if (flags.help || command === "help" || command === "--help" || command === "-h") {
    printHelp();
    return;
  }

  try {
    switch (command) {
      case "init":
        await cmdInit();
        break;

      case "migrate":
        await cmdMigrate(flags);
        break;

      case "search":
        await cmdSearch(positional.join(" "), flags);
        break;

      case "list":
      case "ls":
        await cmdList(flags);
        break;

      case "get":
      case "show":
        if (!positional[0]) {
          console.error("Usage: dokoro get <id>");
          process.exit(1);
        }
        await cmdGet(positional[0]);
        break;

      case "update":
        if (!positional[0]) {
          console.error("Usage: dokoro update <id> [--status=X] [--priority=X]");
          process.exit(1);
        }
        await cmdUpdate(positional[0], flags);
        break;

      case "tags":
        await cmdTags(flags);
        break;

      case "tag":
        if (positional.length < 2) {
          console.error("Usage: dokoro tag <doc-id> <tag-name>");
          process.exit(1);
        }
        await cmdTag(positional[0], positional[1]);
        break;

      case "browse": {
        // Lazy import: keep ink/react startup cost off every other command.
        const { runBrowse } = await import("./cli/browse-ui.js");
        // Explicit --path wins; otherwise reuse the CLI's dokoro-folder discovery.
        const config = getConfig();
        const dokoroPath =
          typeof flags.path === "string"
            ? path.resolve(flags.path)
            : path.join(config.projectPath, config.dokoroFolder ?? "dokoro");
        await runBrowse(dokoroPath);
        break;
      }

      case "session":
        await cmdSession(positional[0] || "status", flags);
        break;

      case "time":
        await cmdTime(positional[0] || "status", positional.slice(1), flags);
        break;

      case "cleanup": {
        // Import and run cleanup dynamically
        const { execSync } = await import("node:child_process");
        const config = getConfig();
        const cleanupArgs = flags["dry-run"] ? "--dry-run" : "--execute";
        const cmd = `npx tsx scripts/cleanup.ts --dokoro ${path.join(config.projectPath, config.dokoroFolder!)} ${cleanupArgs}`;
        execSync(cmd, { stdio: "inherit", cwd: path.dirname(import.meta.url.replace("file://", "")) });
        break;
      }

      default:
        console.error(`Unknown command: ${command}`);
        printHelp();
        process.exit(1);
    }
  } finally {
    closeAllDbs();
  }
}

main().catch((err) => {
  console.error("Error:", err.message);
  process.exit(1);
});
