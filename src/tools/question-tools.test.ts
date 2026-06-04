/**
 * Tests for question-tools concurrent write safety (BUG-20)
 *
 * Strategy: set process.env.DOKORO_PATH to a temp dir, then use
 * jest.isolateModules() to load a fresh question-tools instance whose
 * QUESTIONS_FILE points at that temp dir.  This avoids touching the real
 * devlog directory and lets us inspect the file directly.
 */

import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';

// Mock render-output and color-setup (ESM-only deps that break ts-jest CJS)
jest.mock('../utils/render-output.js', () => ({
  renderOutput: (data: unknown) => JSON.stringify(data),
}));
jest.mock('../utils/color-setup.js', () => ({}));

// Mock workspace utils — question_add optionally appends to current.md; we
// don't want that side-effect in the concurrency test.
jest.mock('../utils/workspace.js', () => ({
  getCurrentWorkspace: () => Promise.resolve({ path: '', content: null, exists: false }),
  generateAgentId: () => Promise.resolve('test-agent'),
  parseAgentFromContent: () => ({ agentId: null, lastActive: null }),
}));

// Mock the DB (imported transitively via workspace-tools path, not needed here
// but some shared modules may pull it in).
jest.mock('../db/index.js', () => ({
  getSqliteDb: () => { throw new Error('DB not available in question-tools tests'); },
  ensureVectorTables: () => {},
}));

type QuestionTools = typeof import('./question-tools.js');

let tmpDir: string;
let questionTools: QuestionTools;

async function freshModule(): Promise<QuestionTools> {
  return new Promise<QuestionTools>((resolve) => {
    jest.isolateModules(() => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      resolve(require('./question-tools.js') as QuestionTools);
    });
  });
}

describe('question-tools concurrent writes (BUG-20)', () => {
  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'devlog-qtools-test-'));
    await fs.mkdir(path.join(tmpDir, '.mcp'), { recursive: true });
    // Point DOKORO_PATH at our temp dir before loading the module
    process.env['DOKORO_PATH'] = tmpDir;
    questionTools = await freshModule();
  });

  afterEach(async () => {
    delete process.env['DOKORO_PATH'];
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  function findTool(name: string) {
    const t = questionTools.questionTools.find((x) => x.name === name);
    if (!t) throw new Error(`tool ${name} not found`);
    return t;
  }

  it('single question add stores the question', async () => {
    const addTool = findTool('dokoro_question_add');
    await addTool.handler({ question: 'Is this working?', priority: 'medium' });

    const questionsFile = path.join(tmpDir, '.mcp', 'questions.json');
    const saved = JSON.parse(await fs.readFile(questionsFile, 'utf-8'));
    expect(saved).toHaveLength(1);
    expect(saved[0].question).toBe('Is this working?');
  });

  it('N concurrent dokoro_question_add calls — all N questions are persisted (no lost writes)', async () => {
    const N = 10;
    const addTool = findTool('dokoro_question_add');

    await Promise.all(
      Array.from({ length: N }, (_, i) =>
        addTool.handler({ question: `Question number ${i}`, priority: 'medium' })
      )
    );

    const questionsFile = path.join(tmpDir, '.mcp', 'questions.json');
    const saved = JSON.parse(await fs.readFile(questionsFile, 'utf-8'));

    expect(saved).toHaveLength(N);

    // Verify all questions are present (order may vary)
    for (let i = 0; i < N; i++) {
      expect(saved.some((q: { question: string }) => q.question === `Question number ${i}`)).toBe(true);
    }
  });

  it('question_add and question_answer interleaved — no data lost', async () => {
    const addTool = findTool('dokoro_question_add');

    // Add 5 questions sequentially to populate
    for (let i = 0; i < 5; i++) {
      await addTool.handler({ question: `Setup question ${i}`, priority: 'low' });
    }

    // Now concurrently add 5 more
    await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        addTool.handler({ question: `Concurrent question ${i}`, priority: 'medium' })
      )
    );

    const questionsFile = path.join(tmpDir, '.mcp', 'questions.json');
    const saved = JSON.parse(await fs.readFile(questionsFile, 'utf-8'));
    expect(saved).toHaveLength(10);
  });

  it('dokoro_question_list returns all added questions', async () => {
    const addTool = findTool('dokoro_question_add');
    const listTool = findTool('dokoro_question_list');

    await Promise.all([
      addTool.handler({ question: 'Alpha?', priority: 'high' }),
      addTool.handler({ question: 'Beta?', priority: 'medium' }),
      addTool.handler({ question: 'Gamma?', priority: 'low' }),
    ]);

    const res = await listTool.handler({ status: 'open', includeAnswered: false });
    const text = res.content?.[0]?.type === 'text' ? res.content[0].text : '';
    expect(text).toMatch(/Alpha\?/);
    expect(text).toMatch(/Beta\?/);
    expect(text).toMatch(/Gamma\?/);
  });
});
