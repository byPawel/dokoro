/**
 * Embedding & Chunking Service (LanceDB-free)
 *
 * Extracted from vector-service.ts so the core server can embed and chunk text
 * without ever loading the heavy, optional @lancedb/lancedb native module. Only
 * the vector-store code path (vector-service.ts) lazy-loads LanceDB.
 *
 * Handles:
 * - Embeddings via Ollama (nomic-embed-text)
 * - Chunking logic (whole file ≤2k tokens, else 512-token line-aware sliding windows)
 */

import * as crypto from 'node:crypto';
import { EmbeddingCache } from './embedding-cache.js';

// Constants
const OLLAMA_URL = process.env.OLLAMA_URL || 'http://localhost:11434';
const EMBEDDING_MODEL = 'nomic-embed-text';
const MAX_TOKENS_WHOLE_FILE = 2000;
const CHUNK_SIZE_TOKENS = 512;
const CHUNK_OVERLAP_TOKENS = 128;
const APPROX_CHARS_PER_TOKEN = 4;

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════

export interface EmbeddingResult {
  embedding: number[];
  tokenCount: number;
}

export interface Chunk {
  chunkId: string;
  docId: string;
  chunkIndex: number;
  text: string;
  startLine: number;
  endLine: number;
  startChar: number;
  endChar: number;
  headerContext: string | null;
  tokenCount: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// EMBEDDING SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class EmbeddingService {
  private ollamaUrl: string;
  private model: string;
  private cache?: EmbeddingCache;

  constructor(ollamaUrl = OLLAMA_URL, model = EMBEDDING_MODEL, cache?: EmbeddingCache) {
    this.ollamaUrl = ollamaUrl;
    this.model = model;
    this.cache = cache;
  }

  async embed(text: string): Promise<EmbeddingResult> {
    const cleanText = text
      .replace(/\0/g, '')
      // eslint-disable-next-line no-control-regex
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '')
      .trim();

    if (!cleanText) {
      throw new Error('Empty text after cleaning');
    }

    // Check cache before calling Ollama
    if (this.cache) {
      const contentHash = crypto.createHash('sha256').update(cleanText).digest('hex');
      const cached = this.cache.get(contentHash);
      if (cached) {
        return { embedding: cached.embedding, tokenCount: cached.tokenCount };
      }

      // Cache miss - call Ollama and store result
      const result = await this.callOllama(cleanText);
      this.cache.set(contentHash, result.embedding, result.tokenCount);
      return result;
    }

    return this.callOllama(cleanText);
  }

  private async callOllama(cleanText: string): Promise<EmbeddingResult> {
    // Fast-fail if Ollama is unreachable (a dropped connection would otherwise
    // hang the request path indefinitely — see #19). Callers catch and fall back.
    const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS) || 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const response = await fetch(`${this.ollamaUrl}/api/embed`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: this.model,
          input: cleanText,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const errorText = await response.text();
        console.error(`[Embedding] Ollama error: ${response.status} - ${errorText.slice(0, 200)}`);
        throw new Error(`Ollama embedding failed: ${response.statusText}`);
      }

      const data = await response.json() as { embeddings: number[][] };
      const embedding = data.embeddings[0];

      if (!embedding || embedding.length === 0) {
        throw new Error('No embedding returned from Ollama');
      }

      const tokenCount = Math.ceil(cleanText.length / APPROX_CHARS_PER_TOKEN);
      return { embedding, tokenCount };
    } finally {
      clearTimeout(timer);
    }
  }

  async embedBatch(texts: string[]): Promise<EmbeddingResult[]> {
    const results: EmbeddingResult[] = [];
    for (const text of texts) {
      const result = await this.embed(text);
      results.push(result);
    }
    return results;
  }

  async healthCheck(): Promise<boolean> {
    const timeoutMs = Number(process.env.OLLAMA_TIMEOUT_MS) || 5000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();
    try {
      const response = await fetch(`${this.ollamaUrl}/api/tags`, { signal: controller.signal });
      if (!response.ok) return false;

      const data = await response.json() as { models: { name: string }[] };
      return data.models.some(m => m.name.includes(this.model));
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// CHUNKING SERVICE
// ═══════════════════════════════════════════════════════════════════════════

export class ChunkingService {
  chunk(content: string, docId: string): Chunk[] {
    const lines = content.split('\n');
    const totalChars = content.length;
    const estimatedTokens = Math.ceil(totalChars / APPROX_CHARS_PER_TOKEN);

    if (estimatedTokens <= MAX_TOKENS_WHOLE_FILE) {
      return [{
        chunkId: `${docId}_0`,
        docId,
        chunkIndex: 0,
        text: content,
        startLine: 1,
        endLine: lines.length,
        startChar: 0,
        endChar: totalChars,
        headerContext: this.extractFirstHeader(content),
        tokenCount: estimatedTokens,
      }];
    }

    const chunks: Chunk[] = [];
    const chunkBudget = CHUNK_SIZE_TOKENS * APPROX_CHARS_PER_TOKEN;
    const overlapBudget = CHUNK_OVERLAP_TOKENS * APPROX_CHARS_PER_TOKEN;

    let lineIdx = 0;
    let chunkIndex = 0;

    while (lineIdx < lines.length) {
      let charCount = 0;
      const startLineIdx = lineIdx;

      // Accumulate lines until we reach the character budget
      while (lineIdx < lines.length) {
        const lineLen = lines[lineIdx].length + 1; // +1 for '\n'
        if (charCount > 0 && charCount + lineLen > chunkBudget) {
          break;
        }
        // Force-include the line if it's the first one (even if it exceeds budget)
        charCount += lineLen;
        lineIdx++;
      }

      // Build chunk text: join selected lines with '\n'
      const selectedLines = lines.slice(startLineIdx, lineIdx);
      let chunkText = selectedLines.join('\n');

      // Non-final chunks end with '\n'
      if (lineIdx < lines.length) {
        chunkText += '\n';
      }

      // Compute char positions in original content
      const startChar = lines.slice(0, startLineIdx).reduce(
        (sum, l) => sum + l.length + 1, 0
      );
      const endChar = startChar + chunkText.length;

      chunks.push({
        chunkId: `${docId}_${chunkIndex}`,
        docId,
        chunkIndex,
        text: chunkText,
        startLine: startLineIdx + 1,
        endLine: startLineIdx + selectedLines.length,
        startChar,
        endChar,
        headerContext: this.extractNearestHeader(content, startChar) || this.extractFirstHeader(content),
        tokenCount: Math.ceil(chunkText.length / APPROX_CHARS_PER_TOKEN),
      });

      chunkIndex++;

      // Rewind by overlap: step back lines worth ~overlapBudget characters
      if (lineIdx < lines.length) {
        let rewindChars = 0;
        let rewindLines = 0;
        for (let i = lineIdx - 1; i > startLineIdx; i--) {
          const lineLen = lines[i].length + 1;
          if (rewindChars + lineLen > overlapBudget) break;
          rewindChars += lineLen;
          rewindLines++;
        }
        lineIdx -= rewindLines;
      }
    }

    return chunks;
  }

  private extractFirstHeader(content: string): string | null {
    const match = content.match(/^#+\s+(.+)$/m);
    return match ? match[1].trim() : null;
  }

  private extractNearestHeader(content: string, pos: number): string | null {
    const beforePos = content.slice(0, pos);
    const headers = beforePos.match(/^#+\s+(.+)$/gm);
    if (!headers || headers.length === 0) return null;

    const lastHeader = headers[headers.length - 1];
    const match = lastHeader.match(/^#+\s+(.+)$/);
    return match ? match[1].trim() : null;
  }
}
