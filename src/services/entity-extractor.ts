import Database from 'better-sqlite3';

/**
 * EntityExtractor — regex-based entity extraction with span merging
 *
 * Extracts 6 entity types from text: person, project, file, service,
 * component, concept. Handles code fence skipping, overlapping span
 * resolution via type precedence, and canonical name normalization
 * for deduplication against the entities table.
 */

// ═══════════════════════════════════════════════════════════════════════════
// Types
// ═══════════════════════════════════════════════════════════════════════════

export type EntityType = 'person' | 'project' | 'file' | 'service' | 'component' | 'concept';

export type RelationType = 'mentions' | 'implements' | 'depends_on' | 'blocks' | 'authored_by';

export interface ExtractedEntity {
  type: EntityType;
  name: string;
  canonicalName: string;
  confidence: number;
  start: number;
  end: number;
  context: string;
}

export interface ExtractedRelation {
  relationType: RelationType;
  sourceCanonical: string;
  sourceType: EntityType;
  targetCanonical: string;
  targetType: EntityType;
  confidence: number;
  evidence: string;
}

interface RawSpan {
  type: EntityType;
  name: string;
  start: number;
  end: number;
  confidence: number;
}

interface CodeFenceRange {
  start: number;
  end: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// Constants
// ═══════════════════════════════════════════════════════════════════════════

/** Higher number = higher priority when spans overlap */
const TYPE_PRECEDENCE: Record<EntityType, number> = {
  file: 6,
  project: 5,
  service: 4,
  person: 3,
  component: 2,
  concept: 1,
};

const COMPONENT_STOPLIST = new Set([
  'string', 'object', 'array', 'number', 'boolean', 'null', 'undefined',
  'function', 'class', 'interface', 'type', 'enum', 'const', 'let', 'var',
  'import', 'export', 'default', 'return', 'async', 'await', 'promise',
  'error', 'date', 'map', 'set', 'json', 'buffer', 'event', 'node',
  'true', 'false', 'this', 'super', 'new', 'delete', 'typeof', 'void',
  'try', 'catch', 'finally', 'throw', 'if', 'else', 'switch', 'case',
  'for', 'while', 'do', 'break', 'continue', 'with', 'yield',
]);

const COMMON_DIR_PREFIXES = new Set([
  'src', 'lib', 'dist', 'test', 'tests', 'config', 'scripts',
  'docs', 'bin', 'build', 'public', 'assets', 'node_modules', 'packages',
]);

const SERVICE_GAZETTEER = new Set([
  'redis', 'postgres', 'postgresql', 'mysql', 'mongodb', 'mongo',
  'elasticsearch', 'kafka', 'rabbitmq', 'nginx', 'docker', 'kubernetes', 'k8s',
  'aws', 'gcp', 'azure', 'cloudflare', 's3', 'dynamodb', 'sqlite',
  'lancedb', 'chromadb', 'pinecone', 'weaviate', 'qdrant',
  'ollama', 'openai', 'anthropic',
  'github', 'gitlab', 'vercel', 'supabase', 'firebase',
  'stripe', 'twilio', 'sendgrid',
  'datadog', 'grafana', 'prometheus', 'sentry',
  'terraform', 'pulumi',
]);

// ═══════════════════════════════════════════════════════════════════════════
// EntityExtractor
// ═══════════════════════════════════════════════════════════════════════════

export class EntityExtractor {
  /**
   * Extract all entities from the given text.
   *
   * Pipeline: run 6 extractors -> filter code fences -> merge overlapping
   * spans -> deduplicate by canonical name -> attach context snippets.
   */
  extractEntities(text: string): ExtractedEntity[] {
    const codeFences = this.findCodeFenceRanges(text);

    // Run all 6 extractors
    const rawSpans: RawSpan[] = [
      ...this.extractPersons(text),
      ...this.extractFiles(text),
      ...this.extractProjects(text),
      ...this.extractServices(text),
      ...this.extractComponents(text),
      ...this.extractConcepts(text),
    ];

    // Filter spans inside code fences
    const filtered = rawSpans.filter(span => !this.isInsideCodeFence(span, codeFences));

    // Merge overlapping spans (higher precedence wins)
    const merged = this.mergeSpans(filtered);

    // Deduplicate by (type, canonicalName)
    const deduped = this.deduplicateEntities(merged);

    // Attach context snippets and return
    return deduped.map(span => ({
      type: span.type,
      name: span.name,
      canonicalName: this.canonicalize(span.name, span.type),
      confidence: span.confidence,
      start: span.start,
      end: span.end,
      context: text.slice(Math.max(0, span.start - 40), span.end + 40),
    }));
  }

  /**
   * Normalize a raw entity name to its canonical form for dedup.
   *
   * - file: strip leading './', lowercase
   * - project: lowercase
   * - person: strip '@', lowercase
   * - concept: strip '#', lowercase
   * - default (component, service): lowercase
   */
  canonicalize(name: string, type: EntityType): string {
    switch (type) {
      case 'file':
        return name.replace(/^\.\//, '').toLowerCase();
      case 'project':
        return name.toLowerCase();
      case 'person':
        return name.replace(/^@/, '').toLowerCase();
      case 'concept':
        return name.replace(/^#/, '').toLowerCase();
      default:
        return name.toLowerCase();
    }
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Code fence detection
  // ═════════════════════════════════════════════════════════════════════════

  private findCodeFenceRanges(text: string): CodeFenceRange[] {
    const ranges: CodeFenceRange[] = [];
    const re = /```[\s\S]*?```/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
    return ranges;
  }

  private isInsideCodeFence(span: RawSpan, fences: CodeFenceRange[]): boolean {
    return fences.some(f => span.start >= f.start && span.end <= f.end);
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Individual extractors
  // ═════════════════════════════════════════════════════════════════════════

  private extractPersons(text: string): RawSpan[] {
    const spans: RawSpan[] = [];

    // @username mentions
    const atRe = /@([a-zA-Z][\w-]{1,38})\b/g;
    let match: RegExpExecArray | null;
    while ((match = atRe.exec(text)) !== null) {
      spans.push({
        type: 'person',
        name: match[0],
        start: match.index,
        end: match.index + match[0].length,
        confidence: 0.85,
      });
    }

    // "by/from/with Name Name" pattern
    const namedRe = /\b(?:by|from|with)\s+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)?)\b/g;
    while ((match = namedRe.exec(text)) !== null) {
      const nameStart = match.index + match[0].length - match[1].length;
      spans.push({
        type: 'person',
        name: match[1],
        start: nameStart,
        end: nameStart + match[1].length,
        confidence: 0.7,
      });
    }

    return spans;
  }

  private extractFiles(text: string): RawSpan[] {
    const spans: RawSpan[] = [];

    // File paths: optional ./ or ../ prefix, at least one dir segment, file extension
    const fileRe = /(?:\.\.?\/)?(?:[\w@.-]+\/)+[\w.-]+\.[\w]+/g;
    let match: RegExpExecArray | null;
    while ((match = fileRe.exec(text)) !== null) {
      spans.push({
        type: 'file',
        name: match[0],
        start: match.index,
        end: match.index + match[0].length,
        confidence: 0.85,
      });
    }

    // import/require relative paths
    const importRe = /(?:from|require\()\s*['"](\.[^'"]+)['"]/g;
    while ((match = importRe.exec(text)) !== null) {
      const pathStart = match.index + match[0].lastIndexOf(match[1]);
      spans.push({
        type: 'file',
        name: match[1],
        start: pathStart,
        end: pathStart + match[1].length,
        confidence: 0.85,
      });
    }

    return spans;
  }

  private extractProjects(text: string): RawSpan[] {
    const spans: RawSpan[] = [];
    const re = /\b([a-zA-Z][\w.-]*\/[a-zA-Z][\w.-]*)\b/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const value = match[1];
      // Only if exactly 2 segments (one slash), and no file extension
      const segments = value.split('/');
      if (segments.length !== 2) continue;
      if (/\.\w+$/.test(segments[1])) continue;
      if (COMMON_DIR_PREFIXES.has(segments[0].toLowerCase())) continue;
      spans.push({
        type: 'project',
        name: value,
        start: match.index,
        end: match.index + value.length,
        confidence: 0.7,
      });
    }
    return spans;
  }

  /** Compiled regex from SERVICE_GAZETTEER — matches any known service name in one pass. */
  private static readonly SERVICE_RE = new RegExp(
    `\\b(${Array.from(SERVICE_GAZETTEER).join('|')})\\b`, 'gi'
  );

  private extractServices(text: string): RawSpan[] {
    const spans: RawSpan[] = [];

    // Single-pass gazetteer match via compiled regex
    EntityExtractor.SERVICE_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = EntityExtractor.SERVICE_RE.exec(text)) !== null) {
      spans.push({
        type: 'service',
        name: match[1],
        start: match.index,
        end: match.index + match[1].length,
        confidence: 0.85,
      });
    }

    // URL patterns (extract hostname as service hint)
    const urlRe = /https?:\/\/([\w.-]+)/g;
    while ((match = urlRe.exec(text)) !== null) {
      const hostStart = match.index + match[0].lastIndexOf(match[1]);
      spans.push({
        type: 'service',
        name: match[1],
        start: hostStart,
        end: hostStart + match[1].length,
        confidence: 0.7,
      });
    }

    return spans;
  }

  private extractComponents(text: string): RawSpan[] {
    const spans: RawSpan[] = [];
    // PascalCase with at least 2 words (e.g., AuthService, UserProvider)
    const re = /\b([A-Z][a-z]+(?:[A-Z][a-z]+)+)\b/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(text)) !== null) {
      const lower = match[1].toLowerCase();
      // Filter stoplist words and service gazetteer entries
      if (COMPONENT_STOPLIST.has(lower)) continue;
      if (SERVICE_GAZETTEER.has(lower)) continue;
      spans.push({
        type: 'component',
        name: match[1],
        start: match.index,
        end: match.index + match[1].length,
        confidence: 0.7,
      });
    }
    return spans;
  }

  private extractConcepts(text: string): RawSpan[] {
    const spans: RawSpan[] = [];

    // Hashtag mentions
    const hashRe = /#([a-zA-Z][\w-]*)\b/g;
    let match: RegExpExecArray | null;
    while ((match = hashRe.exec(text)) !== null) {
      spans.push({
        type: 'concept',
        name: match[0],
        start: match.index,
        end: match.index + match[0].length,
        confidence: 0.85,
      });
    }

    // "implements/about/regarding <word>" pattern
    const keywordRe = /\b(?:implements|about|regarding)\s+([a-zA-Z][\w-]*)\b/gi;
    while ((match = keywordRe.exec(text)) !== null) {
      const wordStart = match.index + match[0].length - match[1].length;
      spans.push({
        type: 'concept',
        name: match[1],
        start: wordStart,
        end: wordStart + match[1].length,
        confidence: 0.7,
      });
    }

    return spans;
  }

  // ═════════════════════════════════════════════════════════════════════════
  // Span merging and deduplication
  // ═════════════════════════════════════════════════════════════════════════

  /**
   * Resolve overlapping spans. When two spans overlap, keep the one with
   * higher type precedence; if tied, keep the longer span.
   */
  private mergeSpans(spans: RawSpan[]): RawSpan[] {
    if (spans.length === 0) return [];

    // Sort by start position, then by precedence descending
    const sorted = [...spans].sort((a, b) => {
      if (a.start !== b.start) return a.start - b.start;
      return TYPE_PRECEDENCE[b.type] - TYPE_PRECEDENCE[a.type];
    });

    const result: RawSpan[] = [sorted[0]];

    for (let i = 1; i < sorted.length; i++) {
      const current = sorted[i];
      const last = result[result.length - 1];

      // No overlap: current starts at or after last ends
      if (current.start >= last.end) {
        result.push(current);
        continue;
      }

      // Overlap: keep the one with higher precedence, or longer span if tied
      const lastPrec = TYPE_PRECEDENCE[last.type];
      const currPrec = TYPE_PRECEDENCE[current.type];

      if (currPrec > lastPrec) {
        // Current wins — replace last
        result[result.length - 1] = current;
      } else if (currPrec === lastPrec) {
        // Same precedence — keep longer span
        const lastLen = last.end - last.start;
        const currLen = current.end - current.start;
        if (currLen > lastLen) {
          result[result.length - 1] = current;
        }
        // Otherwise keep last (already in result)
      }
      // else: last has higher precedence, keep it (do nothing)
    }

    return result;
  }

  /**
   * Deduplicate entities by (type, canonicalName), keeping the one with
   * the highest confidence score.
   */
  private deduplicateEntities(spans: RawSpan[]): RawSpan[] {
    const seen = new Map<string, RawSpan>();
    for (const span of spans) {
      const canonical = this.canonicalize(span.name, span.type);
      const key = `${span.type}:${canonical}`;
      const existing = seen.get(key);
      if (!existing || span.confidence > existing.confidence) {
        seen.set(key, span);
      }
    }
    return Array.from(seen.values());
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// RelationDetector
// ═══════════════════════════════════════════════════════════════════════════

interface TriggerPattern {
  regex: RegExp;
  relationType: RelationType;
  passive: boolean;
}

/** Trigger phrases that signal a specific relation between entities. */
const TRIGGER_PATTERNS: TriggerPattern[] = [
  { regex: /\b(?:implements|built|created|develops)\s+/gi, relationType: 'implements', passive: false },
  { regex: /\b(?:depends\s+on|requires|uses|needs)\s+/gi, relationType: 'depends_on', passive: false },
  { regex: /\bblocks\s+/gi, relationType: 'blocks', passive: false },
  { regex: /\bblocked\s+by\s+/gi, relationType: 'blocks', passive: true },
  { regex: /\b(?:authored|written|built|created|fixed)\s+by\s+/gi, relationType: 'authored_by', passive: true },
];

/** Number of characters before a trigger match to scan for negation. */
const NEGATION_WINDOW = 25;

/** Patterns that negate a relation when found within the negation window. */
const NEGATION_PATTERNS = /\b(?:not|no|don't|doesn't|does\s+not|do\s+not|never|without|isn't|aren't|won't)\b/i;

/**
 * Detects semantic relations between entities found in text.
 *
 * For each trigger phrase matched, finds the nearest subject entity before the
 * trigger and the nearest object entity after. Handles negation (skips negated
 * triggers) and passive voice (swaps source/target direction).
 *
 * Every entity also gets a default "mentions" relation.
 */
export class RelationDetector {
  /**
   * Detect relations between entities in the given text.
   *
   * @param text - The source text to analyze
   * @param entities - Entities previously extracted from the text
   * @returns Array of detected relations
   */
  detectRelations(text: string, entities: ExtractedEntity[]): ExtractedRelation[] {
    const relations: ExtractedRelation[] = [];

    // 1. Default "mentions" relation for every entity
    for (const entity of entities) {
      relations.push({
        relationType: 'mentions',
        sourceCanonical: entity.canonicalName,
        sourceType: entity.type,
        targetCanonical: entity.canonicalName,
        targetType: entity.type,
        confidence: 0.5,
        evidence: entity.context,
      });
    }

    // 2. Scan for trigger patterns
    for (const pattern of TRIGGER_PATTERNS) {
      pattern.regex.lastIndex = 0;
      let match: RegExpExecArray | null;

      while ((match = pattern.regex.exec(text)) !== null) {
        const matchStart = match.index;
        const matchEnd = match.index + match[0].length;

        // 3. Check negation window before the match
        const windowStart = Math.max(0, matchStart - NEGATION_WINDOW);
        const windowText = text.slice(windowStart, matchStart);
        if (NEGATION_PATTERNS.test(windowText)) {
          continue; // Skip negated relation
        }

        // 4. Find nearest entity BEFORE trigger (within 80 chars)
        const subject = this.findNearestEntityBefore(entities, matchStart, 80);

        // 5. Find nearest entity AFTER trigger (within 60 chars)
        const object = this.findNearestEntityAfter(entities, matchEnd, 60);

        if (!subject && !object) {
          continue; // Need at least one entity
        }

        // When one side is missing, infer from surrounding text
        const subjectResolved = subject ?? this.inferEntityFromContext(text, matchStart, 'before');
        const objectResolved = object ?? this.inferEntityFromContext(text, matchEnd, 'after');

        // 6. If passive: swap source and target
        let source: { canonicalName: string; type: EntityType };
        let target: { canonicalName: string; type: EntityType };
        if (pattern.passive) {
          source = objectResolved;
          target = subjectResolved;
        } else {
          source = subjectResolved;
          target = objectResolved;
        }

        // 7. Emit relation with confidence 0.85 (0.7 if one side was inferred)
        const confidence = (subject && object) ? 0.85 : 0.7;
        relations.push({
          relationType: pattern.relationType,
          sourceCanonical: source.canonicalName,
          sourceType: source.type,
          targetCanonical: target.canonicalName,
          targetType: target.type,
          confidence,
          evidence: text.slice(
            Math.max(0, matchStart - 30),
            Math.min(text.length, matchEnd + 30),
          ),
        });
      }
    }

    return relations;
  }

  /**
   * Infer a lightweight entity from surrounding text when no extracted entity
   * is found on one side of a trigger phrase.
   *
   * Extracts the nearest word(s) as a concept-typed stand-in.
   */
  private inferEntityFromContext(
    text: string,
    position: number,
    direction: 'before' | 'after',
  ): { canonicalName: string; type: EntityType } {
    if (direction === 'before') {
      const fragment = text.slice(Math.max(0, position - 60), position).trim();
      const words = fragment.split(/\s+/);
      const word = words[words.length - 1] || 'unknown';
      const canonical = word.toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'unknown';
      return { canonicalName: canonical, type: 'concept' };
    } else {
      const fragment = text.slice(position, Math.min(text.length, position + 60)).trim();
      const words = fragment.split(/\s+/);
      const word = words[0] || 'unknown';
      const canonical = word.toLowerCase().replace(/[^a-z0-9_-]/g, '') || 'unknown';
      return { canonicalName: canonical, type: 'concept' };
    }
  }

  /**
   * Find the nearest entity whose span ends before the given position,
   * within the specified character window.
   */
  private findNearestEntityBefore(
    entities: ExtractedEntity[],
    position: number,
    window: number,
  ): ExtractedEntity | null {
    let best: ExtractedEntity | null = null;
    let bestDistance = Infinity;

    for (const entity of entities) {
      if (entity.end <= position && position - entity.end <= window) {
        const distance = position - entity.end;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = entity;
        }
      }
    }

    return best;
  }

  /**
   * Find the nearest entity whose span starts at or after the given position,
   * within the specified character window.
   */
  private findNearestEntityAfter(
    entities: ExtractedEntity[],
    position: number,
    window: number,
  ): ExtractedEntity | null {
    let best: ExtractedEntity | null = null;
    let bestDistance = Infinity;

    for (const entity of entities) {
      if (entity.start >= position && entity.start - position <= window) {
        const distance = entity.start - position;
        if (distance < bestDistance) {
          bestDistance = distance;
          best = entity;
        }
      }
    }

    return best;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// EntityPersistence
// ═══════════════════════════════════════════════════════════════════════════

// Relations where a source has at most ONE valid target at a time. Only these
// evict prior open windows on contradiction. The currently-extracted types
// (implements, depends_on, blocks, authored_by) are all many-valued, so this is
// empty by default — preventing false invalidation. Add genuinely single-valued
// relations (e.g. a future 'current_status') here to enable window-closing for them.
export const FUNCTIONAL_RELATION_TYPES = new Set<string>([]);

/**
 * Persists extracted entities and relations to SQLite.
 *
 * Uses better-sqlite3 transactions for atomicity. All SQL is parameterized.
 * Idempotent: deletes old doc_entities before re-inserting.
 * Stores raw surface form in metadata_json for provenance.
 */
export class EntityPersistence {
  private db: Database.Database;
  private stmtUpsertEntity: Database.Statement;
  private stmtGetEntityId: Database.Statement;
  private stmtDeleteDocEntities: Database.Statement;
  private stmtInsertDocEntity: Database.Statement;
  private stmtFindOpenSameTuple: Database.Statement;
  private stmtCloseOpenForSourceType: Database.Statement;
  private stmtInsertRelation: Database.Statement;

  constructor(db: Database.Database) {
    this.db = db;
    this.stmtUpsertEntity = db.prepare(`
      INSERT INTO entities (type, name, canonical_name, metadata_json, updated_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(type, canonical_name) DO UPDATE SET
        updated_at = CURRENT_TIMESTAMP,
        metadata_json = CASE
          WHEN excluded.metadata_json IS NOT NULL THEN excluded.metadata_json
          ELSE entities.metadata_json
        END
    `);
    this.stmtGetEntityId = db.prepare(
      'SELECT id FROM entities WHERE type = ? AND canonical_name = ?'
    );
    this.stmtDeleteDocEntities = db.prepare(
      'DELETE FROM doc_entities WHERE doc_id = ?'
    );
    this.stmtInsertDocEntity = db.prepare(
      'INSERT OR IGNORE INTO doc_entities (doc_id, entity_id, relation_type, context, confidence) VALUES (?, ?, ?, ?, ?)'
    );
    // Bi-temporal relation write path (BUG-2, BUG-7):
    // 1. Check if the exact same open tuple already exists (idempotent re-assert).
    this.stmtFindOpenSameTuple = db.prepare(
      'SELECT id FROM entity_relations WHERE source_id=? AND target_id=? AND relation_type=? AND valid_to IS NULL'
    );
    // 2. Close any currently-open row for the same (source, relation_type) where
    //    the target differs — this is the "contradiction closes a window" step.
    this.stmtCloseOpenForSourceType = db.prepare(
      'UPDATE entity_relations SET valid_to=? WHERE source_id=? AND relation_type=? AND valid_to IS NULL AND target_id<>?'
    );
    // 3. Insert the new open fact.
    this.stmtInsertRelation = db.prepare(
      'INSERT INTO entity_relations (source_id, target_id, relation_type, weight, valid_from, valid_to) VALUES (?,?,?,?,?,NULL)'
    );
  }

  /**
   * Upsert a single entity relation with bi-temporal semantics:
   * - If the same open (source, target, relation_type) already exists, no-op.
   * - Otherwise close any open row for the same (source, relation_type) with a
   *   different target (contradiction), then insert a new open row.
   */
  upsertRelation(
    sourceId: number,
    targetId: number,
    relationType: string,
    weight: number,
    validFrom?: string,
  ): void {
    const now = validFrom ?? new Date().toISOString().replace(/\.\d{3}Z$/, 'Z');
    if (this.stmtFindOpenSameTuple.get(sourceId, targetId, relationType)) return; // already open — idempotent
    if (FUNCTIONAL_RELATION_TYPES.has(relationType)) {
      this.stmtCloseOpenForSourceType.run(now, sourceId, relationType, targetId);
    }
    this.stmtInsertRelation.run(sourceId, targetId, relationType, weight, now);
  }

  /**
   * Persist extracted entities and relations for a document.
   * Runs in a single transaction for atomicity.
   * Idempotent: deletes old doc_entities before re-inserting.
   */
  persistForDocument(
    docId: string,
    entities: ExtractedEntity[],
    relations: ExtractedRelation[],
  ): void {
    const persist = this.db.transaction(() => {
      // 1. Upsert all entities, collect IDs
      const entityIdMap = new Map<string, number>();
      for (const entity of entities) {
        const metadataJson = JSON.stringify({ surfaceForm: entity.name });
        this.stmtUpsertEntity.run(entity.type, entity.name, entity.canonicalName, metadataJson);
        const row = this.stmtGetEntityId.get(entity.type, entity.canonicalName) as { id: number } | undefined;
        if (row) {
          entityIdMap.set(`${entity.type}:${entity.canonicalName}`, row.id);
        }
      }

      // 2. Delete old doc_entities for this document
      this.stmtDeleteDocEntities.run(docId);

      // 3. Insert new doc_entities
      for (const relation of relations) {
        const entityKey = `${relation.sourceType}:${relation.sourceCanonical}`;
        const entityId = entityIdMap.get(entityKey);
        if (!entityId) continue;
        this.stmtInsertDocEntity.run(docId, entityId, relation.relationType, relation.evidence, relation.confidence);
      }

      // 4. Insert entity-to-entity relations (skip "mentions") using bi-temporal upsert
      for (const relation of relations) {
        if (relation.relationType === 'mentions') continue;
        const sourceKey = `${relation.sourceType}:${relation.sourceCanonical}`;
        const targetKey = `${relation.targetType}:${relation.targetCanonical}`;
        const sourceId = entityIdMap.get(sourceKey);
        const targetId = entityIdMap.get(targetKey);
        if (sourceId && targetId && sourceId !== targetId) {
          this.upsertRelation(sourceId, targetId, relation.relationType, relation.confidence ?? 1.0);
        }
      }
    });

    persist();
  }
}
