import { describe, expect, it } from '@jest/globals';
import { renderMarkdown, plainToLines, lineText, type MdLine } from './markdown-ansi.js';

describe('plainToLines', () => {
  it('maps each line to a single unstyled span', () => {
    expect(plainToLines('a\nb')).toEqual([[{ text: 'a' }], [{ text: 'b' }]]);
  });
});

describe('renderMarkdown', () => {
  it('styles headings cyan, h1/h2 bold', () => {
    const [h1] = renderMarkdown('# Title');
    expect(lineText(h1)).toBe('# Title');
    expect(h1.some((s) => s.color === 'cyan' && s.bold === true)).toBe(true);
    const [h3] = renderMarkdown('### Sub');
    expect(h3.some((s) => s.color === 'cyan' && s.bold !== true)).toBe(true);
  });

  it('renders checkboxes with ☐/☑ and dims completed items', () => {
    const lines = renderMarkdown('- [ ] open\n- [x] done');
    expect(lineText(lines[0])).toBe('☐ open');
    expect(lines[0].some((s) => s.text === '☐ ' && s.color === 'yellow')).toBe(true);
    expect(lineText(lines[1])).toBe('☑ done');
    expect(lines[1].some((s) => s.text === '☑ ' && s.color === 'green')).toBe(true);
    expect(lines[1].filter((s) => s.text === 'done').every((s) => s.dim === true)).toBe(true);
  });

  it('renders list bullets, bold and inline code spans', () => {
    const [li] = renderMarkdown('- has **bold** and `code`');
    expect(lineText(li)).toBe('• has bold and code');
    expect(li.some((s) => s.text === 'bold' && s.bold === true)).toBe(true);
    expect(li.some((s) => s.text === 'code' && s.color === 'yellow')).toBe(true);
  });

  it('parses bold content containing single asterisks', () => {
    const [line] = renderMarkdown('**O(n*m)** x');
    expect(line.some((s) => s.text === 'O(n*m)' && s.bold === true)).toBe(true);
  });

  it('colors fenced code blocks and toggles correctly', () => {
    const lines = renderMarkdown('```\nx = 1\n```\nafter');
    expect(lines[1].every((s) => s.color === 'yellow')).toBe(true);
    expect(lines[3].every((s) => s.color === undefined)).toBe(true);
  });

  it('dims YAML frontmatter at the top of the file', () => {
    const lines = renderMarkdown('---\ntitle: x\n---\nbody');
    expect(lines[1].every((s) => s.dim === true)).toBe(true);
    expect(lines[3].every((s) => s.dim !== true)).toBe(true);
  });

  it('never throws on malformed input and preserves text verbatim', () => {
    const nasty = '**unclosed\n` `` ``` ````\n- [z] weird\n ';
    const lines: MdLine[] = renderMarkdown(nasty);
    expect(lines.map(lineText).join('\n')).toContain('**unclosed');
    expect(lines).toHaveLength(nasty.split('\n').length);
  });

  it('empty string yields a single empty line', () => {
    expect(renderMarkdown('').map(lineText)).toEqual(['']);
  });
});
