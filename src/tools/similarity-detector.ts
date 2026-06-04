/**
 * Similarity Detection Engine
 * Implements TF-IDF based similarity with multiple similarity metrics
 */

import { 
  SimilarityResult, 
  SimilarityOptions, 
  TextVector, 
  SimilarityIndex,
  DocumentIndex 
} from '../types/similarity-types.js';
import { textProcessor } from './text-processor.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import matter from 'gray-matter';

export class SimilarityDetector {
  private index: SimilarityIndex | null = null;
  private readonly devlogPath: string;

  constructor(devlogPath: string = process.env.DOKORO_PATH || path.join(process.cwd(), 'devlog')) {
    this.devlogPath = devlogPath;
  }

  /**
   * Build or rebuild the similarity index
   */
  async buildIndex(patterns: string[] = ['**/*.md']): Promise<void> {
    const glob = (await import('glob')).glob;
    const documents = new Map<string, DocumentIndex>();
    const documentFreq = new Map<string, number>();
    let totalDocs = 0;

    // Collect all documents
    for (const pattern of patterns) {
      const files = await glob(pattern, { cwd: this.devlogPath });
      
      for (const file of files) {
        try {
          const filePath = path.join(this.devlogPath, file);
          const content = await fs.readFile(filePath, 'utf-8');
          const parsed = matter(content);
          const stats = await fs.stat(filePath);
          
          if (!parsed.content.trim()) continue;
          
          // Process text
          const tokens = textProcessor.tokenize(parsed.content);
          const termFreq = textProcessor.calculateTermFrequency(tokens);
          
          // Update document frequency
          termFreq.forEach((_, term) => {
            documentFreq.set(term, (documentFreq.get(term) || 0) + 1);
          });
          
          // Extract tags
          const tags = Array.isArray(parsed.data.tags) 
            ? parsed.data.tags 
            : (parsed.data.tags ? [parsed.data.tags] : []);
          
          // Store document data (will calculate TF-IDF later)
          documents.set(file, {
            file,
            vector: {
              terms: termFreq,
              magnitude: 0  // Will calculate after IDF
            },
            tags,
            metadata: {
              title: parsed.data.title,
              date: parsed.data.date,
              wordCount: tokens.length,
              lastModified: stats.mtime
            }
          });
          
          totalDocs++;
        } catch (error) {
          console.error(`Error processing ${file}:`, error);
        }
      }
    }

    // Calculate IDF
    const idf = new Map<string, number>();
    documentFreq.forEach((docCount, term) => {
      idf.set(term, Math.log(totalDocs / docCount));
    });

    // Calculate TF-IDF vectors and magnitudes
    documents.forEach(doc => {
      let magnitude = 0;
      
      // Convert TF to TF-IDF
      doc.vector.terms.forEach((tf, term) => {
        const tfidf = tf * (idf.get(term) || 0);
        doc.vector.terms.set(term, tfidf);
        magnitude += tfidf * tfidf;
      });
      
      doc.vector.magnitude = Math.sqrt(magnitude);
    });

    // Store index
    this.index = {
      documents,
      idf,
      lastUpdated: new Date()
    };
  }

  /**
   * Find similar documents using cosine similarity
   */
  async findSimilar(
    content: string, 
    options: SimilarityOptions = {}
  ): Promise<SimilarityResult[]> {
    const {
      threshold = 0.3,
      maxResults = 10,
      includeTypes = ['semantic', 'structural', 'tag-based'],
      excludeFiles = [],
      boostRecent = false
    } = options;

    // Ensure index is built
    if (!this.index) {
      await this.buildIndex();
    }

    // Process query content
    const tokens = textProcessor.tokenize(content);
    const queryTf = textProcessor.calculateTermFrequency(tokens);
    const queryVector = this.convertToTfidf(queryTf);
    
    const results: SimilarityResult[] = [];

    // Calculate similarity with each document
    this.index!.documents.forEach((doc, file) => {
      if (excludeFiles.includes(file)) return;

      let score = 0;

      // Semantic similarity (cosine similarity of TF-IDF vectors)
      if (includeTypes.includes('semantic')) {
        score += this.cosineSimilarity(queryVector, doc.vector) * 0.7;
      }

      // Structural similarity (based on length, format)
      if (includeTypes.includes('structural')) {
        const lengthSim = 1 - Math.abs(tokens.length - doc.metadata.wordCount) / 
                         Math.max(tokens.length, doc.metadata.wordCount);
        score += lengthSim * 0.2;
      }

      // Tag-based similarity
      if (includeTypes.includes('tag-based') && doc.tags.length > 0) {
        // Extract potential tags from query
        const queryTags = this.extractPotentialTags(content);
        const tagOverlap = this.calculateTagSimilarity(queryTags, doc.tags);
        score += tagOverlap * 0.1;
      }

      // Boost recent files if requested
      if (boostRecent && doc.metadata.lastModified) {
        const daysSince = (Date.now() - doc.metadata.lastModified.getTime()) / (1000 * 60 * 60 * 24);
        const recencyBoost = Math.max(0, 1 - daysSince / 30) * 0.1;
        score = score * (1 + recencyBoost);
      }

      if (score >= threshold) {
        results.push({
          file,
          score: Math.min(score, 1),
          type: 'semantic',
          excerpt: this.generateExcerpt(doc, queryVector),
          metadata: {
            title: doc.metadata.title,
            date: doc.metadata.date,
            tags: doc.tags,
            wordCount: doc.metadata.wordCount
          }
        });
      }
    });

    // Sort by score and limit results
    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, maxResults);
  }

  /**
   * Find documents similar to an existing document
   */
  async findSimilarToFile(
    filePath: string,
    options: SimilarityOptions = {}
  ): Promise<SimilarityResult[]> {
    const content = await fs.readFile(path.join(this.devlogPath, filePath), 'utf-8');
    const parsed = matter(content);
    
    return this.findSimilar(parsed.content, {
      ...options,
      excludeFiles: [...(options.excludeFiles || []), filePath]
    });
  }

  /**
   * Convert term frequency to TF-IDF vector
   */
  private convertToTfidf(termFreq: Map<string, number>): TextVector {
    const tfidf = new Map<string, number>();
    let magnitude = 0;

    termFreq.forEach((tf, term) => {
      const idf = this.index?.idf.get(term) || 0;
      const score = tf * idf;
      tfidf.set(term, score);
      magnitude += score * score;
    });

    return {
      terms: tfidf,
      magnitude: Math.sqrt(magnitude)
    };
  }

  /**
   * Calculate cosine similarity between two vectors
   */
  private cosineSimilarity(vec1: TextVector, vec2: TextVector): number {
    if (vec1.magnitude === 0 || vec2.magnitude === 0) return 0;

    let dotProduct = 0;
    vec1.terms.forEach((score1, term) => {
      const score2 = vec2.terms.get(term) || 0;
      dotProduct += score1 * score2;
    });

    return dotProduct / (vec1.magnitude * vec2.magnitude);
  }

  /**
   * Calculate tag similarity (Jaccard similarity)
   */
  private calculateTagSimilarity(tags1: string[], tags2: string[]): number {
    const set1 = new Set(tags1);
    const set2 = new Set(tags2);
    
    const intersection = new Set([...set1].filter(x => set2.has(x)));
    const union = new Set([...set1, ...set2]);
    
    return union.size > 0 ? intersection.size / union.size : 0;
  }

  /**
   * Extract potential tags from content (simplified)
   */
  private extractPotentialTags(content: string): string[] {
    const tags: string[] = [];
    
    // Look for common tag patterns
    if (/implement|feature|add/i.test(content)) tags.push('type:feature');
    if (/fix|bug|issue/i.test(content)) tags.push('type:bugfix');
    if (/research|explore|investigate/i.test(content)) tags.push('type:research');
    if (/complete|done|finish/i.test(content)) tags.push('status:completed');
    if (/progress|working|ongoing/i.test(content)) tags.push('status:in-progress');
    
    return tags;
  }

  /**
   * Generate excerpt highlighting similar content
   */
  private generateExcerpt(doc: DocumentIndex, queryVector: TextVector): string {
    // Find top matching terms
    const matchingTerms: string[] = [];
    queryVector.terms.forEach((_, term) => {
      if (doc.vector.terms.has(term)) {
        matchingTerms.push(term);
      }
    });

    // For now, just return first 150 chars
    // In a real implementation, we'd highlight matching terms
    const excerpt = doc.file.replace('.md', '').replace(/\//g, ' > ');
    return excerpt.substring(0, 150) + '...';
  }

  /**
   * Cluster similar documents
   */
  async clusterDocuments(threshold: number = 0.5): Promise<Map<string, string[]>> {
    if (!this.index) {
      await this.buildIndex();
    }

    const clusters = new Map<string, string[]>();
    const assigned = new Set<string>();
    let clusterId = 0;

    // Simple clustering: group documents with similarity above threshold
    this.index!.documents.forEach((doc1, file1) => {
      if (assigned.has(file1)) return;

      const cluster: string[] = [file1];
      assigned.add(file1);

      this.index!.documents.forEach((doc2, file2) => {
        if (file1 === file2 || assigned.has(file2)) return;

        const similarity = this.cosineSimilarity(doc1.vector, doc2.vector);
        if (similarity >= threshold) {
          cluster.push(file2);
          assigned.add(file2);
        }
      });

      if (cluster.length > 1) {
        clusters.set(`cluster-${clusterId++}`, cluster);
      }
    });

    return clusters;
  }
}

// Export singleton instance
export const similarityDetector = new SimilarityDetector();