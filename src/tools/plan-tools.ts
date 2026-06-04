import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import { ToolDefinition } from './registry.js';
import { getCurrentWorkspace } from '../utils/workspace.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DOKORO_PATH } from '../types/devlog.js';
import { renderOutput } from '../utils/render-output.js';
import { icon } from '../utils/icons.js';

// Plan item interface
interface PlanItem {
  id: string;
  text: string;
  completed: boolean;
  created_at: string;
  completed_at?: string;
  notes?: string;
  blockers?: string[];
}

// Plan interface
interface Plan {
  id: string;
  title: string;
  description?: string;
  items: PlanItem[];
  created_at: string;
  updated_at: string;
  validated_at?: string;
  validation_notes?: string;
  status: 'draft' | 'active' | 'completed' | 'validated' | 'failed';
  completion_percentage: number;
}

// Plans storage path
const PLANS_DIR = path.join(DOKORO_PATH, '.mcp', 'plans');
const PLANS_INDEX = path.join(PLANS_DIR, 'index.json');

// Load plans index
async function loadPlansIndex(): Promise<Record<string, string>> {
  try {
    const content = await fs.readFile(PLANS_INDEX, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

// Save plans index
async function savePlansIndex(index: Record<string, string>): Promise<void> {
  await fs.mkdir(PLANS_DIR, { recursive: true });
  await fs.writeFile(PLANS_INDEX, JSON.stringify(index, null, 2));
}

// Load a specific plan
async function loadPlan(planId: string): Promise<Plan | null> {
  try {
    const planPath = path.join(PLANS_DIR, `${planId}.json`);
    const content = await fs.readFile(planPath, 'utf-8');
    return JSON.parse(content);
  } catch {
    return null;
  }
}

// Save a plan
async function savePlan(plan: Plan): Promise<void> {
  await fs.mkdir(PLANS_DIR, { recursive: true });
  const planPath = path.join(PLANS_DIR, `${plan.id}.json`);
  await fs.writeFile(planPath, JSON.stringify(plan, null, 2));

  // Update index
  const index = await loadPlansIndex();
  index[plan.id] = plan.title;
  await savePlansIndex(index);
}

// Generate short ID
function generateId(): string {
  return `plan-${Date.now().toString(36)}`;
}

// Calculate completion percentage
function calculateCompletion(items: PlanItem[]): number {
  if (items.length === 0) return 0;
  const completed = items.filter(i => i.completed).length;
  return Math.round((completed / items.length) * 100);
}

// Format duration between two dates
function formatDuration(start: string, end: string): string {
  const ms = new Date(end).getTime() - new Date(start).getTime();
  const mins = Math.floor(ms / 60000);
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}

// Generate validation table
function generateValidationTable(plan: Plan): string {
  let table = `\n## ${icon('chart')} Plan Validation Report\n\n`;
  table += `**Plan:** ${plan.title}\n`;
  table += `**Status:** ${plan.status.toUpperCase()}\n`;
  table += `**Completion:** ${plan.completion_percentage}%\n`;
  table += `**Created:** ${new Date(plan.created_at).toLocaleString()}\n`;
  if (plan.validated_at) {
    table += `**Validated:** ${new Date(plan.validated_at).toLocaleString()}\n`;
    table += `**Total Duration:** ${formatDuration(plan.created_at, plan.validated_at)}\n`;
  }
  table += '\n';

  // Items table
  table += '| # | Task | Status | Completed At | Duration |\n';
  table += '|---|------|--------|--------------|----------|\n';

  plan.items.forEach((item, idx) => {
    const status = item.completed ? '✅' : '❌';
    const completedAt = item.completed_at
      ? new Date(item.completed_at).toLocaleString()
      : '-';
    const duration = item.completed_at
      ? formatDuration(item.created_at, item.completed_at)
      : '-';
    const text = item.text.length > 40 ? item.text.substring(0, 40) + '...' : item.text;
    table += `| ${idx + 1} | ${text} | ${status} | ${completedAt} | ${duration} |\n`;
  });

  // Summary
  const completed = plan.items.filter(i => i.completed).length;
  const total = plan.items.length;
  const pending = total - completed;

  table += '\n### Summary\n';
  table += `- ${icon('completed')} **Completed:** ${completed}/${total}\n`;
  if (pending > 0) {
    table += `- ${icon('warning')} **Pending:** ${pending}\n`;
    table += '\n**Incomplete items:**\n';
    plan.items.filter(i => !i.completed).forEach(item => {
      table += `- [ ] ${item.text}\n`;
      if (item.blockers?.length) {
        item.blockers.forEach(b => table += `  - ⛔ Blocker: ${b}\n`);
      }
    });
  }

  if (plan.validation_notes) {
    table += `\n### Validation Notes\n${plan.validation_notes}\n`;
  }

  return table;
}

export const planTools: ToolDefinition[] = [
  {
    name: 'dokoro_plan_create',
    title: 'Create Plan',
    description: 'Create a new plan with trackable items. Each item gets timestamped when completed.',
    inputSchema: {
      title: z.string().describe('Plan title'),
      items: z.array(z.string()).describe('List of plan items/tasks'),
      description: z.string().optional().describe('Plan description'),
    },
    handler: async ({ title, items, description }): Promise<CallToolResult> => {
      const now = new Date().toISOString();
      const plan: Plan = {
        id: generateId(),
        title,
        description,
        items: items.map((text: string, idx: number) => ({
          id: `item-${idx}`,
          text,
          completed: false,
          created_at: now,
        })),
        created_at: now,
        updated_at: now,
        status: 'active',
        completion_percentage: 0,
      };

      await savePlan(plan);

      // Log to workspace
      const workspace = await getCurrentWorkspace();
      if (workspace.exists && workspace.content) {
        const timestamp = new Date().toISOString().slice(11, 19);
        let logEntry = `\n${icon('task')} [${timestamp}] PLAN CREATED: ${title}\n`;
        items.forEach((item: string, idx: number) => {
          logEntry += `   ${idx + 1}. [ ] ${item}\n`;
        });
        await fs.writeFile(workspace.path, workspace.content + logEntry);
      }

      return {
        content: [
          {
            type: 'text',
            text: renderOutput({
              type: 'status-card',
              data: {
                title: 'Plan Created',
                status: 'success',
                message: title,
                details: {
                  'Plan ID': plan.id,
                  'Items': `${items.length} tasks`,
                  'Status': 'ACTIVE',
                },
              },
            }),
          },
        ],
      };
    }
  },

  {
    name: 'dokoro_plan_check',
    title: 'Check Plan Item',
    description: 'Mark a plan item as completed with timestamp. Can also add notes or blockers.',
    inputSchema: {
      planId: z.string().optional().describe('Plan ID (uses latest active plan if not specified)'),
      itemIndex: z.number().describe('Item index (1-based) to check off'),
      notes: z.string().optional().describe('Notes about completion'),
      uncheck: z.boolean().optional().default(false).describe('Uncheck instead of check'),
    },
    handler: async ({ planId, itemIndex, notes, uncheck = false }): Promise<CallToolResult> => {
      // Find plan
      let plan: Plan | null = null;
      if (planId) {
        plan = await loadPlan(planId);
      } else {
        // Get latest active plan
        const index = await loadPlansIndex();
        const planIds = Object.keys(index);
        for (const id of planIds.reverse()) {
          const p = await loadPlan(id);
          if (p && p.status === 'active') {
            plan = p;
            break;
          }
        }
      }

      if (!plan) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Plan Not Found',
                  status: 'error',
                  message: planId ? `No plan with ID: ${planId}` : 'No active plans',
                },
              }),
            },
          ],
        };
      }

      // Validate item index
      const idx = itemIndex - 1;
      if (idx < 0 || idx >= plan.items.length) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Invalid Item',
                  status: 'error',
                  message: `Item ${itemIndex} not found. Plan has ${plan.items.length} items.`,
                },
              }),
            },
          ],
        };
      }

      // Update item
      const item = plan.items[idx];
      const now = new Date().toISOString();

      if (uncheck) {
        item.completed = false;
        item.completed_at = undefined;
      } else {
        item.completed = true;
        item.completed_at = now;
      }

      if (notes) {
        item.notes = notes;
      }

      // Update plan
      plan.updated_at = now;
      plan.completion_percentage = calculateCompletion(plan.items);

      // Auto-complete plan if all items done
      if (plan.completion_percentage === 100) {
        plan.status = 'completed';
      }

      await savePlan(plan);

      // Log to workspace
      const workspace = await getCurrentWorkspace();
      if (workspace.exists && workspace.content) {
        const timestamp = new Date().toISOString().slice(11, 19);
        const action = uncheck ? 'UNCHECKED' : 'COMPLETED';
        let logEntry = `\n${uncheck ? icon('warning') : icon('completed')} [${timestamp}] ${action}: ${item.text}\n`;
        if (notes) logEntry += `   Note: ${notes}\n`;
        await fs.writeFile(workspace.path, workspace.content + logEntry);
      }

      return {
        content: [
          {
            type: 'text',
            text: renderOutput({
              type: 'status-card',
              data: {
                title: uncheck ? 'Item Unchecked' : 'Item Completed',
                status: 'success',
                message: item.text,
                details: {
                  'Plan': plan.title,
                  'Progress': `${plan.completion_percentage}% (${plan.items.filter(i => i.completed).length}/${plan.items.length})`,
                  'Time': item.completed_at ? formatDuration(item.created_at, item.completed_at) : '-',
                },
              },
            }),
          },
        ],
      };
    }
  },

  {
    name: 'dokoro_plan_blocker',
    title: 'Add Blocker',
    description: 'Add a blocker to a plan item explaining why it cannot be completed',
    inputSchema: {
      planId: z.string().optional().describe('Plan ID'),
      itemIndex: z.number().describe('Item index (1-based)'),
      blocker: z.string().describe('Description of the blocker'),
    },
    handler: async ({ planId, itemIndex, blocker }): Promise<CallToolResult> => {
      // Find plan (same logic as plan_check)
      let plan: Plan | null = null;
      if (planId) {
        plan = await loadPlan(planId);
      } else {
        const index = await loadPlansIndex();
        const planIds = Object.keys(index);
        for (const id of planIds.reverse()) {
          const p = await loadPlan(id);
          if (p && p.status === 'active') {
            plan = p;
            break;
          }
        }
      }

      if (!plan) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Plan Not Found',
                  status: 'error',
                  message: 'No active plan found',
                },
              }),
            },
          ],
        };
      }

      const idx = itemIndex - 1;
      if (idx < 0 || idx >= plan.items.length) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Invalid Item',
                  status: 'error',
                  message: `Item ${itemIndex} not found`,
                },
              }),
            },
          ],
        };
      }

      const item = plan.items[idx];
      item.blockers = item.blockers || [];
      item.blockers.push(blocker);
      plan.updated_at = new Date().toISOString();

      await savePlan(plan);

      // Log to workspace
      const workspace = await getCurrentWorkspace();
      if (workspace.exists && workspace.content) {
        const timestamp = new Date().toISOString().slice(11, 19);
        const logEntry = `\n⛔ [${timestamp}] BLOCKER on "${item.text}": ${blocker}\n`;
        await fs.writeFile(workspace.path, workspace.content + logEntry);
      }

      return {
        content: [
          {
            type: 'text',
            text: renderOutput({
              type: 'status-card',
              data: {
                title: 'Blocker Added',
                status: 'warning',
                message: blocker,
                details: {
                  'Item': item.text,
                  'Total blockers': item.blockers.length.toString(),
                },
              },
            }),
          },
        ],
      };
    }
  },

  {
    name: 'dokoro_plan_validate',
    title: 'Validate Plan',
    description: 'Validate and finalize a plan. Generates a timestamped report table showing completion status of all items.',
    inputSchema: {
      planId: z.string().optional().describe('Plan ID (uses latest if not specified)'),
      notes: z.string().optional().describe('Validation notes'),
      requireComplete: z.boolean().optional().default(false)
        .describe('Fail validation if not 100% complete'),
    },
    handler: async ({ planId, notes, requireComplete = false }): Promise<CallToolResult> => {
      // Find plan
      let plan: Plan | null = null;
      if (planId) {
        plan = await loadPlan(planId);
      } else {
        const index = await loadPlansIndex();
        const planIds = Object.keys(index);
        for (const id of planIds.reverse()) {
          const p = await loadPlan(id);
          if (p && (p.status === 'active' || p.status === 'completed')) {
            plan = p;
            break;
          }
        }
      }

      if (!plan) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'Plan Not Found',
                  status: 'error',
                  message: 'No plan to validate',
                },
              }),
            },
          ],
        };
      }

      const now = new Date().toISOString();
      plan.validated_at = now;
      plan.validation_notes = notes;
      plan.updated_at = now;

      // Determine validation status
      if (plan.completion_percentage === 100) {
        plan.status = 'validated';
      } else if (requireComplete) {
        plan.status = 'failed';
      } else {
        plan.status = 'validated'; // Partial completion allowed
      }

      await savePlan(plan);

      // Generate validation table
      const validationTable = generateValidationTable(plan);

      // Save validation report to file
      const reportFilename = `${plan.id}-validation-${now.split('T')[0]}.md`;
      const reportPath = path.join(DOKORO_PATH, 'daily', reportFilename);
      await fs.mkdir(path.dirname(reportPath), { recursive: true });

      let reportContent = '---\n';
      reportContent += `title: "Plan Validation: ${plan.title}"\n`;
      reportContent += `date: "${now}"\n`;
      reportContent += `plan_id: "${plan.id}"\n`;
      reportContent += `status: "${plan.status}"\n`;
      reportContent += `completion: ${plan.completion_percentage}\n`;
      reportContent += 'tags:\n';
      reportContent += '  type: validation\n';
      reportContent += `  result: ${plan.status}\n`;
      reportContent += '---\n';
      reportContent += validationTable;

      await fs.writeFile(reportPath, reportContent);

      // Log to workspace
      const workspace = await getCurrentWorkspace();
      if (workspace.exists && workspace.content) {
        const timestamp = new Date().toISOString().slice(11, 19);
        const statusIcon = plan.status === 'validated' ? icon('completed') : icon('warning');
        let logEntry = `\n${statusIcon} [${timestamp}] PLAN VALIDATED: ${plan.title}\n`;
        logEntry += `   Result: ${plan.status.toUpperCase()} (${plan.completion_percentage}%)\n`;
        logEntry += `   Report: ${reportFilename}\n`;
        await fs.writeFile(workspace.path, workspace.content + logEntry);
      }

      return {
        content: [
          {
            type: 'text',
            text: validationTable + `\n\n📄 **Report saved to:** \`${reportPath}\``,
          },
        ],
      };
    }
  },

  {
    name: 'dokoro_plan_status',
    title: 'Plan Status',
    description: 'Show current status of a plan with progress',
    inputSchema: {
      planId: z.string().optional().describe('Plan ID (shows latest if not specified)'),
    },
    handler: async ({ planId }): Promise<CallToolResult> => {
      // Find plan
      let plan: Plan | null = null;
      if (planId) {
        plan = await loadPlan(planId);
      } else {
        const index = await loadPlansIndex();
        const planIds = Object.keys(index);
        for (const id of planIds.reverse()) {
          const p = await loadPlan(id);
          if (p) {
            plan = p;
            break;
          }
        }
      }

      if (!plan) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'No Plans',
                  status: 'info',
                  message: 'No plans found. Use dokoro_plan_create to create one.',
                },
              }),
            },
          ],
        };
      }

      // Build status output
      let output = `## ${icon('task')} ${plan.title}\n\n`;
      output += `**Status:** ${plan.status.toUpperCase()}\n`;
      output += `**Progress:** ${plan.completion_percentage}% (${plan.items.filter(i => i.completed).length}/${plan.items.length})\n`;
      output += `**Created:** ${new Date(plan.created_at).toLocaleString()}\n`;
      output += `**Updated:** ${new Date(plan.updated_at).toLocaleString()}\n\n`;

      // Progress bar
      const barLength = 20;
      const filled = Math.round((plan.completion_percentage / 100) * barLength);
      const empty = barLength - filled;
      output += `[${'█'.repeat(filled)}${'░'.repeat(empty)}] ${plan.completion_percentage}%\n\n`;

      // Items list
      output += '### Tasks\n';
      plan.items.forEach((item, idx) => {
        const checkbox = item.completed ? '[x]' : '[ ]';
        const time = item.completed_at
          ? ` ✓ ${new Date(item.completed_at).toLocaleTimeString()}`
          : '';
        output += `${idx + 1}. ${checkbox} ${item.text}${time}\n`;
        if (item.blockers?.length) {
          item.blockers.forEach(b => output += `   ⛔ ${b}\n`);
        }
        if (item.notes) {
          output += `   📝 ${item.notes}\n`;
        }
      });

      return {
        content: [{ type: 'text', text: output }],
      };
    }
  },

  {
    name: 'dokoro_plan_list',
    title: 'List Plans',
    description: 'List all plans with their status',
    inputSchema: {
      status: z.enum(['all', 'active', 'completed', 'validated']).optional().default('all'),
    },
    handler: async ({ status = 'all' }): Promise<CallToolResult> => {
      const index = await loadPlansIndex();
      const planIds = Object.keys(index);

      if (planIds.length === 0) {
        return {
          content: [
            {
              type: 'text',
              text: renderOutput({
                type: 'status-card',
                data: {
                  title: 'No Plans',
                  status: 'info',
                  message: 'No plans created yet.',
                },
              }),
            },
          ],
        };
      }

      let output = `## ${icon('task')} Plans\n\n`;
      output += '| Status | Plan | Progress | Created |\n';
      output += '|--------|------|----------|----------|\n';

      for (const id of planIds.reverse()) {
        const plan = await loadPlan(id);
        if (!plan) continue;
        if (status !== 'all' && plan.status !== status) continue;

        const statusIcon = {
          draft: '📝',
          active: '🔄',
          completed: '✅',
          validated: '✓',
          failed: '❌',
        }[plan.status];

        output += `| ${statusIcon} ${plan.status} | ${plan.title} | ${plan.completion_percentage}% | ${new Date(plan.created_at).toLocaleDateString()} |\n`;
      }

      return {
        content: [{ type: 'text', text: output }],
      };
    }
  },
];
