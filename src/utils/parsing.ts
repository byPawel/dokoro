import matter from 'gray-matter';
import { ParsedDevlog } from '../types/dokoro.js';

/**
 * Parse devlog content with frontmatter
 */
export function parseDevlogContent(content: string): ParsedDevlog {
  let parsed;
  
  try {
    // Try parsing with gray-matter
    parsed = matter(content);
  } catch (error) {
    // If parsing fails, try to fix common YAML issues
    const fixedContent = fixYamlContent(content);
    try {
      parsed = matter(fixedContent);
    } catch {
      // If still fails, return minimal parsed content
      console.warn('Failed to parse YAML frontmatter:', error);
      return {
        content: content,
        data: {},
        tags: {},
        title: undefined,
        date: undefined
      };
    }
  }
  
  // Extract tags - handle both object and array formats
  let tags: Record<string, unknown> = {};
  if (parsed.data.tags) {
    if (typeof parsed.data.tags === 'object' && !Array.isArray(parsed.data.tags)) {
      tags = parsed.data.tags;
    } else if (Array.isArray(parsed.data.tags)) {
      tags = { tags: parsed.data.tags };
    }
  }
  
  return {
    content: parsed.content,
    data: parsed.data,
    tags,
    title: parsed.data.title,
    date: parsed.data.date
  };
}

/**
 * Fix common YAML issues in frontmatter
 */
function fixYamlContent(content: string): string {
  // Extract frontmatter section
  const frontmatterMatch = content.match(/^---\n([\s\S]*?)\n---/);
  if (!frontmatterMatch) return content;
  
  let frontmatter = frontmatterMatch[1];
  const restContent = content.slice(frontmatterMatch[0].length);
  
  // Fix unquoted values in tags section
  // This regex finds lines like "  type: testing" and adds quotes
  frontmatter = frontmatter.replace(/^(\s+)([\w-]+):\s*([^"'[{].*?)$/gm, (match, indent, key, value) => {
    // Skip if value is already quoted, is a number, boolean, or null
    if (/^(true|false|null|\d+(\.\d+)?|".*"|'.*'|\[.*\]|\{.*\})$/.test(value.trim())) {
      return match;
    }
    // Add quotes to unquoted string values
    return `${indent}${key}: "${value.trim()}"`;
  });
  
  return `---\n${frontmatter}\n---${restContent}`;
}