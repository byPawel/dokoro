/**
 * Dokoro compression tool
 * Consolidates daily files into weekly summaries
 */

import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import { ToolDefinition } from './registry.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DOKORO_PATH } from '../types/dokoro.js';
import matter from 'gray-matter';
import { glob } from 'glob';

interface SessionData {
  file: string;
  date: Date;
  content: string;
  frontmatter: Record<string, unknown>;
  summary?: string;
  completedTasks: string[];
  inProgressTasks: string[];
  decisions: string[];
  insights: string[];
}

export const compressionTool: ToolDefinition = {
  name: 'dokoro_compress_week',
  title: 'Compress Weekly Sessions',
  description: 'Compress daily session files into weekly summary',
  inputSchema: {
    weekNumber: z.number().optional().describe('Week number to compress (defaults to last week)'),
    year: z.number().optional().describe('Year (defaults to current year)'),
    dryRun: z.boolean().optional().default(false).describe('Preview without making changes'),
  },
  handler: async ({ weekNumber, year, dryRun = false }): Promise<CallToolResult> => {
    const now = new Date();
    const currentYear = year || now.getFullYear();
    
    // Calculate week number if not provided
    if (!weekNumber) {
      const oneWeekAgo = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
      weekNumber = getWeekNumber(oneWeekAgo);
    }
    
    try {
      // Find daily files for the week
      const weekDates = getWeekDates(currentYear, weekNumber);
      const dailyFiles = await findDailyFiles(weekDates.start, weekDates.end);
      
      if (dailyFiles.length === 0) {
        return {
          content: [{
            type: 'text',
            text: `No daily files found for week ${weekNumber} of ${currentYear}`
          }]
        };
      }
      
      // Extract data from each session
      const sessions = await extractSessionData(dailyFiles);
      
      // Generate weekly summary
      const weeklySummary = await generateWeeklySummary(sessions, weekNumber, currentYear);
      
      // Paths for new files (deterministic week-scoped names: re-running
      // compression for the same week must target the same file).
      const weekDir = weekDirName(currentYear, weekNumber);
      const weeklyFile = path.join(DOKORO_PATH, 'retrospective', 'weekly',
        `${weekDir}-consolidated.md`);
      const archiveDir = path.join(DOKORO_PATH, 'archive', 'daily', weekDir);
      
      if (dryRun) {
        return {
          content: [{
            type: 'text',
            text: `🔍 **Dry Run - Week ${weekNumber} Compression**\n\n` +
              `Files to compress: ${dailyFiles.length}\n` +
              `- ${dailyFiles.map(f => path.basename(f)).join('\n- ')}\n\n` +
              `Weekly summary would be saved to:\n${weeklyFile}\n\n` +
              `Daily files would be moved to:\n${archiveDir}/\n\n` +
              `**Summary Preview:**\n${weeklySummary.substring(0, 500)}...`
          }]
        };
      }
      
      // Create directories
      await fs.mkdir(path.dirname(weeklyFile), { recursive: true });
      await fs.mkdir(archiveDir, { recursive: true });
      
      // Write weekly summary
      await fs.writeFile(weeklyFile, weeklySummary);
      
      // Move daily files to archive
      for (const file of dailyFiles) {
        const basename = path.basename(file);
        const archivePath = path.join(archiveDir, basename);
        await fs.rename(file, archivePath);
      }
      
      return {
        content: [{
          type: 'text',
          text: `✅ **Week ${weekNumber} Compressed Successfully!**\n\n` +
            `📊 Statistics:\n` +
            `- Sessions compressed: ${sessions.length}\n` +
            `- Tasks completed: ${sessions.flatMap(s => s.completedTasks).length}\n` +
            `- Decisions made: ${sessions.flatMap(s => s.decisions).length}\n` +
            `- Insights captured: ${sessions.flatMap(s => s.insights).length}\n\n` +
            `📁 Files:\n` +
            `- Weekly summary: ${path.relative(DOKORO_PATH, weeklyFile)}\n` +
            `- Archived to: ${path.relative(DOKORO_PATH, archiveDir)}/\n\n` +
            `💡 The weekly summary is now the primary search target.\n` +
            `Original files are preserved in archive for reference.`
        }]
      };
    } catch (error) {
      return {
        content: [{
          type: 'text',
          text: `❌ Compression failed: ${error}`
        }]
      };
    }
  }
};

// Helper functions

/**
 * Build the `YYYY-Www` directory/filename prefix for a (year, week) pair.
 *
 * NOTE: unlike `isoWeekDir()` in src/utils/timestamp.ts (which uses the ISO
 * week-YEAR), `year` here is the calendar year supplied by the caller (or the
 * current calendar year). The week NUMBER itself is ISO (see getWeekNumber).
 * Kept as-is so existing archive names stay stable; do not change silently.
 */
function weekDirName(year: number, week: number): string {
  return `${year}-W${String(week).padStart(2, '0')}`;
}

function getWeekNumber(date: Date): number {
  const d = new Date(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  return Math.ceil((((d.getTime() - yearStart.getTime()) / 86400000) + 1) / 7);
}

function getWeekDates(year: number, weekNumber: number) {
  // Find the first Thursday of the year (ISO week date standard)
  const jan4 = new Date(year, 0, 4);
  const jan4DayOfWeek = jan4.getDay() || 7; // Convert Sunday from 0 to 7
  
  // Find the Monday of the week containing January 4th
  const firstMondayOfYear = new Date(jan4);
  firstMondayOfYear.setDate(4 - jan4DayOfWeek + 1);
  
  // Calculate the start of the requested week
  const weekStart = new Date(firstMondayOfYear);
  weekStart.setDate(firstMondayOfYear.getDate() + (weekNumber - 1) * 7);
  
  const weekEnd = new Date(weekStart);
  weekEnd.setDate(weekStart.getDate() + 6);
  
  return { start: weekStart, end: weekEnd };
}

/**
 * Find daily files whose `YYYY-MM-DD` filename prefix falls inside the window.
 * Matches by date prefix only, so it accepts BOTH old-format files (written
 * with a possibly local-TZ weekday) and new `formatTimestampSlug` files.
 * Exported for tests.
 */
export async function findDailyFiles(startDate: Date, endDate: Date): Promise<string[]> {
  const pattern = path.join(DOKORO_PATH, 'daily', '*.md');
  const files = await glob(pattern);
  
  return files.filter(file => {
    const match = path.basename(file).match(/^(\d{4}-\d{2}-\d{2})/);
    if (!match) return false;
    
    const fileDate = new Date(match[1]);
    return fileDate >= startDate && fileDate <= endDate;
  });
}

async function extractSessionData(files: string[]): Promise<SessionData[]> {
  const sessions: SessionData[] = [];
  
  for (const file of files) {
    const content = await fs.readFile(file, 'utf-8');
    const parsed = matter(content);
    
    // Parse date from filename (more reliable than frontmatter format)
    const filenameMatch = path.basename(file).match(/^(\d{4}-\d{2}-\d{2})/);
    let sessionDate: Date;
    
    if (filenameMatch) {
      sessionDate = new Date(filenameMatch[1]);
    } else if (parsed.data.date && parsed.data.date.length === 8) {
      // Handle format like "25062608" 
      sessionDate = new Date(path.basename(file).substring(0, 10));
    } else {
      sessionDate = new Date(parsed.data.date || path.basename(file).substring(0, 10));
    }
    
    const session: SessionData = {
      file,
      date: sessionDate,
      content: parsed.content,
      frontmatter: parsed.data,
      completedTasks: [],
      inProgressTasks: [],
      decisions: [],
      insights: []
    };
    
    // Extract completed tasks
    const completedMatches = parsed.content.match(/- \[x\] .+/g) || [];
    session.completedTasks = completedMatches.map(m => m.replace(/- \[x\] /, ''));
    
    // Extract decisions
    const decisionMatches = parsed.content.match(/(?:decision|decided|chose):.+/gi) || [];
    session.decisions = decisionMatches;
    
    // Extract insights
    const insightMatches = parsed.content.match(/(?:insight|learned|discovered):.+/gi) || [];
    session.insights = insightMatches;
    
    // Extract summary if present
    const summaryMatch = parsed.content.match(/## Summary\n([\s\S]+?)(?=\n##|$)/);
    if (summaryMatch) {
      session.summary = summaryMatch[1].trim();
    }
    
    sessions.push(session);
  }
  
  return sessions.sort((a, b) => a.date.getTime() - b.date.getTime());
}

async function generateWeeklySummary(
  sessions: SessionData[], 
  weekNumber: number, 
  year: number
): Promise<string> {
  const allCompleted = sessions.flatMap(s => s.completedTasks);
  const allDecisions = sessions.flatMap(s => s.decisions);
  const allInsights = sessions.flatMap(s => s.insights);
  
  // Extract unique focus areas from tags
  const focusAreas = new Set<string>();
  sessions.forEach(s => {
    const tags = s.frontmatter.tags as { scope?: string | string[]; [key: string]: unknown } | undefined;
    if (tags?.scope) {
      const scopes = Array.isArray(tags.scope) 
        ? tags.scope 
        : [tags.scope];
      scopes.forEach((scope: string) => focusAreas.add(scope));
    }
  });
  
  // Calculate productivity metrics
  const totalHours = sessions.length * 2.5; // Rough estimate
  
  const summary = `---
title: "Week ${weekNumber} Consolidated - ${year}"
date: "${new Date().toISOString()}"
week: ${weekNumber}
year: ${year}
sessions: ${sessions.length}
tags:
  type: weekly-summary
  scope: [${Array.from(focusAreas).join(', ')}]
  status: consolidated
  index_priority: high
---

# Week ${weekNumber} Summary - ${year}

## 📊 Overview
- **Sessions**: ${sessions.length}
- **Estimated Hours**: ${totalHours}
- **Tasks Completed**: ${allCompleted.length}
- **Decisions Made**: ${allDecisions.length}
- **Key Insights**: ${allInsights.length}
- **Focus Areas**: ${Array.from(focusAreas).join(', ')}

## 🎯 Major Accomplishments

${allCompleted.length > 0 ? allCompleted.slice(0, 10).map(task => `- ✅ ${task}`).join('\n') : '- No completed tasks recorded'}
${allCompleted.length > 10 ? `\n... and ${allCompleted.length - 10} more tasks` : ''}

## 🤔 Key Decisions

${allDecisions.length > 0 ? allDecisions.slice(0, 5).map(d => `- 📋 ${d}`).join('\n') : '- No major decisions recorded'}

## 💡 Insights & Learnings

${allInsights.length > 0 ? allInsights.slice(0, 5).map(i => `- 💡 ${i}`).join('\n') : '- No insights recorded'}

## 📅 Daily Breakdown

${sessions.map(s => {
  const dayName = s.date.toLocaleDateString('en-US', { weekday: 'long' });
  const dateStr = s.date.toISOString().split('T')[0];
  return `### ${dayName}, ${dateStr}
${s.summary || 'No summary available'}
- Completed: ${s.completedTasks.length} tasks
- File: archive/daily/${weekDirName(year, weekNumber)}/${path.basename(s.file)}`;
}).join('\n\n')}

## 🔍 Patterns & Metrics
- **Average tasks/session**: ${(allCompleted.length / sessions.length).toFixed(1)}
- **Most productive day**: ${getMostProductiveDay(sessions)}
- **Primary focus**: ${Array.from(focusAreas)[0] || 'General development'}

---
*Generated from ${sessions.length} daily sessions*
*Original files archived to: archive/daily/${weekDirName(year, weekNumber)}/*
`;
  
  return summary;
}

function getMostProductiveDay(sessions: SessionData[]): string {
  if (sessions.length === 0) return 'N/A';
  
  const mostProductive = sessions.reduce((best, current) => {
    return current.completedTasks.length > best.completedTasks.length ? current : best;
  });
  
  return mostProductive.date.toLocaleDateString('en-US', { 
    weekday: 'long', 
    month: 'short', 
    day: 'numeric' 
  });
}