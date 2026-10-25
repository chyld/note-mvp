// Margin note format: parsing shared by the server (titles, search) and the client (rendering, editing).

export const HUES = [
  ['red', '#ffd2cc', '#ff9b93'],
  ['orange', '#ffd7b8', '#ffa46e'],
  ['amber', '#ffdfac', '#ebb353'],
  ['lime', '#d9eeb7', '#aacc6b'],
  ['green', '#c2f3cb', '#7cd590'],
  ['mint', '#b2f5dd', '#53d8b1'],
  ['teal', '#a8f5f4', '#2ad7d7'],
  ['sky', '#b0efff', '#4fcdff'],
  ['blue', '#c9e6ff', '#8fbdff'],
  ['violet', '#e7dbff', '#c4acff'],
  ['fuchsia', '#ffd3fe', '#eb9fe8'],
  ['pink', '#ffd0e7', '#ff99c2'],
];

export const COLORS = {};
for (const [hue, light, deep] of HUES) {
  COLORS[hue] = light;
  COLORS[`${hue}-deep`] = deep;
}

export const HEADING_RE = /^## \{([a-z]+(?:-deep)?)\} (?=\S)/;
export const FENCE_OPEN_RE = /^```[^`]*$/;
export const FENCE_CLOSE_RE = /^```\s*$/;
export const IMAGE_RE = /^!\[\]\(([a-z0-9]{8}\.png)\)$/;

// "lime+b+u" -> { color: 'lime', b: true, u: true }, or null if anything is invalid.
export function parseOptions(str) {
  let color = null;
  let b = false;
  let u = false;
  for (const part of str.split('+')) {
    if (part === 'b' && !b) b = true;
    else if (part === 'u' && !u) u = true;
    else if (COLORS[part] && !color) color = part;
    else return null;
  }
  return { color, b, u };
}

export function serializeOptions({ color, b, u }) {
  const parts = [];
  if (color) parts.push(color);
  if (b) parts.push('b');
  if (u) parts.push('u');
  return parts.join('+');
}

// Finds an inline code span starting at text[i] === '`'. Returns end index (exclusive) or -1.
function codeSpanEnd(text, i) {
  const j = text.indexOf('`', i + 1);
  return j > i + 1 ? j + 1 : -1;
}

// Parses inline tokens on one line. Positions are offset by `offset`.
// Tokens: { type: 'hl', from, to, contentFrom, contentTo, opts, optsText }
//         { type: 'code', from, to, contentFrom, contentTo, inHl }
export function parseInline(text, offset = 0) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    if (text[i] === '`') {
      const end = codeSpanEnd(text, i);
      if (end > 0) {
        tokens.push({ type: 'code', from: offset + i, to: offset + end, contentFrom: offset + i + 1, contentTo: offset + end - 1 });
        i = end;
        continue;
      }
    } else if (text.startsWith('=={', i)) {
      const m = /^==\{([a-z0-9+-]+)\}/.exec(text.slice(i, i + 64));
      const opts = m && parseOptions(m[1]);
      if (opts) {
        const contentStart = i + m[0].length;
        const inner = [];
        let k = contentStart;
        let close = -1;
        while (k < text.length) {
          if (text[k] === '`') {
            const end = codeSpanEnd(text, k);
            if (end > 0) {
              inner.push({ type: 'code', from: offset + k, to: offset + end, contentFrom: offset + k + 1, contentTo: offset + end - 1, inHl: true });
              k = end;
              continue;
            }
          }
          if (text.startsWith('==', k)) { close = k; break; }
          k++;
        }
        if (close > contentStart) {
          tokens.push({
            type: 'hl', from: offset + i, to: offset + close + 2,
            contentFrom: offset + contentStart, contentTo: offset + close, opts, optsText: m[1],
          });
          tokens.push(...inner);
          i = close + 2;
          continue;
        }
      }
    }
    i++;
  }
  return tokens;
}

// Classifies every line of a note. Returns { lines, sections, blocks }.
// line: { index, from, to, text, kind: 'text'|'heading'|'fence-open'|'fence-close'|'code'|'image', ... }
export function parseDoc(text) {
  const raw = text.split('\n');
  const lines = [];
  let pos = 0;
  for (let i = 0; i < raw.length; i++) {
    lines.push({ index: i, from: pos, to: pos + raw[i].length, text: raw[i], kind: 'text' });
    pos += raw[i].length + 1;
  }

  // Code blocks need a closing fence; an unclosed ``` is plain text.
  const blocks = [];
  for (let i = 0; i < lines.length; i++) {
    if (!FENCE_OPEN_RE.test(lines[i].text)) continue;
    let j = i + 1;
    while (j < lines.length && !FENCE_CLOSE_RE.test(lines[j].text)) j++;
    if (j >= lines.length) break;
    const block = { open: i, close: j, index: blocks.length };
    blocks.push(block);
    lines[i].kind = 'fence-open';
    lines[j].kind = 'fence-close';
    for (let k = i + 1; k < j; k++) lines[k].kind = 'code';
    for (let k = i; k <= j; k++) lines[k].block = block;
    i = j;
  }

  const sections = [];
  for (const line of lines) {
    if (line.kind !== 'text') continue;
    const h = HEADING_RE.exec(line.text);
    if (h && COLORS[h[1]]) {
      line.kind = 'heading';
      line.color = h[1];
      line.prefixLen = h[0].length;
      if (sections.length) sections[sections.length - 1].end = line.index - 1;
      sections.push({ heading: line.index, end: lines.length - 1, color: h[1], index: sections.length });
      continue;
    }
    const img = IMAGE_RE.exec(line.text);
    if (img) {
      line.kind = 'image';
      line.image = img[1];
    }
  }
  for (const s of sections) {
    for (let k = s.heading; k <= s.end; k++) lines[k].section = s;
  }
  return { lines, sections, blocks };
}

// Inline text with the formatting syntax removed.
export function stripInline(text) {
  const tokens = parseInline(text);
  if (!tokens.length) return text;
  const hidden = [];
  for (const t of tokens) {
    hidden.push([t.from, t.contentFrom], [t.contentTo, t.to]);
  }
  hidden.sort((a, b) => a[0] - b[0]);
  let out = '';
  let pos = 0;
  for (const [from, to] of hidden) {
    if (from > pos) out += text.slice(pos, from);
    pos = Math.max(pos, to);
  }
  return out + text.slice(pos);
}

// A note's visible text: what render mode shows, used for search.
export function visibleText(text) {
  const { lines } = parseDoc(text);
  return lines.map((l) => {
    if (l.kind === 'code') return l.text;
    if (l.kind === 'fence-open' || l.kind === 'fence-close' || l.kind === 'image') return '';
    if (l.kind === 'heading') return stripInline(l.text.slice(l.prefixLen));
    return stripInline(l.text);
  }).join('\n');
}

export function noteTitle(text) {
  const nl = text.indexOf('\n');
  const first = nl < 0 ? text : text.slice(0, nl);
  const h = HEADING_RE.exec(first);
  const body = h && COLORS[h[1]] ? first.slice(h[0].length) : first;
  return stripInline(body).trim();
}
