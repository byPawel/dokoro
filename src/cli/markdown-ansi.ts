/**
 * Pure markdown → terminal-span renderer for the browse TUI. NO ink imports.
 *
 * Output is a span model (`MdLine = MdSpan[]`), never raw ANSI: the preview
 * viewport slices the line array for scrolling, and slicing ANSI strings can
 * split escape sequences and leak styles across rows. Each line is fully
 * self-contained. Unknown syntax renders as plain text; never throws.
 */

export interface MdSpan {
  text: string;
  color?: string;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
}

export type MdLine = MdSpan[];

/** Plain text → one unstyled span per line (for non-markdown content). */
export function plainToLines(text: string): MdLine[] {
  return text.split('\n').map((line) => [{ text: line }]);
}

/** Concatenated text of a line — used for diffing and width math. */
export function lineText(line: MdLine): string {
  return line.map((s) => s.text).join('');
}

const INLINE_TOKEN = /(`[^`]+`|\*\*[^*]+\*\*)/;

/** Inline pass: `code` → yellow, **bold** → bold. No nesting; junk stays plain. */
function parseInline(text: string): MdSpan[] {
  const spans: MdSpan[] = [];
  let rest = text;
  while (rest !== '') {
    const m = INLINE_TOKEN.exec(rest);
    if (m === null) {
      spans.push({ text: rest });
      break;
    }
    if (m.index > 0) spans.push({ text: rest.slice(0, m.index) });
    const token = m[0];
    if (token.startsWith('`')) spans.push({ text: token.slice(1, -1), color: 'yellow' });
    else spans.push({ text: token.slice(2, -2), bold: true });
    rest = rest.slice(m.index + token.length);
  }
  return spans.length === 0 ? [{ text: '' }] : spans;
}

/** Markdown → styled lines. Wrapped defensively: any failure → plain lines. */
export function renderMarkdown(raw: string): MdLine[] {
  try {
    const src = raw.split('\n');
    const out: MdLine[] = [];
    let inCode = false;
    let inFrontmatter = false;

    for (let i = 0; i < src.length; i++) {
      const line = src[i];

      // YAML frontmatter: a leading `---` pair, dimmed verbatim.
      if (i === 0 && line.trim() === '---') {
        inFrontmatter = true;
        out.push([{ text: line, dim: true }]);
        continue;
      }
      if (inFrontmatter) {
        out.push([{ text: line, dim: true }]);
        if (line.trim() === '---') inFrontmatter = false;
        continue;
      }

      if (line.trimStart().startsWith('```')) {
        inCode = !inCode;
        out.push([{ text: line, dim: true }]);
        continue;
      }
      if (inCode) {
        out.push([{ text: line, color: 'yellow' }]);
        continue;
      }

      const heading = /^(#{1,6})\s+(.*)$/.exec(line);
      if (heading !== null) {
        out.push([
          { text: `${heading[1]} `, color: 'cyan', dim: true },
          { text: heading[2], color: 'cyan', bold: heading[1].length <= 2 },
        ]);
        continue;
      }

      const todo = /^(\s*)[-*]\s+\[( |x|X)\]\s?(.*)$/.exec(line);
      if (todo !== null) {
        const done = todo[2] !== ' ';
        const rest = parseInline(todo[3]);
        out.push([
          ...(todo[1] !== '' ? [{ text: todo[1] }] : []),
          done ? { text: '☑ ', color: 'green' } : { text: '☐ ', color: 'yellow' },
          ...(done ? rest.map((s) => ({ ...s, dim: true })) : rest),
        ]);
        continue;
      }

      const bullet = /^(\s*)[-*]\s+(.*)$/.exec(line);
      if (bullet !== null) {
        out.push([
          ...(bullet[1] !== '' ? [{ text: bullet[1] }] : []),
          { text: '• ', color: 'gray' },
          ...parseInline(bullet[2]),
        ]);
        continue;
      }

      if (/^\s*---+\s*$/.test(line)) {
        out.push([{ text: '─'.repeat(40), color: 'gray' }]);
        continue;
      }

      if (line.startsWith('> ')) {
        out.push([
          { text: '│ ', color: 'gray' },
          ...parseInline(line.slice(2)).map((s) => ({ ...s, dim: true })),
        ]);
        continue;
      }

      out.push(parseInline(line));
    }
    return out;
  } catch {
    return plainToLines(raw);
  }
}
