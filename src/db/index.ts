/**
 * Devlog-MCP 2.0 Database Module
 *
 * Per-project SQLite database with Drizzle ORM
 * Each project gets its own .devlog/db/devlog.sqlite file
 */

import Database from "better-sqlite3";
import { drizzle, BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { sql, eq, and, like, desc, asc, or, inArray } from "drizzle-orm";
import * as path from "node:path";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import * as schema from "./schema.js";
import { ensureAgentFeedbackTable } from "./agent-feedback.js";
import { ensureEntityTables } from "./entity-tables.js";
import { dropDeadTables } from "./drop-dead-tables.js";
import { runMigrations } from "./migrations.js";

export { ensureAgentFeedbackTable };
export { ensureEntityTables };

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export type DevlogDB = BetterSQLite3Database<typeof schema>;

export interface DevlogDbConfig {
  projectPath: string; // Root path of the project
  devlogFolder?: string; // Default: 'devlog'
  dbName?: string; // Default: 'devlog.sqlite'
}

export interface DocCreateInput {
  id: string;
  filepath: string;
  title: string;
  content?: string;
  docType?: string;
  status?: string;
  prdStage?: string;
  priority?: string;
  timeEstimatedMin?: number;
  dueAt?: string;
  ghIssue?: number;
  ghPr?: number;
  ghRepo?: string;
  metadataJson?: string;
  tags?: string[];
}

export interface DocUpdateInput {
  title?: string;
  content?: string;
  docType?: string;
  status?: string;
  prdStage?: string;
  priority?: string;
  timeEstimatedMin?: number;
  timeActualMin?: number;
  parallelSlot?: number;
  dueAt?: string;
  completedAt?: string;
  ghIssue?: number;
  ghPr?: number;
  ghRepo?: string;
  metadataJson?: string;
}

export interface SearchOptions {
  query?: string;
  status?: string | string[];
  docType?: string | string[];
  tags?: string[];
  prdStage?: string;
  priority?: string;
  limit?: number;
  offset?: number;
  orderBy?: "created" | "updated" | "title" | "priority";
  orderDir?: "asc" | "desc";
}

export interface SectionTagInput {
  docId: string;
  sectionHeader: string;
  sectionLevel: number;
  tagName: string;
  lineNumber?: number;
  content?: string;
  source?: string;
}

// ═══════════════════════════════════════════════════════════════════════════
// DATABASE CONNECTION
// ═══════════════════════════════════════════════════════════════════════════

const dbConnections = new Map<string, { db: DevlogDB; sqlite: Database.Database }>();

/**
 * Get or create a database connection for a project
 */
export function getDb(config: DevlogDbConfig): DevlogDB {
  const dbPath = getDbPath(config);

  if (dbConnections.has(dbPath)) {
    return dbConnections.get(dbPath)!.db;
  }

  // Ensure directory exists
  const dbDir = path.dirname(dbPath);
  if (!fs.existsSync(dbDir)) {
    fs.mkdirSync(dbDir, { recursive: true });
  }

  // Create SQLite connection
  const sqlite = new Database(dbPath);

  // Enable WAL mode for better concurrency
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  sqlite.pragma("busy_timeout = 5000");

  // Create Drizzle instance
  const db = drizzle(sqlite, { schema });

  // Initialize schema if needed
  initializeSchema(db, sqlite);

  // Ensure vector tables exist
  ensureVectorTables(sqlite);

  // Run version-gated migrations (entity graph + agent feedback tables, etc.).
  // Migration v1 runs ensureEntityTables + ensureAgentFeedbackTable and bumps
  // schema_version, so the schema version row is now kept up to date (BUG-5).
  runMigrations(sqlite);

  // Drop tables that were defined in the original schema but never used in
  // production code. Idempotent — safe to run on every startup.
  dropDeadTables(sqlite);

  // Cache connection
  dbConnections.set(dbPath, { db, sqlite });

  return db;
}

/**
 * Get raw better-sqlite3 handle for a project (used by vector services)
 */
export function getSqliteDb(config: DevlogDbConfig): Database.Database {
  const dbPath = getDbPath(config);

  // If already cached, return the raw sqlite handle
  if (dbConnections.has(dbPath)) {
    const sqlite = dbConnections.get(dbPath)!.sqlite;
    // foreign_keys is a per-connection PRAGMA; re-assert it on every handout so
    // raw-handle callers can never operate with FK enforcement OFF (BUG-13).
    sqlite.pragma("foreign_keys = ON");
    return sqlite;
  }

  // Initialize via getDb (which caches both drizzle + sqlite)
  getDb(config);
  const sqlite = dbConnections.get(dbPath)!.sqlite;
  sqlite.pragma("foreign_keys = ON");
  return sqlite;
}

/**
 * Ensure vector search tables exist (idempotent)
 */
export function ensureVectorTables(sqlite: Database.Database): void {
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS doc_vectors (
      doc_id TEXT PRIMARY KEY,
      content_hash TEXT NOT NULL,
      token_count INTEGER,
      chunk_count INTEGER DEFAULT 1,
      last_indexed TEXT NOT NULL,
      FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS chunks (
      chunk_id TEXT PRIMARY KEY,
      doc_id TEXT NOT NULL,
      chunk_index INTEGER NOT NULL,
      start_line INTEGER NOT NULL,
      end_line INTEGER NOT NULL,
      start_char INTEGER NOT NULL,
      end_char INTEGER NOT NULL,
      header_context TEXT,
      token_count INTEGER,
      FOREIGN KEY (doc_id) REFERENCES docs(id) ON DELETE CASCADE
    );
  `);
}

/**
 * Close a database connection
 */
export function closeDb(config: DevlogDbConfig): void {
  const dbPath = getDbPath(config);
  const conn = dbConnections.get(dbPath);

  if (conn) {
    conn.sqlite.close();
    dbConnections.delete(dbPath);
  }
}

/**
 * Close all database connections
 */
export function closeAllDbs(): void {
  for (const [, conn] of dbConnections) {
    conn.sqlite.close();
  }
  dbConnections.clear();
}

function getDbPath(config: DevlogDbConfig): string {
  const devlogFolder = config.devlogFolder || "devlog";
  const dbName = config.dbName || "devlog.sqlite";
  return path.join(config.projectPath, devlogFolder, ".devlog", "db", dbName);
}

// ═══════════════════════════════════════════════════════════════════════════
// SCHEMA INITIALIZATION
// ═══════════════════════════════════════════════════════════════════════════

function initializeSchema(_db: DevlogDB, sqlite: Database.Database): void {
  // Check if schema version table exists
  const tableExists = sqlite
    .prepare(
      `SELECT name FROM sqlite_master WHERE type='table' AND name='schema_version'`
    )
    .get();

  if (!tableExists) {
    // Read and execute the raw SQL schema
    const schemaPath = path.join(__dirname, "schema.sql");
    if (fs.existsSync(schemaPath)) {
      const schemaSql = fs.readFileSync(schemaPath, "utf-8");
      sqlite.exec(schemaSql);
    } else {
      // Fallback: create tables using Drizzle (less ideal but works)
      createTablesManually(sqlite);
    }
  }
}

function createTablesManually(sqlite: Database.Database): void {
  // Create essential tables manually if schema.sql is not found
  sqlite.exec(`
    CREATE TABLE IF NOT EXISTS schema_version (
      version INTEGER PRIMARY KEY,
      applied_at TEXT DEFAULT CURRENT_TIMESTAMP,
      description TEXT
    );

    INSERT OR IGNORE INTO schema_version (version, description) VALUES (1, 'Initial schema');

    CREATE TABLE IF NOT EXISTS project (
      id TEXT PRIMARY KEY DEFAULT 'default',
      name TEXT NOT NULL,
      root_path TEXT NOT NULL,
      devlog_path TEXT NOT NULL,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
      settings_json TEXT
    );

    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      display_name TEXT,
      type TEXT NOT NULL DEFAULT 'human',
      email TEXT,
      avatar_url TEXT,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      last_active_at TEXT,
      settings_json TEXT
    );

    INSERT OR IGNORE INTO users (name, display_name, type) VALUES ('user', 'User', 'human');
    INSERT OR IGNORE INTO users (name, display_name, type) VALUES ('claude', 'Claude', 'ai');
    INSERT OR IGNORE INTO users (name, display_name, type) VALUES ('system', 'System', 'system');

    CREATE TABLE IF NOT EXISTS docs (
      id TEXT PRIMARY KEY,
      filepath TEXT UNIQUE NOT NULL,
      title TEXT NOT NULL,
      content TEXT,
      doc_type TEXT NOT NULL DEFAULT 'issue',
      status TEXT NOT NULL DEFAULT 'inbox',
      prd_stage TEXT,
      priority TEXT DEFAULT 'medium',
      time_estimated_min INTEGER,
      time_actual_min INTEGER,
      parallel_slot INTEGER,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      due_at TEXT,
      completed_at TEXT,
      gh_issue INTEGER,
      gh_pr INTEGER,
      gh_repo TEXT,
      embedding_id TEXT,
      embedding_model TEXT,
      embedding_updated_at TEXT,
      metadata_json TEXT,
      content_hash TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_docs_status ON docs(status);
    CREATE INDEX IF NOT EXISTS idx_docs_type_status ON docs(doc_type, status);

    CREATE TABLE IF NOT EXISTS tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT UNIQUE NOT NULL,
      color TEXT,
      description TEXT,
      parent_id INTEGER REFERENCES tags(id),
      usage_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS doc_tags (
      doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      source TEXT DEFAULT 'manual',
      confidence REAL DEFAULT 1.0,
      created_at TEXT DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (doc_id, tag_id)
    );

    CREATE TABLE IF NOT EXISTS section_tags (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
      section_header TEXT NOT NULL,
      section_level INTEGER NOT NULL,
      tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
      line_number INTEGER,
      content TEXT,
      source TEXT DEFAULT 'comment',
      created_at TEXT DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      user_id INTEGER REFERENCES users(id),
      started_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      focus_doc_id TEXT REFERENCES docs(id),
      goals_json TEXT,
      summary TEXT,
      notes TEXT,
      metadata_json TEXT
    );
  `);
}

// ═══════════════════════════════════════════════════════════════════════════
// DOCUMENT OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Create a new document
 */
export async function createDoc(db: DevlogDB, input: DocCreateInput): Promise<typeof schema.docs.$inferSelect> {
  const contentHash = input.content ? crypto.createHash("md5").update(input.content).digest("hex") : null;

  const [doc] = await db
    .insert(schema.docs)
    .values({
      id: input.id,
      filepath: input.filepath,
      title: input.title,
      content: input.content,
      docType: input.docType || "issue",
      status: input.status || "inbox",
      prdStage: input.prdStage,
      priority: input.priority || "medium",
      timeEstimatedMin: input.timeEstimatedMin,
      dueAt: input.dueAt,
      ghIssue: input.ghIssue,
      ghPr: input.ghPr,
      ghRepo: input.ghRepo,
      metadataJson: input.metadataJson,
      contentHash,
    })
    .returning();

  // Add tags if provided
  if (input.tags && input.tags.length > 0) {
    await addTagsToDoc(db, input.id, input.tags);
  }

  return doc;
}

/**
 * Update a document
 */
export async function updateDoc(
  db: DevlogDB,
  docId: string,
  input: DocUpdateInput
): Promise<typeof schema.docs.$inferSelect | null> {
  const updateData: Record<string, unknown> = {
    ...input,
    updatedAt: new Date().toISOString(),
  };

  if (input.content) {
    updateData.contentHash = crypto.createHash("md5").update(input.content).digest("hex");
  }

  const [doc] = await db.update(schema.docs).set(updateData).where(eq(schema.docs.id, docId)).returning();

  return doc || null;
}

/**
 * Get a document by ID
 */
export async function getDoc(db: DevlogDB, docId: string): Promise<typeof schema.docs.$inferSelect | null> {
  const [doc] = await db.select().from(schema.docs).where(eq(schema.docs.id, docId)).limit(1);
  return doc || null;
}

/**
 * Delete a document
 */
export async function deleteDoc(db: DevlogDB, docId: string): Promise<boolean> {
  await db.delete(schema.docs).where(eq(schema.docs.id, docId));
  return true;
}

/**
 * Search documents
 */
export async function searchDocs(
  db: DevlogDB,
  options: SearchOptions
): Promise<Array<typeof schema.docs.$inferSelect>> {
  let query = db.select().from(schema.docs).$dynamic();

  const conditions: ReturnType<typeof eq>[] = [];

  // Status filter
  if (options.status) {
    if (Array.isArray(options.status)) {
      conditions.push(inArray(schema.docs.status, options.status));
    } else {
      conditions.push(eq(schema.docs.status, options.status));
    }
  }

  // Doc type filter
  if (options.docType) {
    if (Array.isArray(options.docType)) {
      conditions.push(inArray(schema.docs.docType, options.docType));
    } else {
      conditions.push(eq(schema.docs.docType, options.docType));
    }
  }

  // PRD stage filter
  if (options.prdStage) {
    conditions.push(eq(schema.docs.prdStage, options.prdStage));
  }

  // Priority filter
  if (options.priority) {
    conditions.push(eq(schema.docs.priority, options.priority));
  }

  // Text search (simple LIKE for now, FTS5 can be added later)
  if (options.query) {
    const searchPattern = `%${options.query}%`;
    conditions.push(
      or(like(schema.docs.title, searchPattern), like(schema.docs.content, searchPattern)) as ReturnType<typeof eq>
    );
  }

  if (conditions.length > 0) {
    query = query.where(and(...conditions));
  }

  // Ordering
  const orderDir = options.orderDir === "asc" ? asc : desc;
  switch (options.orderBy) {
    case "title":
      query = query.orderBy(orderDir(schema.docs.title));
      break;
    case "updated":
      query = query.orderBy(orderDir(schema.docs.updatedAt));
      break;
    case "priority":
      query = query.orderBy(orderDir(schema.docs.priority));
      break;
    default:
      query = query.orderBy(orderDir(schema.docs.createdAt));
  }

  // Pagination
  if (options.limit) {
    query = query.limit(options.limit);
  }
  if (options.offset) {
    query = query.offset(options.offset);
  }

  return query;
}

// ═══════════════════════════════════════════════════════════════════════════
// TAG OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get or create a tag by name
 */
export async function getOrCreateTag(
  db: DevlogDB,
  name: string,
  options?: { color?: string; description?: string }
): Promise<typeof schema.tags.$inferSelect> {
  const normalizedName = name.toLowerCase().trim();

  // Try to find existing tag
  const [existing] = await db.select().from(schema.tags).where(eq(schema.tags.name, normalizedName)).limit(1);

  if (existing) {
    return existing;
  }

  // Create new tag
  const [tag] = await db
    .insert(schema.tags)
    .values({
      name: normalizedName,
      color: options?.color,
      description: options?.description,
    })
    .returning();

  return tag;
}

/**
 * Add tags to a document
 */
export async function addTagsToDoc(
  db: DevlogDB,
  docId: string,
  tagNames: string[],
  source: string = "manual"
): Promise<void> {
  for (const tagName of tagNames) {
    const tag = await getOrCreateTag(db, tagName);

    await db
      .insert(schema.docTags)
      .values({
        docId,
        tagId: tag.id,
        source,
      })
      .onConflictDoNothing();

    // Update usage count
    await db
      .update(schema.tags)
      .set({ usageCount: sql`${schema.tags.usageCount} + 1` })
      .where(eq(schema.tags.id, tag.id));
  }
}

/**
 * Remove tags from a document
 */
export async function removeTagsFromDoc(db: DevlogDB, docId: string, tagNames: string[]): Promise<void> {
  for (const tagName of tagNames) {
    const normalizedName = tagName.toLowerCase().trim();
    const [tag] = await db.select().from(schema.tags).where(eq(schema.tags.name, normalizedName)).limit(1);

    if (tag) {
      await db.delete(schema.docTags).where(and(eq(schema.docTags.docId, docId), eq(schema.docTags.tagId, tag.id)));

      // Update usage count
      await db
        .update(schema.tags)
        .set({ usageCount: sql`MAX(0, ${schema.tags.usageCount} - 1)` })
        .where(eq(schema.tags.id, tag.id));
    }
  }
}

/**
 * Get tags for a document
 */
export async function getDocTags(db: DevlogDB, docId: string): Promise<Array<typeof schema.tags.$inferSelect>> {
  const results = await db
    .select({ tag: schema.tags })
    .from(schema.docTags)
    .innerJoin(schema.tags, eq(schema.docTags.tagId, schema.tags.id))
    .where(eq(schema.docTags.docId, docId));

  return results.map((r) => r.tag);
}

/**
 * Get all tags
 */
export async function getAllTags(db: DevlogDB): Promise<Array<typeof schema.tags.$inferSelect>> {
  return db.select().from(schema.tags).orderBy(desc(schema.tags.usageCount));
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION TAG OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Add a tag to a section within a document
 */
export async function addSectionTag(db: DevlogDB, input: SectionTagInput): Promise<void> {
  const tag = await getOrCreateTag(db, input.tagName);

  await db.insert(schema.sectionTags).values({
    docId: input.docId,
    sectionHeader: input.sectionHeader,
    sectionLevel: input.sectionLevel,
    tagId: tag.id,
    lineNumber: input.lineNumber,
    content: input.content,
    source: input.source || "comment",
  });
}

/**
 * Get section tags for a document
 */
export async function getDocSectionTags(
  db: DevlogDB,
  docId: string
): Promise<Array<{ section: typeof schema.sectionTags.$inferSelect; tag: typeof schema.tags.$inferSelect }>> {
  const results = await db
    .select({
      section: schema.sectionTags,
      tag: schema.tags,
    })
    .from(schema.sectionTags)
    .innerJoin(schema.tags, eq(schema.sectionTags.tagId, schema.tags.id))
    .where(eq(schema.sectionTags.docId, docId));

  return results;
}

/**
 * Find all sections with a specific tag across all documents
 */
export async function findSectionsByTag(
  db: DevlogDB,
  tagName: string
): Promise<
  Array<{
    doc: typeof schema.docs.$inferSelect;
    section: typeof schema.sectionTags.$inferSelect;
  }>
> {
  const normalizedName = tagName.toLowerCase().trim();

  const results = await db
    .select({
      doc: schema.docs,
      section: schema.sectionTags,
    })
    .from(schema.sectionTags)
    .innerJoin(schema.tags, eq(schema.sectionTags.tagId, schema.tags.id))
    .innerJoin(schema.docs, eq(schema.sectionTags.docId, schema.docs.id))
    .where(eq(schema.tags.name, normalizedName));

  return results;
}

// ═══════════════════════════════════════════════════════════════════════════
// SESSION OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Start a new session
 */
export async function startSession(
  db: DevlogDB,
  options?: {
    userId?: number;
    focusDocId?: string;
    goals?: string[];
  }
): Promise<typeof schema.sessions.$inferSelect> {
  const sessionId = `session-${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;

  const [session] = await db
    .insert(schema.sessions)
    .values({
      id: sessionId,
      userId: options?.userId,
      focusDocId: options?.focusDocId,
      goalsJson: options?.goals ? JSON.stringify(options.goals) : null,
      status: "active",
    })
    .returning();

  return session;
}

/**
 * End a session
 */
export async function endSession(
  db: DevlogDB,
  sessionId: string,
  summary?: string
): Promise<typeof schema.sessions.$inferSelect | null> {
  const [session] = await db
    .update(schema.sessions)
    .set({
      status: "completed",
      endedAt: new Date().toISOString(),
      summary,
    })
    .where(eq(schema.sessions.id, sessionId))
    .returning();

  return session || null;
}

/**
 * Get active session
 */
export async function getActiveSession(db: DevlogDB): Promise<typeof schema.sessions.$inferSelect | null> {
  const [session] = await db
    .select()
    .from(schema.sessions)
    .where(eq(schema.sessions.status, "active"))
    .orderBy(desc(schema.sessions.startedAt))
    .limit(1);

  return session || null;
}

// ═══════════════════════════════════════════════════════════════════════════
// TIME TRACKING OPERATIONS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Start time tracking for a document
 */
export async function startTimeEntry(
  db: DevlogDB,
  docId: string,
  options?: {
    userId?: number;
    terminalSlot?: number;
  }
): Promise<typeof schema.timeEntries.$inferSelect> {
  const [entry] = await db
    .insert(schema.timeEntries)
    .values({
      docId,
      userId: options?.userId,
      terminalSlot: options?.terminalSlot,
      startedAt: new Date().toISOString(),
      status: "active",
    })
    .returning();

  // Update doc parallel slot
  if (options?.terminalSlot) {
    await db.update(schema.docs).set({ parallelSlot: options.terminalSlot }).where(eq(schema.docs.id, docId));
  }

  return entry;
}

/**
 * End time tracking for a document
 */
export async function endTimeEntry(
  db: DevlogDB,
  entryId: number,
  notes?: string
): Promise<typeof schema.timeEntries.$inferSelect | null> {
  const [existing] = await db.select().from(schema.timeEntries).where(eq(schema.timeEntries.id, entryId)).limit(1);

  if (!existing) return null;

  const endedAt = new Date();
  const startedAt = new Date(existing.startedAt);
  const durationMin = Math.round((endedAt.getTime() - startedAt.getTime()) / 60000);

  const [entry] = await db
    .update(schema.timeEntries)
    .set({
      status: "completed",
      endedAt: endedAt.toISOString(),
      durationMin,
      notes,
    })
    .where(eq(schema.timeEntries.id, entryId))
    .returning();

  // Update doc total time
  if (entry) {
    const totalTime = await db
      .select({ total: sql<number>`SUM(duration_min)` })
      .from(schema.timeEntries)
      .where(and(eq(schema.timeEntries.docId, entry.docId), eq(schema.timeEntries.status, "completed")));

    if (totalTime[0]?.total) {
      await db.update(schema.docs).set({ timeActualMin: totalTime[0].total }).where(eq(schema.docs.id, entry.docId));
    }
  }

  return entry || null;
}

/**
 * Get active time entries
 */
export async function getActiveTimeEntries(
  db: DevlogDB
): Promise<Array<typeof schema.timeEntries.$inferSelect & { doc: typeof schema.docs.$inferSelect }>> {
  const results = await db
    .select({
      entry: schema.timeEntries,
      doc: schema.docs,
    })
    .from(schema.timeEntries)
    .innerJoin(schema.docs, eq(schema.timeEntries.docId, schema.docs.id))
    .where(eq(schema.timeEntries.status, "active"));

  return results.map((r) => ({ ...r.entry, doc: r.doc }));
}

// ═══════════════════════════════════════════════════════════════════════════
// EXPORT SCHEMA FOR USE ELSEWHERE
// ═══════════════════════════════════════════════════════════════════════════

export * from "./schema.js";
