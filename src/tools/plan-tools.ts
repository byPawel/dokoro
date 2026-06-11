import { z } from 'zod';
import { promises as fs } from 'fs';
import path from 'path';
import { ToolDefinition } from './registry.js';
import { getCurrentWorkspace } from '../utils/workspace.js';
import { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { DOKORO_PATH } from '../types/dokoro.js';
import { renderOutput } from '../utils/render-output.js';
import { icon } from '../utils/icons.js';
import { formatTimestampSlug } from '../utils/timestamp.js';
import { archivePlan, findInArchive, writeFileAtomic, PlansIndex, PlanIndexEntry } from '../utils/archive.js';

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

// Load plans index. Live entries are bare title strings; archived entries
// are `{ title, archived, archive_path }` objects (see src/utils/archive.ts).
async function loadPlansIndex(): Promise<PlansIndex> {
  try {
    const content = await fs.readFile(PLANS_INDEX, 'utf-8');
    return JSON.parse(content);
  } catch {
    return {};
  }
}

// Save plans index (temp-file + atomic rename, same as archive.ts's index writes,
// so a crash mid-write can never leave a truncated index.json behind).
async function savePlansIndex(index: PlansIndex): Promise<void> {
  await fs.mkdir(PLANS_DIR, { recursive: true });
  await writeFileAtomic(PLANS_INDEX, JSON.stringify(index, null, 2));
}

/** Where a plan was found: live in `.mcp/plans/` or in the read-only archive. */
interface PlanLocation {
  plan: Plan;
  archived: boolean;
  /** Path relative to `.mcp/plans/` when archived (e.g. `archive/2026-06/<id>.json`). */
  archivePath?: string;
}

/** True for index entries that archivePlan upgraded to archived metadata. */
function isArchivedEntry(entry: PlanIndexEntry | undefined): boolean {
  return typeof entry === 'object' && entry !== null && entry.archived === true;
}

async function readPlanFile(planPath: string): Promise<Plan | null> {
  try {
    return JSON.parse(await fs.readFile(planPath, 'utf-8')) as Plan;
  } catch {
    return null;
  }
}

/**
 * Load a plan, falling back to the archive: live file first, then the index's
 * `archive_path`, then a scan of the archive partitions (heals the crash
 * window where the file moved but the index write was lost). Archived plans
 * are READ-ONLY — write tools must check `archived` and refuse.
 */
async function loadPlanWithLocation(planId: string): Promise<PlanLocation | null> {
  const live = await readPlanFile(path.join(PLANS_DIR, `${planId}.json`));
  if (live) return { plan: live, archived: false };

  const entry = (await loadPlansIndex())[planId];
  const candidates: string[] = [];
  if (typeof entry === 'object' && entry !== null && typeof entry.archive_path === 'string') {
    candidates.push(entry.archive_path);
  }
  const scanned = await findInArchive(planId);
  if (scanned && !candidates.includes(scanned)) candidates.push(scanned);

  for (const archivePath of candidates) {
    const plan = await readPlanFile(path.join(PLANS_DIR, archivePath));
    if (plan) return { plan, archived: true, archivePath };
  }
  return null;
}

/** Find the most recent live (non-archived) plan matching the given statuses. */
async function findLatestLivePlan(allowedStatuses: Plan['status'][]): Promise<Plan | null> {
  const index = await loadPlansIndex();
  for (const id of Object.keys(index).reverse()) {
    if (isArchivedEntry(index[id])) continue;
    const located = await loadPlanWithLocation(id);
    // `!archived` belt: covers the crash window where the index entry is
    // still a bare string but the plan file already moved to the archive.
    if (located && !located.archived && allowedStatuses.includes(located.plan.status)) {
      return located.plan;
    }
  }
  return null;
}

/** Archived plans are read-only — write tools refuse with this error. */
function archivedPlanError(planId: string, archivePath?: string): CallToolResult {
  const location = archivePath ? ` at \`.mcp/plans/${archivePath}\`` : '';
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: `Plan ${planId} is archived and read-only${location}. Archived plans cannot be modified — create a new plan instead.`,
      },
    ],
  };
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

/**
 * Sortable, human-readable plan id: `plan-<YYYY-MM-DD-HHhMM-dayname>-<title-slug>`
 * (e.g. `plan-2026-06-11-23h10-thursday-supertemplates-growth`). The timestamp
 * prefix sorts chronologically as a plain string, matching the daily-file slug
 * convention. Old base36 ids (`plan-mq5kmgs2`) keep working — the index and
 * archive treat ids as opaque strings.
 */
function generateId(title: string): string {
  const slug = title.toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .substring(0, 40);
  const stamp = formatTimestampSlug(new Date());
  return slug === '' ? `plan-${stamp}` : `plan-${stamp}-${slug}`;
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
        id: generateId(title),
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
      // Find plan (archived plans are read-only — refuse writes)
      let plan: Plan | null = null;
      if (planId) {
        const located = await loadPlanWithLocation(planId);
        if (located?.archived) return archivedPlanError(planId, located.archivePath);
        plan = located?.plan ?? null;
      } else {
        plan = await findLatestLivePlan(['active']);
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
      // Find plan (same logic as plan_check; archived plans are read-only)
      let plan: Plan | null = null;
      if (planId) {
        const located = await loadPlanWithLocation(planId);
        if (located?.archived) return archivedPlanError(planId, located.archivePath);
        plan = located?.plan ?? null;
      } else {
        plan = await findLatestLivePlan(['active']);
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
      // Find plan (an archived plan is already finalized — refuse re-validation)
      let plan: Plan | null = null;
      if (planId) {
        const located = await loadPlanWithLocation(planId);
        if (located?.archived) return archivedPlanError(planId, located.archivePath);
        plan = located?.plan ?? null;
      } else {
        plan = await findLatestLivePlan(['active', 'completed']);
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

      const nowDate = new Date();
      const now = nowDate.toISOString();
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
      // Standard UTC timestamp slug prefix + distinguishing `-validation-<planId>` suffix.
      // (Previously `<planId>-validation-YYYY-MM-DD.md`; nothing reads these by pattern.)
      const reportFilename = `${formatTimestampSlug(nowDate)}-validation-${plan.id}.md`;
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

      // Auto-archive validated plans so `.mcp/plans/` stays live-work-only.
      // Non-fatal: a failed archive is reported as a warning, never an error
      // (the plan is saved and the report written either way).
      let archiveNote = '';
      if (plan.status === 'validated') {
        const archived = await archivePlan(plan.id);
        archiveNote = archived.ok
          ? `\n📦 **Plan archived to:** \`.mcp/plans/${archived.archivePath}\` (still listed via dokoro_plan_list)`
          : `\n${icon('warning')} Plan archive failed (plan stays live): ${archived.error}`;
      }

      return {
        content: [
          {
            type: 'text',
            text: validationTable + `\n\n📄 **Report saved to:** \`${reportPath}\`` + archiveNote,
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
      // Find plan (read path — archived plans resolve too, marked read-only)
      let located: PlanLocation | null = null;
      if (planId) {
        located = await loadPlanWithLocation(planId);
      } else {
        const index = await loadPlansIndex();
        const planIds = Object.keys(index);
        for (const id of planIds.reverse()) {
          located = await loadPlanWithLocation(id);
          if (located) break;
        }
      }
      const plan: Plan | null = located?.plan ?? null;

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
      let output = `## ${icon('task')} ${plan.title}${located?.archived ? ' (archived)' : ''}\n\n`;
      output += `**Status:** ${plan.status.toUpperCase()}\n`;
      if (located?.archived) {
        output += `**Archived:** yes — \`.mcp/plans/${located.archivePath}\` (read-only)\n`;
      }
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

      // Archived plans stay listed (read-only, marked), AFTER live plans.
      const liveRows: string[] = [];
      const archivedRows: string[] = [];
      for (const id of planIds.reverse()) {
        const located = await loadPlanWithLocation(id);
        if (!located) continue;
        const { plan, archived } = located;
        if (status !== 'all' && plan.status !== status) continue;

        const statusIcon = {
          draft: '📝',
          active: '🔄',
          completed: '✅',
          validated: '✓',
          failed: '❌',
        }[plan.status];

        const row = `| ${statusIcon} ${plan.status} | ${plan.title}${archived ? ' (archived)' : ''} | ${plan.completion_percentage}% | ${new Date(plan.created_at).toLocaleDateString()} |\n`;
        (archived ? archivedRows : liveRows).push(row);
      }
      output += liveRows.join('') + archivedRows.join('');

      return {
        content: [{ type: 'text', text: output }],
      };
    }
  },
];
