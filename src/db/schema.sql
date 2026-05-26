-- ═══════════════════════════════════════════════════════════════════════════
-- DEVLOG-MCP 2.0 SQLite Schema
-- Per-Project Database (each project gets its own .devlog/db/devlog.sqlite)
-- ═══════════════════════════════════════════════════════════════════════════

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;
PRAGMA busy_timeout = 5000;

-- ═══════════════════════════════════════════════════════════════════════════
-- SCHEMA VERSION (for migrations)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER PRIMARY KEY,
  applied_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  description TEXT
);

INSERT INTO schema_version (version, description) VALUES (1, 'Initial schema - Devlog 2.0');

-- ═══════════════════════════════════════════════════════════════════════════
-- PROJECT METADATA
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS project (
  id TEXT PRIMARY KEY DEFAULT 'default',
  name TEXT NOT NULL,
  root_path TEXT NOT NULL,              -- Absolute path to project root
  devlog_path TEXT NOT NULL,            -- Relative path to devlog folder (usually 'devlog')
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  settings_json TEXT                    -- Project-specific settings
);

-- ═══════════════════════════════════════════════════════════════════════════
-- CORE DOCUMENTS TABLE (issues, PRDs, research, decisions unified)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS docs (
  id TEXT PRIMARY KEY,                  -- filename stem: 2025-01-26-field-bug
  filepath TEXT UNIQUE NOT NULL,        -- relative path from devlog root
  title TEXT NOT NULL,
  content TEXT,                         -- full markdown content for FTS
  doc_type TEXT NOT NULL DEFAULT 'issue', -- issue|prd|research|decision|note
  status TEXT NOT NULL DEFAULT 'inbox', -- inbox|active|backlog|done|archived
  prd_stage TEXT,                       -- idea|breakdown|improve|finalize (for PRDs)
  priority TEXT DEFAULT 'medium',       -- low|medium|high|urgent

  -- Time tracking
  time_estimated_min INTEGER,           -- estimated minutes
  time_actual_min INTEGER,              -- actual minutes (calculated from time_entries)
  parallel_slot INTEGER,                -- 1-5 terminal slot for multi-task

  -- Dates
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  due_at DATETIME,                      -- optional deadline
  completed_at DATETIME,                -- when status changed to done

  -- External links
  gh_issue INTEGER,                     -- GitHub issue number
  gh_pr INTEGER,                        -- GitHub PR number
  gh_repo TEXT,                         -- owner/repo format

  -- Embeddings
  embedding_id TEXT,                    -- Vector DB reference (ChromaDB/LanceDB)
  embedding_model TEXT,                 -- Model used for embedding
  embedding_updated_at DATETIME,        -- When embedding was last updated

  -- Flexible metadata (JSON for extensibility)
  metadata_json TEXT,                   -- {"custom_field": "value", ...}

  -- Content hash for change detection
  content_hash TEXT                     -- MD5/SHA256 of content for incremental updates
);

-- ═══════════════════════════════════════════════════════════════════════════
-- USERS/AUTHORS (supports human, AI, system - future multi-user ready)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,            -- 'user', 'claude', 'llm:qwen', 'john@example.com'
  display_name TEXT,                    -- Human-readable name
  type TEXT NOT NULL DEFAULT 'human',   -- human|ai|system
  email TEXT,                           -- for future multi-user
  avatar_url TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_active_at DATETIME,
  settings_json TEXT                    -- User preferences
);

-- Pre-populate with known authors
INSERT OR IGNORE INTO users (name, display_name, type) VALUES ('user', 'User', 'human');
INSERT OR IGNORE INTO users (name, display_name, type) VALUES ('claude', 'Claude', 'ai');
INSERT OR IGNORE INTO users (name, display_name, type) VALUES ('llm:qwen', 'Qwen', 'ai');
INSERT OR IGNORE INTO users (name, display_name, type) VALUES ('llm:llama', 'Llama', 'ai');
INSERT OR IGNORE INTO users (name, display_name, type) VALUES ('llm:grok', 'Grok', 'ai');
INSERT OR IGNORE INTO users (name, display_name, type) VALUES ('llm:gemini', 'Gemini', 'ai');
INSERT OR IGNORE INTO users (name, display_name, type) VALUES ('llm:gpt', 'GPT', 'ai');
INSERT OR IGNORE INTO users (name, display_name, type) VALUES ('system', 'System', 'system');

-- ═══════════════════════════════════════════════════════════════════════════
-- TAGS (normalized for efficient queries)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS tags (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT UNIQUE NOT NULL,            -- 'bug', 'api', 'urgent'
  color TEXT,                           -- Hex color for UI
  description TEXT,
  parent_id INTEGER REFERENCES tags(id), -- Hierarchical tags
  usage_count INTEGER DEFAULT 0,        -- Track popularity
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS doc_tags (
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  tag_id INTEGER NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  source TEXT DEFAULT 'manual',         -- manual|yaml|hashtag|filename|folder|ai
  confidence REAL DEFAULT 1.0,          -- AI-suggested tag confidence (0-1)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (doc_id, tag_id)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- FULL-TEXT SEARCH (FTS5)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE VIRTUAL TABLE IF NOT EXISTS docs_fts USING fts5(
  id,
  title,
  content,
  tags_text,                            -- denormalized: "bug api urgent"
  content='docs',
  content_rowid='rowid',
  tokenize='porter unicode61'
);

-- ═══════════════════════════════════════════════════════════════════════════
-- FTS SYNC TRIGGERS
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TRIGGER IF NOT EXISTS docs_ai AFTER INSERT ON docs BEGIN
  INSERT INTO docs_fts(rowid, id, title, content, tags_text)
  VALUES (
    new.rowid,
    new.id,
    new.title,
    new.content,
    (SELECT group_concat(t.name, ' ') FROM tags t
     JOIN doc_tags dt ON t.id = dt.tag_id
     WHERE dt.doc_id = new.id)
  );
END;

CREATE TRIGGER IF NOT EXISTS docs_ad AFTER DELETE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, id, title, content, tags_text)
  VALUES ('delete', old.rowid, old.id, old.title, old.content, NULL);
END;

CREATE TRIGGER IF NOT EXISTS docs_au AFTER UPDATE ON docs BEGIN
  INSERT INTO docs_fts(docs_fts, rowid, id, title, content, tags_text)
  VALUES ('delete', old.rowid, old.id, old.title, old.content, NULL);
  INSERT INTO docs_fts(rowid, id, title, content, tags_text)
  VALUES (
    new.rowid,
    new.id,
    new.title,
    new.content,
    (SELECT group_concat(t.name, ' ') FROM tags t
     JOIN doc_tags dt ON t.id = dt.tag_id
     WHERE dt.doc_id = new.id)
  );
END;

-- Trigger to update tags_text when doc_tags changes
CREATE TRIGGER IF NOT EXISTS doc_tags_ai AFTER INSERT ON doc_tags BEGIN
  UPDATE docs SET updated_at = CURRENT_TIMESTAMP WHERE id = new.doc_id;
END;

CREATE TRIGGER IF NOT EXISTS doc_tags_ad AFTER DELETE ON doc_tags BEGIN
  UPDATE docs SET updated_at = CURRENT_TIMESTAMP WHERE id = old.doc_id;
END;

-- ═══════════════════════════════════════════════════════════════════════════
-- TIME TRACKING
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS time_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  user_id INTEGER REFERENCES users(id),  -- who worked on it
  terminal_slot INTEGER,                  -- 1-5 parallel slots
  started_at DATETIME NOT NULL,
  ended_at DATETIME,
  duration_min INTEGER,                   -- Calculated: (ended_at - started_at) in minutes
  status TEXT NOT NULL DEFAULT 'active',  -- active|paused|completed
  interruptions INTEGER DEFAULT 0,        -- Pause/resume count
  notes TEXT,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════
-- ENTITY GRAPH (GraphRAG - knowledge graph for project)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS entities (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,                     -- project|person|concept|file|api|component|service
  name TEXT NOT NULL,
  canonical_name TEXT,                    -- Normalized name for matching
  description TEXT,
  metadata_json TEXT,                     -- Additional structured data
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(type, canonical_name)
);

CREATE TABLE IF NOT EXISTS doc_entities (
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  entity_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,            -- mentions|blocks|implements|uses|depends_on|related_to
  context TEXT,                           -- Surrounding text where entity was found
  confidence REAL DEFAULT 1.0,            -- Extraction confidence (0-1)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (doc_id, entity_id, relation_type)
);

-- Entity-to-entity relations (for knowledge graph)
-- Bi-temporal: valid_from/valid_to allow invalidating facts without deleting rows
-- (Zep/Graphiti pattern: set valid_to = now() instead of DELETE when a fact ends)
CREATE TABLE IF NOT EXISTS entity_relations (
  source_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  target_id INTEGER NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  relation_type TEXT NOT NULL,            -- depends_on|uses|implements|extends|related_to
  weight REAL DEFAULT 1.0,                -- Relation strength
  metadata_json TEXT,
  valid_from TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP, -- when the fact became true
  valid_to TEXT,                          -- when the fact stopped being true (NULL = still true)
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (source_id, target_id, relation_type)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- SESSIONS (replaces broken current.md - tracks work sessions)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS sessions (
  id TEXT PRIMARY KEY,                    -- UUID or timestamp-based
  user_id INTEGER REFERENCES users(id),
  started_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  ended_at DATETIME,
  status TEXT NOT NULL DEFAULT 'active',  -- active|paused|completed|abandoned
  focus_doc_id TEXT REFERENCES docs(id),  -- Current focus (optional)
  goals_json TEXT,                        -- Session goals [{goal, completed}]
  summary TEXT,                           -- AI-generated or manual summary
  notes TEXT,
  metadata_json TEXT                      -- Flexible session data
);

-- ═══════════════════════════════════════════════════════════════════════════
-- CONVERSATION MEMORY (AI conversation tracking)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS conversation_summaries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  ai_model TEXT NOT NULL,                 -- claude|gpt|qwen|etc
  summary TEXT NOT NULL,                  -- AI-generated conversation summary
  key_decisions_json TEXT,                -- [{decision, reasoning, outcome}]
  key_topics_json TEXT,                   -- ["topic1", "topic2"]
  linked_docs_json TEXT,                  -- [doc_id1, doc_id2] - docs discussed
  message_count INTEGER,                  -- Number of messages in conversation
  token_count INTEGER,                    -- Approximate tokens used
  started_at DATETIME NOT NULL,
  ended_at DATETIME,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════
-- CONTEXT RELEVANCE (for smart context loading)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS context_relevance (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
  related_doc_id TEXT REFERENCES docs(id) ON DELETE CASCADE,
  related_entity_id INTEGER REFERENCES entities(id) ON DELETE CASCADE,
  relevance_type TEXT NOT NULL,           -- semantic|temporal|structural|explicit
  score REAL NOT NULL,                    -- 0-1 relevance score
  computed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  expires_at DATETIME,                    -- When to recompute
  UNIQUE(doc_id, related_doc_id, relevance_type),
  UNIQUE(doc_id, related_entity_id, relevance_type)
);

-- ═══════════════════════════════════════════════════════════════════════════
-- AFFECTIVE MEMORY (agent feedback / success-failure history)
-- ═══════════════════════════════════════════════════════════════════════════

CREATE TABLE IF NOT EXISTS agent_feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id TEXT NOT NULL,                  -- model id, e.g. 'claude-opus-4-7'
  tool_name TEXT NOT NULL,                 -- MCP tool name, e.g. 'devlog_entity_extract_deep'
  outcome TEXT NOT NULL,                   -- 'success' | 'failure' | 'partial'
  confidence REAL DEFAULT 1.0,             -- calibration score (0-1)
  latency_ms INTEGER,                      -- wall-clock latency of the tool call
  error_message TEXT,                      -- error detail on failure
  doc_id TEXT REFERENCES docs(id) ON DELETE SET NULL,
  session_id TEXT REFERENCES sessions(id) ON DELETE SET NULL,
  metadata_json TEXT,                      -- extra structured data
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- ═══════════════════════════════════════════════════════════════════════════
-- INDEXES (optimized for common queries)
-- ═══════════════════════════════════════════════════════════════════════════

-- Docs: multi-field filtering
CREATE INDEX IF NOT EXISTS idx_docs_status ON docs(status);
CREATE INDEX IF NOT EXISTS idx_docs_type_status ON docs(doc_type, status);
CREATE INDEX IF NOT EXISTS idx_docs_prd_stage ON docs(prd_stage) WHERE prd_stage IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_docs_priority ON docs(priority);
CREATE INDEX IF NOT EXISTS idx_docs_dates ON docs(created_at, updated_at);
CREATE INDEX IF NOT EXISTS idx_docs_due ON docs(due_at) WHERE due_at IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_docs_slot ON docs(parallel_slot) WHERE parallel_slot IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_docs_gh ON docs(gh_issue) WHERE gh_issue IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_docs_content_hash ON docs(content_hash);

-- Tags: fast tag lookups
CREATE INDEX IF NOT EXISTS idx_tags_name ON tags(name);
CREATE INDEX IF NOT EXISTS idx_doc_tags_tag ON doc_tags(tag_id);
CREATE INDEX IF NOT EXISTS idx_doc_tags_doc ON doc_tags(doc_id);

-- Time: daily queries
CREATE INDEX IF NOT EXISTS idx_time_doc ON time_entries(doc_id);
CREATE INDEX IF NOT EXISTS idx_time_date ON time_entries(date(started_at));
CREATE INDEX IF NOT EXISTS idx_time_user ON time_entries(user_id);
CREATE INDEX IF NOT EXISTS idx_time_slot ON time_entries(terminal_slot);
CREATE INDEX IF NOT EXISTS idx_time_status ON time_entries(status);

-- Entities: graph queries
CREATE INDEX IF NOT EXISTS idx_entity_type ON entities(type);
CREATE INDEX IF NOT EXISTS idx_entity_canonical ON entities(canonical_name);
CREATE INDEX IF NOT EXISTS idx_doc_entity_doc ON doc_entities(doc_id);
CREATE INDEX IF NOT EXISTS idx_doc_entity_entity ON doc_entities(entity_id);
CREATE INDEX IF NOT EXISTS idx_entity_rel_source ON entity_relations(source_id);
CREATE INDEX IF NOT EXISTS idx_entity_rel_target ON entity_relations(target_id);
CREATE INDEX IF NOT EXISTS idx_entity_rel_valid_to ON entity_relations(valid_to);

-- Sessions
CREATE INDEX IF NOT EXISTS idx_session_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS idx_session_status ON sessions(status);
CREATE INDEX IF NOT EXISTS idx_session_dates ON sessions(started_at, ended_at);

-- Conversation memory
CREATE INDEX IF NOT EXISTS idx_conv_session ON conversation_summaries(session_id);
CREATE INDEX IF NOT EXISTS idx_conv_model ON conversation_summaries(ai_model);
CREATE INDEX IF NOT EXISTS idx_conv_dates ON conversation_summaries(started_at, ended_at);

-- Context relevance
CREATE INDEX IF NOT EXISTS idx_relevance_doc ON context_relevance(doc_id);
CREATE INDEX IF NOT EXISTS idx_relevance_score ON context_relevance(score DESC);

-- Agent feedback (affective memory)
CREATE INDEX IF NOT EXISTS idx_feedback_tool ON agent_feedback(tool_name);
CREATE INDEX IF NOT EXISTS idx_feedback_agent ON agent_feedback(agent_id);
CREATE INDEX IF NOT EXISTS idx_feedback_outcome ON agent_feedback(outcome);
CREATE INDEX IF NOT EXISTS idx_feedback_session ON agent_feedback(session_id);
CREATE INDEX IF NOT EXISTS idx_feedback_recorded ON agent_feedback(recorded_at);
CREATE INDEX IF NOT EXISTS idx_feedback_agent_tool_time ON agent_feedback(agent_id, tool_name, recorded_at);

-- ═══════════════════════════════════════════════════════════════════════════
-- VIEWS (common queries as views for convenience)
-- ═══════════════════════════════════════════════════════════════════════════

-- Active tasks with time tracking
CREATE VIEW IF NOT EXISTS v_active_tasks AS
SELECT
  d.*,
  GROUP_CONCAT(DISTINCT t.name) as tags,
  (SELECT SUM(duration_min) FROM time_entries te WHERE te.doc_id = d.id) as total_time_min,
  (SELECT COUNT(*) FROM time_entries te WHERE te.doc_id = d.id AND te.status = 'active') as active_sessions
FROM docs d
LEFT JOIN doc_tags dt ON d.id = dt.doc_id
LEFT JOIN tags t ON dt.tag_id = t.id
WHERE d.status = 'active'
GROUP BY d.id;

-- Today's timeline
CREATE VIEW IF NOT EXISTS v_today_timeline AS
SELECT
  te.*,
  d.title,
  d.doc_type,
  d.priority,
  u.name as user_name
FROM time_entries te
JOIN docs d ON te.doc_id = d.id
LEFT JOIN users u ON te.user_id = u.id
WHERE date(te.started_at) = date('now')
ORDER BY te.started_at;

-- PRD workflow status
CREATE VIEW IF NOT EXISTS v_prd_status AS
SELECT
  prd_stage,
  COUNT(*) as count,
  GROUP_CONCAT(id) as doc_ids
FROM docs
WHERE doc_type = 'prd'
GROUP BY prd_stage;
