import { createEditor } from './editor.js';
import { HUES } from '../shared/format.js';
import { darkShade } from './colors.js';

const $ = (id) => document.getElementById(id);
const els = {
  app: $('app'),
  noteList: $('note-list'),
  tagFilter: $('tag-filter'),
  search: $('search'),
  trashHead: $('trash-head'),
  trashToggle: $('trash-toggle'),
  noteTools: $('note-tools'),
  save: $('save'),
  tagChips: $('tag-chips'),
  tagInput: $('tag-input'),
  tagSuggest: $('tag-suggest'),
  trashBanner: $('trash-banner'),
  editorWrap: $('editor-wrap'),
  emptyState: $('empty-state'),
  toast: $('toast'),
};

const state = {
  user: '',
  notes: [],
  tags: [],
  filterTag: '',
  query: '',
  trashView: false,
  note: null, // { id, tags, trashedAt, ... } of the open note
  savedText: '',
  saveState: 'clean', // clean | dirty | saving | error
  mode: localStorage.getItem('margin:mode') === 'raw' ? 'raw' : 'render',
};

// ---------- API ----------

async function api(method, url, body, headers = {}) {
  const init = { method, headers: { ...headers } };
  if (body instanceof Blob) {
    init.body = body;
  } else if (body !== undefined) {
    init.body = JSON.stringify(body);
    init.headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(url, init);
  if (res.status === 401) {
    if (!isDirty()) location.reload();
    throw new Error('Your session has ended. Copy any unsaved text, then reload to log in.');
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
  return data;
}

// ---------- Helpers ----------

let toastTimer = 0;
function toast(msg, kind = 'info') {
  els.toast.textContent = msg;
  els.toast.dataset.kind = kind;
  els.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { els.toast.hidden = true; }, kind === 'error' ? 5000 : 2500);
}

const fail = (err) => toast(err.message || String(err), 'error');

// Every tag (and user) gets its own color, picked from the 12 highlight hues by its name.
function hueFor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const [, light, deep] = HUES[h % HUES.length];
  return { light, deep, dark: darkShade(deep) };
}

function colorize(el, name) {
  const c = hueFor(name);
  el.style.setProperty('--tag-light', c.light);
  el.style.setProperty('--tag-deep', c.deep);
  el.style.setProperty('--tag-dark', c.dark);
  return el;
}

const formatDate = (iso) => (iso ? new Date(iso).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }) : '');

function isDirty() {
  return Boolean(state.note) && !state.note.trashedAt && editor.text() !== state.savedText;
}

function confirmDiscard() {
  return !isDirty() || confirm('You have unsaved changes. Discard them?');
}

function updateUrl() {
  let url = '/';
  if (state.note) url = `/?note=${state.note.id}`;
  else if (state.filterTag) url = `/?tag=${encodeURIComponent(state.filterTag)}`;
  history.replaceState(null, '', url);
}

const collapsedKey = (id) => `margin:collapsed:${id}`;
function loadCollapsed(id) {
  try {
    return JSON.parse(localStorage.getItem(collapsedKey(id))) || [];
  } catch {
    return [];
  }
}

// ---------- Editor ----------

const editor = createEditor({
  parent: $('editor'),
  onChange: () => updateSaveButton(),
  onCollapsedChange: (keys) => {
    if (!state.note) return;
    if (keys.length) localStorage.setItem(collapsedKey(state.note.id), JSON.stringify(keys));
    else localStorage.removeItem(collapsedKey(state.note.id));
  },
  onPasteImage: async (file) => {
    if (!state.note) return null;
    const id = state.note.id;
    toast('Uploading screenshot…');
    const { name } = await api('POST', `/api/notes/${id}/images`, file, { 'Content-Type': 'image/png' });
    els.toast.hidden = true;
    return name;
  },
  onError: (msg) => toast(msg, 'error'),
});
editor.setMode(state.mode);

function updateSaveButton() {
  if (state.saveState !== 'saving') state.saveState = isDirty() ? 'dirty' : state.saveState === 'error' ? 'error' : 'clean';
  if (state.saveState === 'error' && !isDirty()) state.saveState = 'clean';
  const labels = {
    clean: 'Saved (Ctrl+S)',
    dirty: 'Unsaved changes · click to save (Ctrl+S)',
    saving: 'Saving…',
    error: 'Save failed · click to retry',
  };
  els.save.dataset.state = state.saveState;
  els.save.title = labels[state.saveState];
}

function setMode(mode) {
  state.mode = mode;
  localStorage.setItem('margin:mode', mode);
  editor.setMode(mode);
  const toggle = $('mode-toggle');
  toggle.dataset.mode = mode;
  toggle.title = mode === 'render' ? 'Render mode · click for raw (Ctrl+E)' : 'Raw mode · click for render (Ctrl+E)';
}

// ---------- Notes ----------

async function save() {
  if (!state.note || state.note.trashedAt || state.saveState === 'saving') return;
  const id = state.note.id;
  const text = editor.text();
  state.saveState = 'saving';
  updateSaveButton();
  try {
    const meta = await api('PUT', `/api/notes/${id}`, { text });
    if (state.note?.id !== id) return;
    state.savedText = text;
    state.note.modified = meta.modified;
    state.saveState = 'clean';
    refreshList();
  } catch (err) {
    state.saveState = 'error';
    fail(err);
  } finally {
    if (state.saveState === 'saving') state.saveState = 'clean';
    updateSaveButton();
  }
}

async function openNote(id, { focus = false } = {}) {
  if (state.note?.id === id) return;
  if (!confirmDiscard()) return;
  try {
    const note = await api('GET', `/api/notes/${id}`);
    showNote(note);
    if (focus) editor.focus();
  } catch (err) {
    fail(err);
  }
}

function showNote(note) {
  state.note = note;
  state.savedText = note.text;
  state.saveState = 'clean';
  editor.load({ id: note.id, text: note.text, collapsed: loadCollapsed(note.id), readOnly: Boolean(note.trashedAt) });
  els.editorWrap.hidden = false;
  els.emptyState.hidden = true;
  els.noteTools.hidden = false;
  els.trashBanner.hidden = !note.trashedAt;
  $('trash-note').hidden = Boolean(note.trashedAt);
  els.save.hidden = Boolean(note.trashedAt);
  $('format-btn').hidden = Boolean(note.trashedAt);
  els.tagInput.disabled = Boolean(note.trashedAt);
  renderTagChips();
  updateSaveButton();
  renderList();
  updateUrl();
}

function closeNote() {
  state.note = null;
  state.savedText = '';
  editor.load({ id: '', text: '' });
  els.editorWrap.hidden = true;
  els.emptyState.hidden = false;
  els.noteTools.hidden = true;
  els.trashBanner.hidden = true;
  renderList();
  updateUrl();
}

async function newNote() {
  if (!confirmDiscard()) return;
  try {
    const note = await api('POST', '/api/notes', { tags: state.filterTag ? [state.filterTag] : [] });
    if (state.trashView) setTrashView(false);
    state.query = '';
    els.search.value = '';
    showNote(note);
    editor.focus();
    await Promise.all([refreshList(), refreshTags()]);
  } catch (err) {
    fail(err);
  }
}

async function trashNote() {
  const note = state.note;
  if (!note) return;
  if (isDirty() && !confirm('Move this note to the trash? Your unsaved changes will be lost.')) return;
  try {
    await api('POST', `/api/notes/${note.id}/trash`);
    state.savedText = editor.text();
    closeNote();
    toast('Moved to trash');
    await Promise.all([refreshList(), refreshTags()]);
  } catch (err) {
    fail(err);
  }
}

async function restoreNote() {
  const note = state.note;
  if (!note) return;
  try {
    await api('POST', `/api/notes/${note.id}/restore`);
    const fresh = await api('GET', `/api/notes/${note.id}`);
    if (state.trashView) setTrashView(false);
    showNote(fresh);
    toast('Restored');
    await Promise.all([refreshList(), refreshTags()]);
  } catch (err) {
    fail(err);
  }
}

async function deleteForever() {
  const note = state.note;
  if (!note || !confirm('Delete this note forever? Its screenshots are deleted too. This can\'t be undone.')) return;
  try {
    await api('DELETE', `/api/notes/${note.id}`);
    closeNote();
    await refreshList();
  } catch (err) {
    fail(err);
  }
}

async function emptyTrash() {
  if (!state.notes.length) return;
  if (!confirm(`Delete ${state.notes.length} note${state.notes.length === 1 ? '' : 's'} in the trash forever? This can't be undone.`)) return;
  try {
    await api('POST', '/api/trash/empty');
    if (state.note?.trashedAt) closeNote();
    await refreshList();
  } catch (err) {
    fail(err);
  }
}

// ---------- Tags ----------

const cleanTag = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, '');

async function setTags(tags) {
  const note = state.note;
  if (!note) return;
  const previous = note.tags;
  note.tags = tags;
  renderTagChips();
  updateSuggestions();
  try {
    await api('PUT', `/api/notes/${note.id}/tags`, { tags });
    await Promise.all([refreshList(), refreshTags()]);
  } catch (err) {
    note.tags = previous;
    renderTagChips();
    fail(err);
  }
  updateSuggestions();
}

function renderTagChips() {
  els.tagChips.replaceChildren(...(state.note?.tags || []).map((t) => {
    const chip = colorize(document.createElement('span'), t);
    chip.className = 'tag-chip';
    chip.textContent = t;
    if (!state.note.trashedAt) {
      const x = document.createElement('button');
      x.type = 'button';
      x.className = 'tag-x';
      x.title = `Remove tag ${t}`;
      x.textContent = '×';
      x.addEventListener('click', () => setTags(state.note.tags.filter((n) => n !== t)));
      chip.appendChild(x);
    }
    return chip;
  }));
}

function addTag(tag) {
  els.tagInput.value = '';
  if (tag && state.note && !state.note.tags.includes(tag)) setTags([...state.note.tags, tag]);
  else updateSuggestions();
}

function addTagFromInput() {
  addTag(cleanTag(els.tagInput.value));
}

// Suggestions while adding a tag: the user's existing tags (from their notes), best match
// first, plus an "Add new tag" entry when what's typed isn't a tag yet.
let suggestions = [];
let suggestIndex = -1;

function updateSuggestions() {
  if (document.activeElement !== els.tagInput || !state.note) {
    suggestions = [];
  } else {
    const q = els.tagInput.value;
    const have = new Set(state.note.tags);
    suggestions = state.tags
      .filter((t) => !have.has(t.tag) && t.tag.includes(q))
      .sort((a, b) => (b.tag.startsWith(q) - a.tag.startsWith(q)) || b.count - a.count || a.tag.localeCompare(b.tag))
      .slice(0, 8);
    if (q && !have.has(q) && !state.tags.some((t) => t.tag === q)) suggestions.push({ tag: q, isNew: true });
  }
  // With something typed, Enter takes the best match; with nothing typed, nothing is picked yet.
  suggestIndex = els.tagInput.value && suggestions.length ? 0 : -1;
  renderSuggestions();
}

function renderSuggestions() {
  els.tagSuggest.hidden = !suggestions.length;
  els.tagSuggest.replaceChildren(...suggestions.map((s, i) => {
    const li = document.createElement('li');
    li.className = i === suggestIndex ? 'active' : '';
    if (s.isNew) {
      const label = document.createElement('span');
      label.className = 'new';
      label.append('Add new tag ', Object.assign(document.createElement('b'), { textContent: s.tag }));
      li.append(label);
    } else {
      const name = colorize(document.createElement('span'), s.tag);
      name.className = 'sg-name';
      name.textContent = s.tag;
      const count = document.createElement('span');
      count.className = 'count';
      count.textContent = s.count;
      li.append(name, count);
    }
    li.addEventListener('mousedown', (e) => {
      e.preventDefault();
      addTag(s.tag);
    });
    li.addEventListener('mousemove', () => {
      if (suggestIndex !== i) {
        suggestIndex = i;
        renderSuggestions();
      }
    });
    return li;
  }));
  els.tagSuggest.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
}

async function refreshTags() {
  try {
    state.tags = await api('GET', '/api/tags');
  } catch (err) {
    return fail(err);
  }
  const options = [{ value: '', label: 'All notes' }, ...state.tags.map((t) => ({ value: t.tag, label: `${t.tag} (${t.count})` }))];
  if (state.filterTag && !state.tags.some((t) => t.tag === state.filterTag)) {
    options.push({ value: state.filterTag, label: `${state.filterTag} (0)` });
  }
  els.tagFilter.replaceChildren(...options.map((o) => {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    return opt;
  }));
  els.tagFilter.value = state.filterTag;
}

// ---------- Sidebar ----------

let listSeq = 0;
async function refreshList() {
  const seq = ++listSeq;
  const params = new URLSearchParams();
  if (state.trashView) params.set('trash', '1');
  else if (state.filterTag) params.set('tag', state.filterTag);
  if (state.query) params.set('q', state.query);
  try {
    const notes = await api('GET', `/api/notes?${params}`);
    if (seq !== listSeq) return;
    state.notes = notes;
    renderList();
  } catch (err) {
    fail(err);
  }
}

function renderList() {
  const items = state.notes.map((n) => {
    const li = document.createElement('li');
    li.className = 'note-item' + (state.note?.id === n.id ? ' active' : '');
    if (n.tags.length) colorize(li, n.tags[0]);
    else li.classList.add('no-tags');
    li.dataset.id = n.id;
    const title = document.createElement('div');
    title.className = 'note-title' + (n.title ? '' : ' untitled');
    title.textContent = n.title || 'Untitled';
    const date = document.createElement('div');
    date.className = 'note-date';
    date.textContent = state.trashView ? `Trashed ${formatDate(n.trashedAt)}` : formatDate(n.modified);
    li.append(title, date);
    if (n.tags.length) {
      const tags = document.createElement('div');
      tags.className = 'note-tags';
      for (const t of n.tags) {
        const s = colorize(document.createElement('span'), t);
        s.className = 'tag-chip small';
        s.textContent = t;
        tags.appendChild(s);
      }
      li.appendChild(tags);
    }
    return li;
  });
  if (!items.length) {
    const li = document.createElement('li');
    li.className = 'note-empty';
    li.textContent = state.trashView ? 'Trash is empty' : state.query || state.filterTag ? 'No matching notes' : 'No notes yet';
    items.push(li);
  }
  els.noteList.replaceChildren(...items);
  $('empty-trash').disabled = !state.notes.length;
}

function setTrashView(on) {
  state.trashView = on;
  els.app.classList.toggle('trash-view', on);
  els.trashHead.hidden = !on;
  els.tagFilter.disabled = on;
  els.trashToggle.innerHTML = on
    ? '<svg><use href="#i-back"/></svg> <span>Back to notes</span>'
    : '<svg><use href="#i-trash"/></svg> <span>Trash</span>';
}

// Home: all notes, nothing open, no filters.
function goHome() {
  if (!confirmDiscard()) return;
  if (state.trashView) setTrashView(false);
  state.filterTag = '';
  state.query = '';
  els.search.value = '';
  closeNote();
  refreshList();
  refreshTags();
}

function setSidebar(collapsed) {
  els.app.classList.toggle('sidebar-collapsed', collapsed);
  $('sb-expand').hidden = !collapsed;
  localStorage.setItem('margin:sidebar', collapsed ? 'collapsed' : 'open');
}

// ---------- Events ----------

$('new-note').addEventListener('click', newNote);
$('new-note-2').addEventListener('click', newNote);
els.save.addEventListener('click', save);
$('trash-note').addEventListener('click', trashNote);
$('restore-note').addEventListener('click', restoreNote);
$('delete-note').addEventListener('click', deleteForever);
$('empty-trash').addEventListener('click', emptyTrash);
$('sb-collapse').addEventListener('click', () => setSidebar(true));
$('home').addEventListener('click', (e) => {
  // Let modified clicks (new tab, new window) through as a normal link.
  if (e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
  e.preventDefault();
  goHome();
});
$('sb-expand').addEventListener('click', () => setSidebar(false));

$('mode-toggle').addEventListener('click', () => setMode(state.mode === 'render' ? 'raw' : 'render'));

const formatBtn = $('format-btn');
formatBtn.addEventListener('mousedown', (e) => e.preventDefault()); // keep the editor's selection
formatBtn.addEventListener('click', () => editor.toggleFormatBar(formatBtn));

els.noteList.addEventListener('click', (e) => {
  const li = e.target.closest('.note-item');
  if (li) openNote(li.dataset.id);
});

els.tagFilter.addEventListener('change', () => {
  state.filterTag = els.tagFilter.value;
  refreshList();
  refreshTags();
  updateUrl();
});

let searchTimer = 0;
els.search.addEventListener('input', () => {
  clearTimeout(searchTimer);
  searchTimer = setTimeout(() => {
    state.query = els.search.value.trim();
    refreshList();
  }, 200);
});

els.trashToggle.addEventListener('click', () => {
  setTrashView(!state.trashView);
  refreshList();
});

els.tagInput.addEventListener('input', () => {
  const v = els.tagInput.value;
  // A space or comma finishes the tag.
  if (/[\s,]/.test(v)) {
    els.tagInput.value = v.split(/[\s,]/)[0];
    addTagFromInput();
    return;
  }
  const clean = cleanTag(v);
  if (clean !== v) els.tagInput.value = clean;
  updateSuggestions();
});
els.tagInput.addEventListener('keydown', (e) => {
  if ((e.key === 'ArrowDown' || e.key === 'ArrowUp') && suggestions.length) {
    e.preventDefault();
    const step = e.key === 'ArrowDown' ? 1 : -1;
    suggestIndex = suggestIndex < 0 && step < 0 ? suggestions.length - 1 : (suggestIndex + step + suggestions.length) % suggestions.length;
    renderSuggestions();
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (suggestIndex >= 0) addTag(suggestions[suggestIndex].tag);
    else addTagFromInput();
  } else if (e.key === 'Backspace' && !els.tagInput.value && state.note?.tags.length) {
    setTags(state.note.tags.slice(0, -1));
  } else if (e.key === 'Escape') {
    if (suggestions.length && els.tagInput.value === '') {
      suggestions = [];
      renderSuggestions();
      return;
    }
    els.tagInput.value = '';
    editor.focus();
  }
});
els.tagInput.addEventListener('focus', updateSuggestions);
els.tagInput.addEventListener('blur', () => {
  addTagFromInput();
  suggestions = [];
  renderSuggestions();
});

$('logout').addEventListener('click', async () => {
  if (!confirmDiscard()) return;
  state.savedText = editor.text();
  await api('POST', '/api/logout').catch(() => {});
  location.href = '/';
});

window.addEventListener('keydown', (e) => {
  const mod = e.ctrlKey || e.metaKey;
  if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 's') {
    e.preventDefault();
    save();
  } else if (mod && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'e') {
    e.preventDefault();
    setMode(state.mode === 'render' ? 'raw' : 'render');
  }
});

window.addEventListener('beforeunload', (e) => {
  if (isDirty()) {
    e.preventDefault();
    e.returnValue = '';
  }
});

// ---------- Start ----------

async function start() {
  setMode(state.mode);
  setSidebar(localStorage.getItem('margin:sidebar') === 'collapsed');
  const params = new URLSearchParams(location.search);
  state.filterTag = params.get('tag') || '';
  try {
    state.user = (await api('GET', '/api/session')).user;
    $('username').textContent = state.user;
    const avatar = colorize($('avatar'), state.user);
    avatar.textContent = state.user.slice(0, 1).toUpperCase();
  } catch (err) {
    return fail(err);
  }
  await Promise.all([refreshTags(), refreshList()]);
  const id = params.get('note');
  if (id) await openNote(id);
  else updateUrl();
}

start();

// Handy for poking at the editor from the browser console.
window.margin = { view: editor.view };
