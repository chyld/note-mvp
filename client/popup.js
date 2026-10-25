// The formatting popup that appears next to a text selection.
import { Prec } from '@codemirror/state';
import { keymap, EditorView } from '@codemirror/view';
import { HUES, COLORS } from '../shared/format.js';
import { applyFormat, formatState } from './format-ops.js';

export function createPopup() {
  const el = document.createElement('div');
  el.className = 'format-popup';
  el.hidden = true;
  el.innerHTML = `
    <div class="fp-row">
      <button type="button" class="fp-btn fp-b" data-op="b" title="Bold"><b>B</b></button>
      <button type="button" class="fp-btn fp-u" data-op="u" title="Underline"><u>U</u></button>
      <button type="button" class="fp-btn fp-code" data-op="code" title="Code">&lt;/&gt;</button>
      <button type="button" class="fp-btn fp-wide" data-op="clear">Clear formatting</button>
    </div>
    <div class="fp-row">
      <button type="button" class="fp-btn fp-wide" data-op="removeColor">Remove color</button>
    </div>
    <div class="fp-grid">
      ${[1, 2].map((deep) => HUES.map(([hue]) => {
        const name = deep === 2 ? `${hue}-deep` : hue;
        return `<button type="button" class="fp-swatch" data-op="color" data-color="${name}" title="${name}" style="background:${COLORS[name]}">a</button>`;
      }).join('')).join('')}
    </div>
    <div class="fp-hint">Enter applies · Esc closes</div>`;
  document.body.appendChild(el);

  const rows = [
    [...el.querySelectorAll('.fp-row')[0].children],
    [...el.querySelectorAll('.fp-row')[1].children],
    [...el.querySelectorAll('.fp-swatch')].slice(0, 12),
    [...el.querySelectorAll('.fp-swatch')].slice(12),
  ];

  let view = null;
  let pointerDown = false;
  let dismissedFor = null; // the selection Esc was pressed on
  let focus = null; // [row, col] of the keyboard-highlighted item
  let raf = 0;

  const visible = () => !el.hidden;

  function hide() {
    el.hidden = true;
    focus = null;
    paintFocus();
  }

  function selectionKey(state) {
    const s = state.selection.main;
    return `${s.anchor}:${s.head}:${state.doc.length}`;
  }

  function schedule() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(update);
  }

  function update() {
    if (!view) return hide();
    const { state } = view;
    const sel = state.selection.main;
    if (sel.empty || pointerDown || !view.hasFocus || state.readOnly || dismissedFor === selectionKey(state)) {
      return hide();
    }
    dismissedFor = null;
    const fs = formatState(state);
    el.querySelector('.fp-b').classList.toggle('active', fs.b);
    el.querySelector('.fp-u').classList.toggle('active', fs.u);
    el.querySelector('.fp-code').classList.toggle('active', fs.code);
    el.classList.toggle('in-code', fs.inCodeBlock);
    for (const sw of el.querySelectorAll('.fp-swatch')) sw.classList.toggle('active', sw.dataset.color === fs.color);

    const start = view.coordsAtPos(sel.from, 1);
    const end = view.coordsAtPos(sel.to, -1);
    if (!start || !end) return hide();
    const wasHidden = el.hidden;
    el.hidden = false;
    if (wasHidden) focus = null;
    paintFocus();
    const w = el.offsetWidth;
    const h = el.offsetHeight;
    const gap = 8;
    let top = end.bottom + gap;
    if (top + h > window.innerHeight - 4) top = Math.max(4, start.top - h - gap);
    let left = (sel.head === sel.from ? start.left : end.left) - w / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    el.style.top = `${top}px`;
    el.style.left = `${left}px`;
  }

  function run(btn) {
    if (!view || !btn) return;
    const op = { type: btn.dataset.op };
    if (op.type === 'color') op.color = btn.dataset.color;
    const spec = applyFormat(view.state, op);
    if (spec) view.dispatch(spec);
    view.focus();
    schedule();
  }

  function paintFocus() {
    for (const b of el.querySelectorAll('.kb-focus')) b.classList.remove('kb-focus');
    if (focus) rows[focus[0]][focus[1]].classList.add('kb-focus');
  }

  function move(dRow, dCol) {
    if (!focus) {
      const active = el.querySelector('.fp-swatch.active');
      focus = active ? findPos(active) : [0, 0];
    } else if (dRow) {
      const r = Math.max(0, Math.min(rows.length - 1, focus[0] + dRow));
      const ratio = focus[1] / Math.max(1, rows[focus[0]].length - 1);
      focus = [r, Math.round(ratio * (rows[r].length - 1))];
    } else {
      let [r, c] = focus;
      c += dCol;
      if (c < 0 && r > 0) { r -= 1; c = rows[r].length - 1; }
      else if (c >= rows[r].length && r < rows.length - 1) { r += 1; c = 0; }
      focus = [r, Math.max(0, Math.min(rows[r].length - 1, c))];
    }
    paintFocus();
    return true;
  }

  function findPos(btn) {
    for (let r = 0; r < rows.length; r++) {
      const c = rows[r].indexOf(btn);
      if (c >= 0) return [r, c];
    }
    return [0, 0];
  }

  el.addEventListener('mousedown', (e) => e.preventDefault());
  el.addEventListener('click', (e) => run(e.target.closest('button')));
  window.addEventListener('mouseup', () => {
    if (pointerDown) {
      pointerDown = false;
      schedule();
    }
  });
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, true);

  const keys = Prec.highest(keymap.of([
    { key: 'ArrowLeft', run: () => visible() && move(0, -1) },
    { key: 'ArrowRight', run: () => visible() && move(0, 1) },
    { key: 'ArrowUp', run: () => visible() && move(-1, 0) },
    { key: 'ArrowDown', run: () => visible() && move(1, 0) },
    {
      key: 'Enter',
      run: () => {
        if (!visible()) return false;
        if (focus) run(rows[focus[0]][focus[1]]);
        else hide();
        return true;
      },
    },
    {
      key: 'Escape',
      run: (v) => {
        if (!visible()) return false;
        dismissedFor = selectionKey(v.state);
        hide();
        return true;
      },
    },
  ]));

  const extension = [
    keys,
    EditorView.updateListener.of((u) => {
      view = u.view;
      if (u.selectionSet || u.docChanged || u.focusChanged || u.geometryChanged) schedule();
    }),
    EditorView.domEventHandlers({
      mousedown: (e, v) => {
        view = v;
        if (e.button === 0) {
          pointerDown = true;
          hide();
        }
        return false;
      },
    }),
  ];

  return { extension, hide };
}
