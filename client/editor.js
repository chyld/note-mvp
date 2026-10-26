import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { renderField, eofField, collapsedField, noteIdFacet, bypass } from './render.js';
import { renderEditing, codeTabs } from './editing.js';
import { createPopup } from './popup.js';
import { applyFormat } from './format-ops.js';
import { parseDoc, parseInline, URL_RE } from '../shared/format.js';

const modeComp = new Compartment();
const editableComp = new Compartment();

const renderMode = [renderField, renderEditing, EditorView.editorAttributes.of({ class: 'mode-render' })];
const rawMode = EditorView.editorAttributes.of({ class: 'mode-raw' });

// opts: { parent, onChange(text), onCollapsedChange(keys), onPasteImage(file) -> Promise<name>, onError(msg) }
export function createEditor(opts) {
  const popup = createPopup();
  let mode = 'render';
  let readOnly = false;

  const extensions = (noteId, collapsed) => [
    noteIdFacet.of(noteId),
    collapsedField.init(() => new Set(collapsed)),
    history(),
    drawSelection(),
    EditorView.lineWrapping,
    eofField,
    popup.extension,
    codeTabs,
    keymap.of([...defaultKeymap, ...historyKeymap]),
    modeComp.of(mode === 'render' ? renderMode : rawMode),
    editableComp.of(editableExt()),
    EditorView.contentAttributes.of({ spellcheck: 'true', autocorrect: 'off', autocapitalize: 'off' }),
    EditorView.updateListener.of((u) => {
      if (u.docChanged) opts.onChange(u.state.doc.toString());
      if (u.selectionSet || u.docChanged || u.focusChanged || u.geometryChanged) scheduleLinkChip();
      const before = u.startState.field(collapsedField);
      const after = u.state.field(collapsedField);
      if (before !== after) opts.onCollapsedChange([...after]);
    }),
    EditorView.domEventHandlers({
      paste: (e, view) => handlePaste(e, view),
      mousedown: (e, view) => openLinkOnModClick(e, view),
      mousemove: (e, view) => showCopyButton(e, view),
      mouseleave: (e, view) => showCopyButton(null, view),
    }),
  ];

  const editableExt = () => (readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []);

  const view = new EditorView({
    parent: opts.parent,
    state: EditorState.create({ doc: '', extensions: extensions('', []) }),
  });
  popup.attach(view);

  function handlePaste(e, v) {
    const files = [...(e.clipboardData?.items || [])].filter((i) => i.kind === 'file').map((i) => i.getAsFile()).filter(Boolean);
    if (!files.length) return pasteLinkOverSelection(e, v);
    e.preventDefault();
    if (readOnly) return true;
    const file = files[0];
    if (file.type !== 'image/png') {
      opts.onError('Only PNG screenshots are allowed');
      return true;
    }
    opts.onPasteImage(file).then((name) => {
      if (!name || v.state.facet(noteIdFacet) !== currentId) return;
      const { state } = v;
      const sel = state.selection.main;
      const line = state.doc.lineAt(sel.from);
      const endLine = state.doc.lineAt(sel.to);
      const before = sel.from > line.from ? '\n' : '';
      const after = sel.to < endLine.to ? '\n' : '';
      const insert = `${before}![](${name})${after}`;
      v.dispatch({
        changes: { from: sel.from, to: sel.to, insert },
        selection: { anchor: sel.from + insert.length },
        annotations: bypass.of(true),
        userEvent: 'input.paste',
        scrollIntoView: true,
      });
      v.focus();
    }).catch((err) => opts.onError(err.message || 'Upload failed'));
    return true;
  }

  // Pasting a URL while text is selected turns the text into a link to it.
  function pasteLinkOverSelection(e, v) {
    const url = e.clipboardData?.getData('text/plain').trim();
    const sel = v.state.selection.main;
    if (readOnly || !url || !URL_RE.test(url) || sel.empty) return false;
    if (v.state.doc.lineAt(sel.from).number !== v.state.doc.lineAt(sel.to).number) return false;
    const spec = applyFormat(v.state, { type: 'link', url });
    if (!spec) return false;
    e.preventDefault();
    v.dispatch(spec);
    return true;
  }

  // The link (or bare URL) token at a document position, if any. Links in code don't count.
  function linkAt(state, pos) {
    const line = state.doc.lineAt(pos);
    if (parseDoc(state.doc.toString()).lines[line.number - 1].block) return null;
    return parseInline(line.text, line.from)
      .find((t) => (t.type === 'link' || t.type === 'url') && t.from <= pos && pos <= t.to) || null;
  }

  const openUrl = (url) => window.open(url, '_blank', 'noopener,noreferrer');

  // Ctrl+click (Cmd+click on Mac) opens a link in a new tab, in either mode.
  function openLinkOnModClick(e, v) {
    if (e.button !== 0 || !(e.ctrlKey || e.metaKey)) return false;
    const pos = v.posAtCoords({ x: e.clientX, y: e.clientY });
    const link = pos == null ? null : linkAt(v.state, pos);
    if (!link) return false;
    e.preventDefault();
    openUrl(link.url);
    return true;
  }

  // Touch screens have no Ctrl+click: with the cursor in a link, a chip above it opens the link.
  const coarse = matchMedia('(pointer: coarse)');
  const chip = document.createElement('button');
  chip.type = 'button';
  chip.className = 'link-chip';
  chip.hidden = true;
  chip.innerHTML = '<svg><use href="#i-external"/></svg><span></span>';
  document.body.appendChild(chip);
  let chipUrl = null;
  let chipRaf = 0;
  chip.addEventListener('mousedown', (e) => e.preventDefault());
  chip.addEventListener('click', () => chipUrl && openUrl(chipUrl));
  window.addEventListener('scroll', () => scheduleLinkChip(), true);

  function scheduleLinkChip() {
    cancelAnimationFrame(chipRaf);
    chipRaf = requestAnimationFrame(updateLinkChip);
  }

  function updateLinkChip() {
    const { state } = view;
    const sel = state.selection.main;
    const link = coarse.matches && view.hasFocus && sel.empty ? linkAt(state, sel.head) : null;
    const at = link && view.coordsAtPos(sel.head);
    if (!at) {
      chip.hidden = true;
      chipUrl = null;
      return;
    }
    chipUrl = link.url;
    chip.querySelector('span').textContent = link.url.replace(/^https?:\/\//, '');
    chip.hidden = false;
    const w = chip.offsetWidth;
    const h = chip.offsetHeight;
    const top = at.top - h - 10 < 8 ? at.bottom + 10 : at.top - h - 10;
    chip.style.top = `${top}px`;
    chip.style.left = `${Math.max(8, Math.min(at.left - w / 2, window.innerWidth - w - 8))}px`;
  }

  // Links show a pointer while Ctrl/Cmd is held.
  const armLinks = (e) => opts.parent.classList.toggle('links-armed', e.ctrlKey || e.metaKey);
  window.addEventListener('keydown', armLinks);
  window.addEventListener('keyup', armLinks);
  window.addEventListener('blur', () => opts.parent.classList.remove('links-armed'));

  // Code blocks show their Copy button while hovered.
  let hoverBlock = null;
  function showCopyButton(e, v) {
    let block = null;
    if (e) {
      const line = e.target.closest?.('.cm-cb');
      if (line) {
        let open = line;
        while (open && !open.classList.contains('cm-cb-open')) open = open.previousElementSibling;
        block = open?.querySelector('.cm-copy')?.dataset.block ?? null;
      }
    }
    if (block === hoverBlock) return false;
    hoverBlock = block;
    for (const btn of v.dom.querySelectorAll('.cm-copy')) btn.classList.toggle('show', btn.dataset.block === block);
    return false;
  }

  let currentId = '';

  return {
    view,
    load({ id, text, collapsed = [], readOnly: ro = false }) {
      currentId = id;
      readOnly = ro;
      popup.hide();
      view.setState(EditorState.create({ doc: text, extensions: extensions(id, collapsed) }));
      hoverBlock = null;
    },
    setMode(m) {
      mode = m;
      popup.hide();
      view.dispatch({ effects: modeComp.reconfigure(m === 'render' ? renderMode : rawMode) });
    },
    setReadOnly(ro) {
      readOnly = ro;
      popup.hide();
      view.dispatch({ effects: editableComp.reconfigure(editableExt()) });
    },
    toggleFormatBar: (button) => popup.toggle(button),
    text: () => view.state.doc.toString(),
    focus: () => view.focus(),
  };
}
