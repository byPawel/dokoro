import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import { ToolDefinition } from './registry.js';
import { getCurrentWorkspace } from '../utils/workspace.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DEVLOG_PATH } from '../types/devlog.js';
import { renderOutput } from '../utils/render-output.js';
import { icon } from '../utils/icons.js';

// Question interface
interface Question {
  id: string;
  question: string;
  context?: string;
  created_at: string;
  answered_at?: string;
  answer?: string;
  status: 'open' | 'answered';
  priority: 'low' | 'medium' | 'high' | 'blocker';
}

// Questions file path
const QUESTIONS_FILE = path.join(DEVLOG_PATH, '.mcp', 'questions.json');

// In-process async mutex for questions.json — serialises concurrent
// read-modify-write calls so no writes are lost (BUG-20).
let _questionsChain: Promise<void> = Promise.resolve();
function withQuestionsLock<T>(fn: () => Promise<T>): Promise<T> {
  const next = _questionsChain.then(fn, fn);
  // Keep the chain moving even if fn throws; callers get the real error.
  _questionsChain = next.then(
    () => undefined,
    () => undefined,
  );
  return next;
}

// Load questions from file
async function loadQuestions(): Promise<Question[]> {
  try {
    const content = await fs.readFile(QUESTIONS_FILE, 'utf-8');
    return JSON.parse(content);
  } catch {
    return [];
  }
}

// Save questions to file
async function saveQuestions(questions: Question[]): Promise<void> {
  const dir = path.dirname(QUESTIONS_FILE);
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(QUESTIONS_FILE, JSON.stringify(questions, null, 2));
}

// Generate short ID
function generateId(): string {
  return `q-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
}

export const questionTools: ToolDefinition[] = [
  {
    name: 'devlog_question_add',
    title: 'Add Question',
    description: 'Add a question that needs to be answered during development. Questions are tracked and must be resolved.',
    inputSchema: {
      question: z.string().describe('The question to be answered'),
      context: z.string().optional().describe('Context about why this question is important'),
      priority: z.enum(['low', 'medium', 'high', 'blocker']).optional().default('medium')
        .describe('Priority level - blocker means work cannot continue'),
    },
    handler: async ({ question, context, priority = 'medium' }): Promise<CallToolResult> => {
      // Serialise the read-modify-write through the in-process mutex so that
      // concurrent calls don't clobber each other (BUG-20).
      const { newQuestion, openCount, blockerCount } = await withQuestionsLock(async () => {
        const questions = await loadQuestions();
        const q: Question = {
          id: generateId(),
          question,
          context,
          created_at: new Date().toISOString(),
          status: 'open',
          priority,
        };
        questions.push(q);
        await saveQuestions(questions);
        return {
          newQuestion: q,
          openCount: questions.filter(qq => qq.status === 'open').length,
          blockerCount: questions.filter(qq => qq.status === 'open' && qq.priority === 'blocker').length,
        };
      });

      // Also log to current workspace if active
      const workspace = await getCurrentWorkspace();
      if (workspace.exists && workspace.content) {
        const timestamp = new Date().toISOString().slice(11, 19);
        const priorityIcon = priority === 'blocker' ? '🚨' : priority === 'high' ? '❗' : '❓';
        const logEntry = `\n${priorityIcon} [${timestamp}] QUESTION: ${question}${context ? ` (Context: ${context})` : ''}\n`;
        await fs.appendFile(workspace.path, logEntry);
      }

      return {
        content: [
          {
            type: 'text',
            text: renderOutput({
              type: 'status-card',
              data: {
                title: 'Question Added',
                status: priority === 'blocker' ? 'warning' : 'success',
                message: question,
                details: {
                  'ID': newQuestion.id,
                  'Priority': priority.toUpperCase(),
                  'Open questions': `${openCount}${blockerCount > 0 ? ` (${blockerCount} blockers)` : ''}`,
                },
              },
            }),
          },
        ],
      };
    }
  },

  {
    name: 'devlog_question_answer',
    title: 'Answer Question',
    description: 'Mark a question as answered with the resolution',
    inputSchema: {
      id: z.string().optional().describe('Question ID to answer (or uses latest open question)'),
      answer: z.string().describe('The answer or resolution'),
    },
    handler: async ({ id, answer }): Promise<CallToolResult> => {
      // Serialise through the same mutex used by devlog_question_add (BUG-20).
      const result = await withQuestionsLock(async () => {
        const questions = await loadQuestions();

        // Find question by ID or get latest open question
        let question: Question | undefined;
        if (id) {
          question = questions.find(q => q.id === id);
        } else {
          // Get latest open question
          question = questions.filter(q => q.status === 'open').pop();
        }

        if (!question) {
          return { found: false as const, questionText: '', id };
        }

        // Update question
        question.status = 'answered';
        question.answered_at = new Date().toISOString();
        question.answer = answer;

        await saveQuestions(questions);

        return {
          found: true as const,
          questionText: question.question,
          questionCreatedAt: question.created_at,
          remainingOpen: questions.filter(q => q.status === 'open').length,
        };
      });

      if (!result.found) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Question Not Found',
                  status: 'error',
                  message: id ? `No question with ID: ${id}` : 'No open questions',
                },
              }),
            },
          ],
        };
      }

      // Log to workspace (outside mutex — file append is safe)
      const workspace = await getCurrentWorkspace();
      if (workspace.exists && workspace.content) {
        const timestamp = new Date().toISOString().slice(11, 19);
        const logEntry = `\n${icon('completed')} [${timestamp}] ANSWERED: ${result.questionText}\n   → ${answer}\n`;
        await fs.appendFile(workspace.path, logEntry);
      }

      const remainingOpen = result.remainingOpen;

      return {
        content: [
          {
            type: 'text',
            text: renderOutput({
              type: 'status-card',
              data: {
                title: 'Question Answered',
                status: 'success',
                message: result.questionText,
                details: {
                  'Answer': answer,
                  'Was open for': formatTimeSince(result.questionCreatedAt),
                  'Remaining open': `${remainingOpen} questions`,
                },
              },
            }),
          },
        ],
      };
    }
  },

  {
    name: 'devlog_question_list',
    title: 'List Questions',
    description: 'List all questions, optionally filtered by status',
    inputSchema: {
      status: z.enum(['open', 'answered', 'all']).optional().default('open')
        .describe('Filter by status'),
      includeAnswered: z.boolean().optional().default(false)
        .describe('Include answered questions in output'),
    },
    handler: async ({ status = 'open', includeAnswered = false }): Promise<CallToolResult> => {
      const questions = await loadQuestions();

      let filtered = questions;
      if (status === 'open') {
        filtered = questions.filter(q => q.status === 'open');
      } else if (status === 'answered') {
        filtered = questions.filter(q => q.status === 'answered');
      }

      if (filtered.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'No Questions',
                  status: 'info',
                  message: status === 'open' ? 'All questions have been answered!' : 'No questions found.',
                },
              }),
            },
          ],
        };
      }

      // Sort by priority (blockers first) then by date
      const priorityOrder = { blocker: 0, high: 1, medium: 2, low: 3 };
      filtered.sort((a, b) => {
        if (a.status === 'open' && b.status !== 'open') return -1;
        if (b.status === 'open' && a.status !== 'open') return 1;
        const pDiff = priorityOrder[a.priority] - priorityOrder[b.priority];
        if (pDiff !== 0) return pDiff;
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      });

      // Build output
      let output = `## ${icon('task')} Questions (${filtered.length})\n\n`;

      const blockers = filtered.filter(q => q.status === 'open' && q.priority === 'blocker');
      if (blockers.length > 0) {
        output += `### 🚨 BLOCKERS (${blockers.length})\n`;
        blockers.forEach(q => {
          output += `- **[${q.id}]** ${q.question}\n`;
          if (q.context) output += `  _Context: ${q.context}_\n`;
        });
        output += '\n';
      }

      const openNonBlockers = filtered.filter(q => q.status === 'open' && q.priority !== 'blocker');
      if (openNonBlockers.length > 0) {
        output += `### ${icon('warning')} Open Questions (${openNonBlockers.length})\n`;
        openNonBlockers.forEach(q => {
          const priorityIcon = q.priority === 'high' ? '❗' : q.priority === 'low' ? '○' : '•';
          output += `- ${priorityIcon} **[${q.id}]** ${q.question} _(${q.priority})_\n`;
          if (q.context) output += `  _Context: ${q.context}_\n`;
        });
        output += '\n';
      }

      if (includeAnswered || status === 'answered' || status === 'all') {
        const answered = filtered.filter(q => q.status === 'answered');
        if (answered.length > 0) {
          output += `### ${icon('completed')} Answered (${answered.length})\n`;
          answered.slice(0, 10).forEach(q => {
            output += `- ~~${q.question}~~\n`;
            output += `  → ${q.answer}\n`;
          });
          if (answered.length > 10) {
            output += `\n_...and ${answered.length - 10} more answered questions_\n`;
          }
        }
      }

      return {
        content: [
          {
            type: 'text',
            text: output,
          },
        ],
      };
    }
  },

  {
    name: 'devlog_question_check',
    title: 'Check Questions',
    description: 'Check if there are any blocking questions that need answers before proceeding',
    inputSchema: {},
    handler: async (): Promise<CallToolResult> => {
      const questions = await loadQuestions();
      const open = questions.filter(q => q.status === 'open');
      const blockers = open.filter(q => q.priority === 'blocker');

      if (blockers.length > 0) {
        let output = `## 🚨 BLOCKED: ${blockers.length} question(s) must be answered\n\n`;
        blockers.forEach(q => {
          output += `### ${q.question}\n`;
          if (q.context) output += `_Context: ${q.context}_\n`;
          output += `ID: \`${q.id}\` | Use \`devlog_question_answer\` to resolve\n\n`;
        });

        return {
          content: [
            {
              type: 'text',
              text: output,
            },
          ],
        };
      }

      if (open.length > 0) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Questions Pending',
                  status: 'warning',
                  message: `${open.length} open question(s), but none are blocking`,
                  details: {
                    'High priority': open.filter(q => q.priority === 'high').length.toString(),
                    'Medium priority': open.filter(q => q.priority === 'medium').length.toString(),
                    'Low priority': open.filter(q => q.priority === 'low').length.toString(),
                  },
                },
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: 'text',
            text: renderOutput({
              type: 'status-card',
              data: {
                title: 'All Clear',
                status: 'success',
                message: 'No open questions. Ready to proceed!',
              },
            }),
          },
        ],
      };
    }
  },
];

// Helper to format time since
function formatTimeSince(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  const diffMins = Math.floor(diffMs / 60000);

  if (diffMins < 60) return `${diffMins}m`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h`;
  const diffDays = Math.floor(diffHours / 24);
  return `${diffDays}d`;
}
