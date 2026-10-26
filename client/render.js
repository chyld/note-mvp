// Render mode: decorations that hide the formatting syntax and draw highlights, sections,
// code, screenshots and the title. The document itself always stays the raw note text.
import { StateField, StateEffect, Facet, Annotation } from '@codemirror/state';
import { EditorView, Decoration, WidgetType } from '@codemirror/view';
import { parseDoc, parseInline, COLORS } from '../shared/format.js';
import { darkShade } from './colors.js';

// Marks transactions made by Margin itself, so the render-mode edit guards leave them alone.
export const bypass = Annotation.define();

export const noteIdFacet = Facet.define({ combine: (v) => v[0] || '' });

// Collapsed sections, keyed by the heading line's raw text. Kept in every mode.
export const toggleSection = StateEffect.define();
export const collapsedField = StateField.define({
  create: () => new Set(),
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(toggleSection)) {
        value = new Set(value);
        if (value.has(e.value)) value.delete(e.value);
        else value.add(e.value);
      }
    }
    return value;
  },
});

class FoldWidget extends WidgetType {
  constructor(key, collapsed) {
    super();
    this.key = key;
    this.collapsed = collapsed;
  }
  eq(other) {
    return other.key === this.key && other.collapsed === this.collapsed;
  }
  toDOM(view) {
    const el = document.createElement('span');
    el.className = 'cm-fold' + (this.collapsed ? ' collapsed' : '');
    el.textContent = '⌄';
    el.title = this.collapsed ? 'Expand section' : 'Collapse section';
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ effects: toggleSection.of(this.key) });
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

class MoreWidget extends WidgetType {
  constructor(key) {
    super();
    this.key = key;
  }
  eq(other) {
    return other.key === this.key;
  }
  toDOM(view) {
    const el = document.createElement('span');
    el.className = 'cm-fold-more';
    el.textContent = '⋯';
    el.title = 'Expand section';
    el.addEventListener('mousedown', (e) => {
      e.preventDefault();
      view.dispatch({ effects: toggleSection.of(this.key) });
    });
    return el;
  }
  ignoreEvent() {
    return true;
  }
}

class ImageWidget extends WidgetType {
  constructor(src) {
    super();
    this.src = src;
  }
  eq(other) {
    return other.src === this.src;
  }
  toDOM(view) {
    const wrap = document.createElement('span');
    wrap.className = 'cm-image';
    const img = document.createElement('img');
    img.src = this.src;
    img.alt = 'Screenshot';
    img.addEventListener('load', () => view.requestMeasure());
    img.addEventListener('error', () => wrap.classList.add('broken'));
    wrap.appendChild(img);
    return wrap;
  }
}

class CopyWidget extends WidgetType {
  constructor(blockIndex) {
    super();
    this.blockIndex = blockIndex;
  }
  eq(other) {
    return other.blockIndex === this.blockIndex;
  }
  toDOM(view) {
    const btn = document.createElement('button');
    btn.className = 'cm-copy';
    btn.type = 'button';
    btn.dataset.block = String(this.blockIndex);
    btn.textContent = 'Copy';
    btn.addEventListener('mousedown', (e) => e.preventDefault());
    btn.addEventListener('click', async () => {
      const { lines, blocks } = parseDoc(view.state.doc.toString());
      const block = blocks[this.blockIndex];
      if (!block) return;
      const code = lines.slice(block.open + 1, block.close).map((l) => l.text).join('\n');
      try {
        await copyText(code);
        btn.textContent = 'Copied';
      } catch {
        btn.textContent = 'Copy failed';
      }
      setTimeout(() => { btn.textContent = 'Copy'; }, 1200);
    });
    return btn;
  }
  ignoreEvent() {
    return true;
  }
}

async function copyText(text) {
  // navigator.clipboard needs a secure context, which plain HTTP on the LAN isn't.
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  const ok = document.execCommand('copy');
  ta.remove();
  if (!ok) throw new Error('copy failed');
}

const hide = Decoration.replace({});

function buildRender(state) {
  const parsed = parseDoc(state.doc.toString());
  const { lines, sections } = parsed;
  const collapsed = state.field(collapsedField);
  const noteId = state.facet(noteIdFacet);
  const headLine = state.doc.lineAt(state.selection.main.head).number - 1;

  const decos = [];
  const atomic = [];
  const hidden = []; // { from, to, kind } ranges the cursor can't enter
  const markers = []; // { from, to, ranges } syntax that partial edits must not break
  const tokens = [];

  const hideRange = (from, to, kind, deco = hide) => {
    if (to <= from && !deco.spec.widget) return;
    decos.push(deco.range(from, to));
    atomic.push(deco.range(from, to));
    hidden.push({ from, to, kind });
  };

  // In a heading, highlights keep bold and underline but not their color: the heading
  // always shows its section's color.
  const inline = (text, offset, inHeading = false) => {
    for (const t of parseInline(text, offset)) {
      tokens.push(t);
      markers.push({ from: t.from, to: t.to, ranges: [[t.from, t.contentFrom], [t.contentTo, t.to]] });
      hideRange(t.from, t.contentFrom, 'marker');
      hideRange(t.contentTo, t.to, 'marker');
      if (t.type === 'hl') {
        const color = inHeading ? null : t.opts.color;
        const cls = ['cm-hl'];
        if (color) cls.push('cm-hl-color');
        if (t.opts.b) cls.push('cm-hl-b');
        if (t.opts.u) cls.push('cm-hl-u');
        const attributes = color ? { style: `--hl:${COLORS[color]}` } : undefined;
        decos.push(Decoration.mark({ class: cls.join(' '), attributes }).range(t.contentFrom, t.contentTo));
      } else {
        decos.push(Decoration.mark({ class: 'cm-code' }).range(t.contentFrom, t.contentTo));
      }
    }
  };

  // Lines hidden inside a collapsed section.
  const folded = new Set();
  for (const s of sections) {
    const h = lines[s.heading];
    if (s.end > s.heading && collapsed.has(h.text)) {
      for (let k = s.heading + 1; k <= s.end; k++) folded.add(k);
      hideRange(h.to, lines[s.end].to, 'fold', Decoration.replace({ widget: new MoreWidget(h.text) }));
    }
  }

  for (const line of lines) {
    if (folded.has(line.index)) continue;
    const cls = [];
    const style = [];
    const sec = line.section;
    if (sec && line.index !== sec.heading) {
      cls.push('cm-sec');
      style.push(`--sec:${COLORS[sec.color]}`);
    }
    if (line.index === 0 && line.kind === 'text' && line.text) cls.push('cm-title');

    switch (line.kind) {
      case 'heading': {
        const isCollapsed = collapsed.has(line.text) && sec.end > sec.heading;
        cls.push('cm-heading');
        style.push(`--sec:${COLORS[line.color]}`, `--heading:${darkShade(COLORS[line.color])}`);
        markers.push({ from: line.from, to: line.to, ranges: [[line.from, line.from + line.prefixLen]] });
        hideRange(line.from, line.from + line.prefixLen, 'heading',
          Decoration.replace({ widget: new FoldWidget(line.text, isCollapsed) }));
        inline(line.text.slice(line.prefixLen), line.from + line.prefixLen, true);
        break;
      }
      case 'fence-open':
      case 'fence-close': {
        cls.push('cm-cb', line.kind === 'fence-open' ? 'cm-cb-open' : 'cm-cb-close');
        // Fences are hidden unless the cursor is on them.
        if (headLine !== line.index) {
          cls.push('cm-fence-hidden');
          hideRange(line.from, line.to, 'fence');
        }
        if (line.kind === 'fence-open') {
          decos.push(Decoration.widget({ widget: new CopyWidget(line.block.index), side: -1 }).range(line.from));
        }
        break;
      }
      case 'code':
        cls.push('cm-cb', 'cm-cb-body');
        break;
      case 'image':
        cls.push('cm-image-line');
        hideRange(line.from, line.to, 'image', Decoration.replace({
          widget: new ImageWidget(`/api/notes/${noteId}/images/${line.image}`),
        }));
        break;
      default:
        inline(line.text, line.from);
    }

    if (cls.length) {
      const attributes = style.length ? { style: style.join(';') } : undefined;
      decos.push(Decoration.line({ class: cls.join(' '), attributes }).range(line.from));
    }
  }

  hidden.sort((a, b) => a.from - b.from);
  return {
    parsed,
    tokens,
    markers,
    hidden,
    decorations: Decoration.set(decos, true),
    atomic: Decoration.set(atomic, true),
  };
}

export const renderField = StateField.define({
  create: buildRender,
  update(value, tr) {
    const collapsedChanged = tr.startState.field(collapsedField) !== tr.state.field(collapsedField);
    if (tr.docChanged || tr.selection || collapsedChanged) return buildRender(tr.state);
    return value;
  },
  provide: (f) => [
    EditorView.decorations.from(f, (v) => v.decorations),
    EditorView.atomicRanges.of((view) => view.state.field(f).atomic),
  ],
});

// The end-of-file marker, shown in both modes.
class EofWidget extends WidgetType {
  eq() {
    return true;
  }
  toDOM() {
    const el = document.createElement('div');
    el.className = 'cm-eof';
    el.setAttribute('aria-hidden', 'true');
    el.innerHTML = `
      <svg class="cm-eof-diamond" viewBox="0 0 8 8"><path d="M4 0.5 7.5 4 4 7.5 0.5 4Z" fill="#c9cacb"/></svg>
      <span class="cm-eof-line"></span>
      <svg class="cm-eof-dots" viewBox="0 0 16 12"><circle cx="8" cy="3" r="1.6" fill="#8c9099"/><circle cx="4" cy="9" r="1.6" fill="#8c9099"/><circle cx="12" cy="9" r="1.6" fill="#8c9099"/></svg>
      <span class="cm-eof-line"></span>
      <svg class="cm-eof-diamond" viewBox="0 0 8 8"><path d="M4 0.5 7.5 4 4 7.5 0.5 4Z" fill="#c9cacb"/></svg>`;
    return el;
  }
  get estimatedHeight() {
    return 48;
  }
}

const eofDeco = (doc) => Decoration.set([Decoration.widget({ widget: new EofWidget(), side: 1, block: true }).range(doc.length)]);

export const eofField = StateField.define({
  create: (state) => eofDeco(state.doc),
  update: (value, tr) => (tr.docChanged ? eofDeco(tr.state.doc) : value),
  provide: (f) => EditorView.decorations.from(f),
});
