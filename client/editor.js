import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import { renderField, eofField, collapsedField, noteIdFacet, bypass } from './render.js';
import { renderEditing, codeTabs } from './editing.js';
import { createPopup } from './popup.js';

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
      const before = u.startState.field(collapsedField);
      const after = u.state.field(collapsedField);
      if (before !== after) opts.onCollapsedChange([...after]);
    }),
    EditorView.domEventHandlers({
      paste: (e, view) => handlePaste(e, view),
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
    if (!files.length) return false;
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
