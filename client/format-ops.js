// Formatting commands for the selection popup. Each affected line is turned into a list of
// visible characters with attributes, changed, and written back as ==…== / `…` syntax.
import { EditorSelection } from '@codemirror/state';
import { parseDoc, parseInline, serializeOptions, stripInline } from '../shared/format.js';
import { bypass } from './render.js';

const noOpts = { color: null, b: false, u: false };

function lineModel(text, offset) {
  const marker = new Uint8Array(text.length);
  const hl = new Array(text.length).fill(null);
  const code = new Uint8Array(text.length);
  for (const t of parseInline(text, offset)) {
    const a = t.from - offset;
    const ca = t.contentFrom - offset;
    const cb = t.contentTo - offset;
    const b = t.to - offset;
    for (let i = a; i < ca; i++) marker[i] = 1;
    for (let i = cb; i < b; i++) marker[i] = 1;
    for (let i = ca; i < cb; i++) {
      if (t.type === 'hl') hl[i] = t.opts;
      else code[i] = 1;
    }
  }
  const chars = [];
  for (let i = 0; i < text.length; i++) {
    if (!marker[i]) chars.push({ ch: text[i], pos: offset + i, opts: hl[i] || noOpts, code: Boolean(code[i]) });
  }
  return chars;
}

function serialize(chars) {
  let out = '';
  const pos = new Array(chars.length);
  let i = 0;
  while (i < chars.length) {
    const key = serializeOptions(chars[i].opts);
    let j = i;
    while (j < chars.length && serializeOptions(chars[j].opts) === key) j++;
    if (key) out += `=={${key}}`;
    let k = i;
    while (k < j) {
      const isCode = chars[k].code;
      let m = k;
      while (m < j && chars[m].code === isCode) m++;
      if (isCode) out += '`';
      for (let x = k; x < m; x++) {
        pos[x] = out.length;
        out += chars[x].ch;
      }
      if (isCode) out += '`';
      k = m;
    }
    if (key) out += '==';
    i = j;
  }
  return { text: out, pos };
}

// The editable inline part of a line, or null for lines inline formatting doesn't apply to.
function inlineRegion(line) {
  if (line.kind === 'text') return { start: line.from, text: line.text };
  if (line.kind === 'heading') return { start: line.from + line.prefixLen, text: line.text.slice(line.prefixLen) };
  return null;
}

function selectedLines(parsed, from, to) {
  return parsed.lines.filter((l) => l.to >= from && l.from <= to && !(l.from === to && to > from && l.from > from));
}

// The line the Section button acts on: the first selected heading or non-empty text line.
function sectionTarget(lines) {
  return lines.find((l) => l.kind === 'heading' || (l.kind === 'text' && l.text.trim())) || null;
}

// Current formatting of the selection, for the popup's active states.
export function formatState(state) {
  const sel = state.selection.main;
  const parsed = parseDoc(state.doc.toString());
  const lines = selectedLines(parsed, sel.from, sel.to);
  const result = {
    any: false, b: true, u: true, code: true, color: undefined, inCodeBlock: false,
    section: sectionTarget(lines)?.kind === 'heading',
  };
  for (const line of lines) {
    if (line.block) result.inCodeBlock = true;
    const region = inlineRegion(line);
    if (!region) continue;
    for (const c of lineModel(region.text, region.start)) {
      if (c.pos < sel.from || c.pos >= sel.to) continue;
      result.any = true;
      result.b &&= c.opts.b;
      result.u &&= c.opts.u;
      result.code &&= c.code;
      // A heading's color is always its section's color.
      const color = line.kind === 'heading' ? line.color : c.opts.color;
      if (result.color === undefined) result.color = color;
      else if (result.color !== color) result.color = null;
    }
  }
  if (!result.any) Object.assign(result, { b: false, u: false, code: result.inCodeBlock, color: null });
  if (result.inCodeBlock) result.code = true;
  return result;
}

// Applies an inline change to every selected character. `op` is one of:
// { type: 'b' }, { type: 'u' }, { type: 'color', color }, { type: 'removeColor' }, { type: 'clear' }
// Code and Section work on whole lines and have their own functions. A color picked on a
// section heading recolors the section (heading and bar) instead of highlighting its text.
export function applyFormat(state, op) {
  const sel = state.selection.main;
  if (op.type === 'section') return toggleSection(state);
  if (sel.empty) return null;
  if (op.type === 'code') return toggleCode(state);
  const now = formatState(state);
  const parsed = parseDoc(state.doc.toString());

  const update = (c) => {
    const o = { ...c.opts };
    switch (op.type) {
      case 'b': o.b = !now.b; break;
      case 'u': o.u = !now.u; break;
      case 'color': o.color = now.color === op.color ? null : op.color; break;
      case 'removeColor': o.color = null; break;
      case 'clear': return { ...c, opts: noOpts, code: false };
    }
    return { ...c, opts: o };
  };

  const changes = [];
  let first = null;
  let last = null;
  for (const line of selectedLines(parsed, sel.from, sel.to)) {
    const region = inlineRegion(line);
    if (!region) continue;
    const chars = lineModel(region.text, region.start);
    const recolorSection = line.kind === 'heading' && op.type === 'color';
    let firstIdx = -1;
    let lastIdx = -1;
    const next = chars.map((c, i) => {
      if (recolorSection) {
        if (c.pos >= sel.from && c.pos < sel.to) {
          if (firstIdx < 0) firstIdx = i;
          lastIdx = i;
        }
        return c.opts.color ? { ...c, opts: { ...c.opts, color: null } } : c;
      }
      if (c.pos < sel.from || c.pos >= sel.to) return c;
      if (firstIdx < 0) firstIdx = i;
      lastIdx = i;
      return update(c);
    });
    if (firstIdx < 0) continue;
    const out = serialize(next);
    // Replace from the line start when the heading's color changes, else just the text.
    const start = recolorSection ? line.from : region.start;
    const prefix = recolorSection ? `## {${op.color}} ` : '';
    const insert = prefix + out.text;
    if (insert !== state.sliceDoc(start, line.to)) changes.push({ from: start, to: line.to, insert });
    if (!first) first = { start, offset: prefix.length + out.pos[firstIdx] };
    last = { start, offset: prefix.length + out.pos[lastIdx] + 1 };
  }
  if (!changes.length) return null;
  const cs = state.changes(changes);
  const anchor = cs.mapPos(first.start, -1) + first.offset;
  const head = cs.mapPos(last.start, -1) + last.offset;
  return {
    changes: cs,
    selection: EditorSelection.single(anchor, head),
    annotations: bypass.of(true),
    userEvent: 'format',
    scrollIntoView: true,
  };
}

export const DEFAULT_SECTION_COLOR = 'blue-deep';

// Turns the selected line into a section heading, or a heading back into a plain line.
function toggleSection(state) {
  const sel = state.selection.main;
  const parsed = parseDoc(state.doc.toString());
  const line = sectionTarget(selectedLines(parsed, sel.from, sel.to));
  if (!line) return null;
  let changes;
  if (line.kind === 'heading') {
    changes = { from: line.from, to: line.from + line.prefixLen };
  } else {
    // A heading's text has to start with a non-space character.
    const indent = /^\s*/.exec(line.text)[0].length;
    changes = { from: line.from, to: line.from + indent, insert: `## {${DEFAULT_SECTION_COLOR}} ` };
  }
  const cs = state.changes(changes);
  return {
    changes: cs,
    selection: EditorSelection.single(cs.mapPos(sel.anchor, 1), cs.mapPos(sel.head, 1)),
    annotations: bypass.of(true),
    userEvent: 'format',
  };
}

// Inline code within one line; a code block when the selection spans lines.
function toggleCode(state) {
  const sel = state.selection.main;
  const doc = state.doc;
  const parsed = parseDoc(doc.toString());
  const lines = selectedLines(parsed, sel.from, sel.to);
  const blocks = [...new Set(lines.filter((l) => l.block).map((l) => l.block))];

  if (blocks.length) {
    // Unwrap: remove the fence lines of every touched block.
    const changes = [];
    for (const b of blocks) {
      const open = parsed.lines[b.open];
      const close = parsed.lines[b.close];
      if (b.close === b.open + 1) {
        changes.push({ from: open.from, to: close.to });
        continue;
      }
      changes.push({ from: open.from, to: Math.min(open.to + 1, doc.length) });
      changes.push({ from: close.from - 1, to: close.to });
    }
    const cs = state.changes(changes);
    return {
      changes: cs,
      selection: EditorSelection.single(cs.mapPos(sel.from, 1), cs.mapPos(sel.to, -1)),
      annotations: bypass.of(true),
      userEvent: 'format',
    };
  }

  if (lines.length === 1) {
    const line = lines[0];
    const region = inlineRegion(line);
    if (!region) return null;
    const chars = lineModel(region.text, region.start);
    const picked = chars.map((c, i) => (c.pos >= sel.from && c.pos < sel.to ? i : -1)).filter((i) => i >= 0);
    if (!picked.length) return null;
    const allCode = picked.every((i) => chars[i].code);
    const next = chars.map((c, i) => (picked.includes(i) ? { ...c, code: !allCode } : c));
    const out = serialize(next);
    const cs = state.changes({ from: region.start, to: line.to, insert: out.text });
    const base = cs.mapPos(region.start, -1);
    return {
      changes: cs,
      selection: EditorSelection.single(base + out.pos[picked[0]], base + out.pos[picked[picked.length - 1]] + 1),
      annotations: bypass.of(true),
      userEvent: 'format',
    };
  }

  // Wrap whole lines in a fenced block. The code shows what render mode showed, so
  // inline formatting is dropped.
  const first = lines[0];
  const last = lines[lines.length - 1];
  const body = lines.map((l) => {
    if (l.kind === 'heading') return stripInline(l.text.slice(l.prefixLen));
    if (l.kind === 'text') return stripInline(l.text);
    return l.text;
  }).join('\n');
  const insert = '```\n' + body + '\n```';
  return {
    changes: { from: first.from, to: last.to, insert },
    selection: EditorSelection.single(first.from + 4, first.from + 4 + body.length),
    annotations: bypass.of(true),
    userEvent: 'format',
  };
}
