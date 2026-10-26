// The formatting popup. It appears next to a text selection, or opens from the menu bar's
// formatting button, where it stays open ("pinned") while you edit.
import { Prec } from '@codemirror/state';
import { keymap, EditorView } from '@codemirror/view';
import { HUES, COLORS, URL_RE } from '../shared/format.js';
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
      <button type="button" class="fp-btn fp-section" data-op="section" title="Make this line a section heading">Section</button>
      <button type="button" class="fp-btn fp-wide" data-op="clear">Clear formatting</button>
    </div>
    <div class="fp-row">
      <button type="button" class="fp-btn fp-link" data-op="link" title="Link to a web page"><svg><use href="#i-link"/></svg> Link</button>
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
  const hint = el.querySelector('.fp-hint');

  const rows = [
    [...el.querySelectorAll('.fp-row')[0].children],
    [...el.querySelectorAll('.fp-row')[1].children],
    [...el.querySelectorAll('.fp-swatch')].slice(0, 12),
    [...el.querySelectorAll('.fp-swatch')].slice(12),
  ];

  let view = null;
  let pinnedTo = null; // the menu bar button the popup was opened from
  let pointerDown = false;
  let dismissedFor = null; // the selection Esc was pressed on
  let focus = null; // [row, col] of the keyboard-highlighted item
  let raf = 0;
  let hintTimer = 0;

  const visible = () => !el.hidden;
  // Keys go to the popup unless it's pinned with no selection, when you're just typing.
  const ownsKeys = () => visible() && !(pinnedTo && view.state.selection.main.empty);

  function hide() {
    el.hidden = true;
    focus = null;
    paintFocus();
    if (pinnedTo) {
      pinnedTo.classList.remove('active');
      pinnedTo = null;
      el.classList.remove('pinned');
    }
  }

  function selectionKey(state) {
    const s = state.selection.main;
    return `${s.anchor}:${s.head}:${state.doc.length}`;
  }

  function schedule() {
    cancelAnimationFrame(raf);
    raf = requestAnimationFrame(update);
  }

  function paintState(state) {
    const fs = formatState(state);
    el.querySelector('.fp-b').classList.toggle('active', fs.b);
    el.querySelector('.fp-u').classList.toggle('active', fs.u);
    el.querySelector('.fp-code').classList.toggle('active', fs.code);
    el.querySelector('.fp-section').classList.toggle('active', fs.section);
    el.querySelector('.fp-link').classList.toggle('active', Boolean(fs.link));
    el.classList.toggle('in-code', fs.inCodeBlock);
    for (const sw of el.querySelectorAll('.fp-swatch')) sw.classList.toggle('active', sw.dataset.color === fs.color);
  }

  function place(top, left) {
    const w = el.offsetWidth;
    el.style.top = `${top}px`;
    el.style.left = `${Math.max(8, Math.min(left, window.innerWidth - w - 8))}px`;
  }

  function update() {
    if (!view || view.state.readOnly) return hide();
    const { state } = view;
    const sel = state.selection.main;

    if (pinnedTo) {
      paintState(state);
      el.hidden = false;
      paintFocus();
      const r = pinnedTo.getBoundingClientRect();
      place(r.bottom + 8, r.left);
      return;
    }

    if (sel.empty || pointerDown || !view.hasFocus || dismissedFor === selectionKey(state)) return hide();
    dismissedFor = null;
    paintState(state);
    const start = view.coordsAtPos(sel.from, 1);
    const end = view.coordsAtPos(sel.to, -1);
    if (!start || !end) return hide();
    const wasHidden = el.hidden;
    el.hidden = false;
    if (wasHidden) focus = null;
    paintFocus();
    const h = el.offsetHeight;
    const gap = 8;
    let top = end.bottom + gap;
    if (top + h > window.innerHeight - 4) top = Math.max(4, start.top - h - gap);
    place(top, (sel.head === sel.from ? start.left : end.left) - el.offsetWidth / 2);
  }

  function flashHint(text) {
    clearTimeout(hintTimer);
    hint.textContent = text;
    hint.classList.add('warn');
    hintTimer = setTimeout(() => {
      hint.textContent = 'Enter applies · Esc closes';
      hint.classList.remove('warn');
    }, 1600);
  }

  function run(btn) {
    if (!view || !btn) return;
    const op = { type: btn.dataset.op };
    if (op.type === 'color') op.color = btn.dataset.color;
    // With nothing selected (pinned bar), format the word at the cursor. Section works on
    // the cursor's line either way.
    const sel = view.state.selection.main;
    const wordAtCursor = sel.empty && op.type !== 'section';
    if (wordAtCursor) {
      const word = view.state.wordAt(sel.head);
      if (!word) {
        flashHint('Select some text first');
        view.focus();
        return;
      }
      view.dispatch({ selection: { anchor: word.from, head: word.to } });
    }
    if (op.type === 'link') {
      const current = formatState(view.state).link;
      const answer = window.prompt(current ? 'Edit the link (leave empty to remove it):' : 'Link to:', current || 'https://');
      const url = answer === null ? undefined : linkUrl(answer);
      if (url === undefined) {
        if (answer !== null) flashHint("That isn't a web address");
        if (wordAtCursor) view.dispatch({ selection: { anchor: sel.head } });
        view.focus();
        schedule();
        return;
      }
      op.url = url;
    }
    const spec = applyFormat(view.state, op);
    if (spec) view.dispatch(spec);
    // Put the cursor back (at the end of the word) so typing and arrow keys carry on as before.
    if (wordAtCursor) view.dispatch({ selection: { anchor: view.state.selection.main.to } });
    view.focus();
    schedule();
  }

  // The URL typed into the Link prompt: null to remove the link, undefined if it isn't valid.
  function linkUrl(input) {
    let url = input.trim();
    if (!url) return null;
    if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
    return URL_RE.test(url) ? url : undefined;
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
  // A pinned popup closes when you click somewhere other than the editor or the popup.
  window.addEventListener('mousedown', (e) => {
    if (!pinnedTo || el.contains(e.target) || pinnedTo.contains(e.target) || view?.dom.contains(e.target)) return;
    hide();
  }, true);
  window.addEventListener('resize', schedule);
  window.addEventListener('scroll', schedule, true);

  const keys = Prec.highest(keymap.of([
    { key: 'ArrowLeft', run: () => ownsKeys() && move(0, -1) },
    { key: 'ArrowRight', run: () => ownsKeys() && move(0, 1) },
    { key: 'ArrowUp', run: () => ownsKeys() && move(-1, 0) },
    { key: 'ArrowDown', run: () => ownsKeys() && move(1, 0) },
    {
      key: 'Enter',
      run: () => {
        if (!ownsKeys()) return false;
        if (focus) run(rows[focus[0]][focus[1]]);
        else if (pinnedTo) return false;
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
          if (!pinnedTo) hide();
        }
        return false;
      },
    }),
  ];

  return {
    extension,
    hide,
    attach(v) {
      view = v;
    },
    // Opens the popup under a menu bar button, or closes it if it's already open there.
    toggle(button) {
      if (pinnedTo === button) return hide();
      if (!view || view.state.readOnly) return;
      hide();
      pinnedTo = button;
      button.classList.add('active');
      el.classList.add('pinned');
      view.focus();
      update();
    },
  };
}
