// Editing behaviour. In render mode the syntax is hidden, so keys and edits are adjusted to
// keep it intact: Backspace/Delete skip hidden markers, Enter splits a highlight cleanly,
// and edits that would cut a marker in half leave the marker alone.
import { EditorState, Prec, findClusterBreak } from '@codemirror/state';
import { keymap } from '@codemirror/view';
import { parseDoc, parseOptions } from '../shared/format.js';
import { renderField, bypass } from './render.js';

const isUserEdit = (tr) => !tr.annotation(bypass) && (tr.isUserEvent('input') || tr.isUserEvent('delete') || tr.isUserEvent('move'));

// Suppress changes to the syntax of any token an edit only partly covers.
const protectMarkers = EditorState.changeFilter.of((tr) => {
  if (!tr.docChanged || !isUserEdit(tr)) return true;
  const info = tr.startState.field(renderField, false);
  if (!info) return true;
  const ranges = [];
  for (const m of info.markers) {
    let whole = false;
    let touched = false;
    tr.changes.iterChangedRanges((fA, tA) => {
      if (fA <= m.from && tA >= m.to) whole = true;
      else if (fA < m.to && tA > m.from) touched = true;
    });
    if (touched && !whole) ranges.push(...m.ranges);
  }
  if (!ranges.length) return true;
  ranges.sort((a, b) => a[0] - b[0]);
  const flat = [];
  for (const [a, b] of ranges) {
    if (flat.length && a <= flat[flat.length - 1]) flat[flat.length - 1] = Math.max(flat[flat.length - 1], b);
    else flat.push(a, b);
  }
  return flat;
});

// After a deletion, drop highlights and inline code left with nothing inside.
const cleanupEmpty = EditorState.transactionFilter.of((tr) => {
  if (!tr.docChanged || !isUserEdit(tr) || !tr.startState.field(renderField, false)) return tr;
  let removed = false;
  tr.changes.iterChanges((fA, tA) => { if (tA > fA) removed = true; });
  if (!removed) return tr;
  const doc = tr.newDoc;
  const { lines } = parseDoc(doc.toString());
  const changes = [];
  const seen = new Set();
  tr.changes.iterChangedRanges((fA, tA, fB, tB) => {
    for (let n = doc.lineAt(fB).number; n <= doc.lineAt(tB).number; n++) {
      if (seen.has(n)) continue;
      seen.add(n);
      const line = lines[n - 1];
      if (line.block) continue;
      for (const m of line.text.matchAll(/==\{([a-z0-9+-]+)\}==|(?<!`)``(?!`)/g)) {
        if (m[1] !== undefined && !parseOptions(m[1])) continue;
        changes.push({ from: line.from + m.index, to: line.from + m.index + m[0].length });
      }
    }
  });
  if (!changes.length) return tr;
  return [tr, { changes, sequential: true }];
});

const blockish = new Set(['fence-open', 'fence-close', 'image']);

// Whether deleting the line break between two lines keeps both lines' syntax intact.
function canJoin(a, b) {
  if (!a.text.length || !b.text.length) return true;
  if (blockish.has(a.kind) || blockish.has(b.kind) || b.kind === 'heading') return false;
  if (Boolean(a.block) !== Boolean(b.block)) return false;
  return true;
}

function dispatchDelete(view, from, to, userEvent) {
  view.dispatch({
    changes: { from, to },
    selection: { anchor: from },
    annotations: bypass.of(true),
    userEvent,
    scrollIntoView: true,
  });
  return true;
}

// The range to delete for one visible character at [from, to): the whole token if that
// character is all it contains, the whole line if it's the last character of a heading.
function deletionRange(info, line, from, to) {
  let target = info.tokens.find((t) => t.contentFrom === from && t.contentTo === to);
  if (target) {
    let outer;
    while ((outer = info.tokens.find((t) => t.type === 'hl' && t.contentFrom === target.from && t.contentTo === target.to))) {
      target = outer;
    }
    from = target.from;
    to = target.to;
  }
  if (line.kind === 'heading' && from <= line.from + line.prefixLen && to >= line.to) return [line.from, line.to];
  return [from, to];
}

function imageLineRange(doc, lineFrom) {
  const line = doc.lineAt(lineFrom);
  if (line.from > 0) return [line.from - 1, line.to];
  return [line.from, Math.min(line.to + 1, doc.length)];
}

function renderBackspace(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const info = state.field(renderField);
  const doc = state.doc;
  const p = sel.head;
  const docLine = doc.lineAt(p);
  const line = info.parsed.lines[docLine.number - 1];

  // At the start of a heading's text: turn it back into a plain line.
  if (line.kind === 'heading' && p === line.from + line.prefixLen) {
    return dispatchDelete(view, line.from, line.from + line.prefixLen, 'delete.backward');
  }

  let q = p;
  let skipped = null;
  for (;;) {
    const h = info.hidden.find((r) => r.to === q && r.from < q);
    if (!h) break;
    skipped = h;
    q = h.from;
  }
  if (skipped?.kind === 'image') {
    const [from, to] = imageLineRange(doc, skipped.from);
    return dispatchDelete(view, from, to, 'delete.backward');
  }
  if (q === 0) return true;

  const qLine = doc.lineAt(q);
  if (q === qLine.from) {
    const prev = info.parsed.lines[qLine.number - 2];
    const cur = info.parsed.lines[qLine.number - 1];
    if (!canJoin(prev, cur)) {
      view.dispatch({ selection: { anchor: prev.to }, scrollIntoView: true });
      return true;
    }
    return dispatchDelete(view, q - 1, q, 'delete.backward');
  }
  const from = qLine.from + findClusterBreak(qLine.text, q - qLine.from, false);
  const [a, b] = deletionRange(info, info.parsed.lines[qLine.number - 1], from, q);
  return dispatchDelete(view, a, b, 'delete.backward');
}

function renderDelete(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const info = state.field(renderField);
  const doc = state.doc;

  let q = sel.head;
  let skipped = null;
  for (;;) {
    const h = info.hidden.find((r) => r.from === q && r.to > q);
    if (!h) break;
    skipped = h;
    q = h.to;
  }
  if (skipped?.kind === 'image') {
    const [from, to] = imageLineRange(doc, skipped.from);
    return dispatchDelete(view, from, to, 'delete.forward');
  }
  if (q >= doc.length) return true;

  const qLine = doc.lineAt(q);
  if (q === qLine.to) {
    const cur = info.parsed.lines[qLine.number - 1];
    const next = info.parsed.lines[qLine.number];
    if (!canJoin(cur, next)) {
      view.dispatch({ selection: { anchor: next.from }, scrollIntoView: true });
      return true;
    }
    return dispatchDelete(view, q, q + 1, 'delete.forward');
  }
  const to = qLine.from + findClusterBreak(qLine.text, q - qLine.from, true);
  const [a, b] = deletionRange(info, info.parsed.lines[qLine.number - 1], q, to);
  return dispatchDelete(view, a, b, 'delete.forward');
}

// Enter inside a highlight or inline code closes it before the line break and reopens it after.
function renderEnter(view) {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false;
  const info = state.field(renderField);
  let p = sel.head;
  const line = info.parsed.lines[state.doc.lineAt(p).number - 1];

  if (line.kind === 'heading' && p === line.from + line.prefixLen) p = line.from;
  if (line.kind !== 'heading' && line.kind !== 'text') return false;

  const onLine = info.tokens.filter((t) => t.from >= line.from && t.to <= line.to);
  // At the edge of a token, step outside it rather than leaving an empty piece behind.
  for (let moved = true; moved;) {
    moved = false;
    for (const t of onLine) {
      if (p === t.contentTo && p < t.to) { p = t.to; moved = true; }
      else if (p === t.contentFrom && p > t.from) { p = t.from; moved = true; }
    }
  }
  const open = onLine.filter((t) => t.contentFrom < p && p < t.contentTo).sort((a, b) => a.from - b.from);
  const closeStr = open.slice().reverse().map((t) => (t.type === 'hl' ? '==' : '`')).join('');
  const openStr = open.map((t) => (t.type === 'hl' ? `=={${t.optsText}}` : '`')).join('');
  const insert = closeStr + '\n' + openStr;
  view.dispatch({
    changes: { from: p, insert },
    selection: { anchor: p + insert.length },
    annotations: bypass.of(true),
    userEvent: 'input',
    scrollIntoView: true,
  });
  return true;
}

export const renderEditing = [
  protectMarkers,
  cleanupEmpty,
  Prec.high(keymap.of([
    { key: 'Backspace', run: renderBackspace },
    { key: 'Delete', run: renderDelete },
    { key: 'Enter', run: renderEnter },
  ])),
];

// Tab / Shift+Tab indent by two spaces inside code blocks (both modes); elsewhere Tab is normal.
function codeIndent(dedent) {
  return (view) => {
    const { state } = view;
    const { lines } = parseDoc(state.doc.toString());
    const sel = state.selection.main;
    const first = state.doc.lineAt(sel.from).number - 1;
    const last = state.doc.lineAt(sel.to).number - 1;
    for (let i = first; i <= last; i++) if (lines[i].kind !== 'code') return false;
    if (!dedent && sel.empty) {
      view.dispatch(state.replaceSelection('  '), { annotations: bypass.of(true), userEvent: 'input.indent' });
      return true;
    }
    const changes = [];
    for (let i = first; i <= last; i++) {
      const l = lines[i];
      if (dedent) {
        const n = /^ {0,2}/.exec(l.text)[0].length;
        if (n) changes.push({ from: l.from, to: l.from + n });
      } else {
        changes.push({ from: l.from, insert: '  ' });
      }
    }
    view.dispatch({ changes, annotations: bypass.of(true), userEvent: 'input.indent' });
    return true;
  };
}

export const codeTabs = keymap.of([
  { key: 'Tab', run: codeIndent(false) },
  { key: 'Shift-Tab', run: codeIndent(true) },
]);

