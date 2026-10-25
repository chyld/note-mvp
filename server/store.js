// File storage. Layout:
//   DATA_DIR/users.json
//   DATA_DIR/sessions.json
//   DATA_DIR/notes/<user>/<noteId>/note.md     note text
//   DATA_DIR/notes/<user>/<noteId>/meta.json   { created, modified, tags, trashedAt }
//   DATA_DIR/notes/<user>/<noteId>/<id>.png    screenshots
import fs from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { noteTitle, visibleText } from '../shared/format.js';

export const DATA_DIR = path.resolve(process.env.DATA_DIR || './data');
const NOTES_DIR = path.join(DATA_DIR, 'notes');

export const ID_RE = /^[a-z0-9]{8}$/;
export const IMAGE_NAME_RE = /^[a-z0-9]{8}\.png$/;
export const TAG_RE = /^[a-z0-9]+$/;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export function randomId() {
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const bytes = crypto.randomBytes(8);
  let id = '';
  for (const b of bytes) id += alphabet[b % 36];
  return id;
}

export async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8'));
  } catch (err) {
    if (err.code === 'ENOENT') return fallback;
    throw err;
  }
}

export async function writeJson(file, value) {
  await writeAtomic(file, JSON.stringify(value, null, 2) + '\n');
}

async function writeAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tmp, data);
  await fs.rename(tmp, file);
}

const userDir = (user) => path.join(NOTES_DIR, user);
const noteDir = (user, id) => path.join(userDir(user), id);

export function cleanTags(tags) {
  if (!Array.isArray(tags)) return null;
  const out = [];
  for (const t of tags) {
    if (typeof t !== 'string' || !TAG_RE.test(t)) return null;
    if (!out.includes(t)) out.push(t);
  }
  return out;
}

async function readNote(user, id) {
  const dir = noteDir(user, id);
  const meta = await readJson(path.join(dir, 'meta.json'), null);
  if (!meta) return null;
  let text = '';
  try {
    text = await fs.readFile(path.join(dir, 'note.md'), 'utf8');
  } catch (err) {
    if (err.code !== 'ENOENT') throw err;
  }
  return { id, text, ...meta };
}

export async function getNote(user, id) {
  if (!ID_RE.test(id)) return null;
  return readNote(user, id);
}

async function allNotes(user) {
  let ids;
  try {
    ids = await fs.readdir(userDir(user));
  } catch (err) {
    if (err.code === 'ENOENT') return [];
    throw err;
  }
  const notes = await Promise.all(ids.filter((id) => ID_RE.test(id)).map((id) => readNote(user, id)));
  return notes.filter(Boolean);
}

function summary(note) {
  return {
    id: note.id,
    title: noteTitle(note.text),
    modified: note.modified,
    created: note.created,
    tags: note.tags,
    trashedAt: note.trashedAt,
  };
}

export async function listNotes(user, { tag, q, trash } = {}) {
  let notes = await allNotes(user);
  notes = notes.filter((n) => (trash ? n.trashedAt : !n.trashedAt));
  if (tag) notes = notes.filter((n) => n.tags.includes(tag));
  if (q) {
    const terms = q.toLowerCase().split(/\s+/).filter(Boolean);
    notes = notes.filter((n) => {
      const hay = visibleText(n.text).toLowerCase();
      return terms.every((t) => hay.includes(t));
    });
  }
  const key = trash ? 'trashedAt' : 'modified';
  notes.sort((a, b) => (b[key] || '').localeCompare(a[key] || ''));
  return notes.map(summary);
}

export async function listTags(user) {
  const counts = new Map();
  for (const n of await allNotes(user)) {
    if (n.trashedAt) continue;
    for (const t of n.tags) counts.set(t, (counts.get(t) || 0) + 1);
  }
  return [...counts].sort((a, b) => a[0].localeCompare(b[0])).map(([tag, count]) => ({ tag, count }));
}

export async function createNote(user, { tags = [], text = '' } = {}) {
  let id;
  do id = randomId(); while (await getNote(user, id));
  const now = new Date().toISOString();
  const meta = { created: now, modified: now, tags, trashedAt: null };
  const dir = noteDir(user, id);
  await fs.mkdir(dir, { recursive: true });
  await writeAtomic(path.join(dir, 'note.md'), text);
  await writeJson(path.join(dir, 'meta.json'), meta);
  return { id, text, ...meta };
}

async function updateMeta(user, id, fn) {
  const file = path.join(noteDir(user, id), 'meta.json');
  const meta = await readJson(file, null);
  if (!meta) return null;
  fn(meta);
  await writeJson(file, meta);
  return meta;
}

export async function saveText(user, id, text) {
  if (!(await getNote(user, id))) return null;
  await writeAtomic(path.join(noteDir(user, id), 'note.md'), text);
  return updateMeta(user, id, (m) => { m.modified = new Date().toISOString(); });
}

// Tag changes don't count as a modification.
export function saveTags(user, id, tags) {
  return updateMeta(user, id, (m) => { m.tags = tags; });
}

export function setTrashed(user, id, trashed) {
  return updateMeta(user, id, (m) => { m.trashedAt = trashed ? new Date().toISOString() : null; });
}

export async function deleteNote(user, id) {
  await fs.rm(noteDir(user, id), { recursive: true, force: true });
}

export async function emptyTrash(user) {
  const trashed = (await allNotes(user)).filter((n) => n.trashedAt);
  await Promise.all(trashed.map((n) => deleteNote(user, n.id)));
  return trashed.length;
}

// Streams a PNG upload to disk (no size limit). Returns the image name, or null if not a PNG.
export async function saveImage(user, id, stream) {
  const dir = noteDir(user, id);
  let name;
  do name = `${randomId()}.png`; while (await exists(path.join(dir, name)));
  const tmp = path.join(dir, `${name}.upload`);
  await pipeline(stream, createWriteStream(tmp));
  const fh = await fs.open(tmp, 'r');
  const head = Buffer.alloc(8);
  await fh.read(head, 0, 8, 0);
  await fh.close();
  if (!head.equals(PNG_SIGNATURE)) {
    await fs.rm(tmp, { force: true });
    return null;
  }
  await fs.rename(tmp, path.join(dir, name));
  return name;
}

export function imagePath(user, id, name) {
  return path.join(noteDir(user, id), name);
}

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}
