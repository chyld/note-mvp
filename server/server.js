import express from 'express';
import path from 'node:path';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import * as store from './store.js';
import {
  SESSION_COOKIE, checkPassword, createSession, destroySession, lookupSession,
  parseCookies, sessionCookie, clearedCookie,
} from './auth.js';

const PORT = Number(process.env.PORT || 5555);
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');

const app = express();
app.disable('x-powered-by');
app.set('etag', false);

const page = (name) => path.join(PUBLIC, name);

// Session lookup for every request.
app.use(async (req, res, next) => {
  const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
  const session = await lookupSession(token);
  req.user = session?.user ?? null;
  req.token = token;
  if (session?.renewed) res.append('Set-Cookie', sessionCookie(token));
  next();
});

app.get('/favicon.ico', (req, res) => res.type('image/svg+xml').sendFile(page('favicon.svg')));
app.use(express.static(PUBLIC, { index: false }));

// The app page. Links are /?note=<id> or /?tag=<tag>, never both.
app.get('/', async (req, res) => {
  res.set('Cache-Control', 'no-store');
  if (!req.user) return res.sendFile(page('login.html'));
  const { note, tag } = req.query;
  const extra = Object.keys(req.query).filter((k) => k !== 'note' && k !== 'tag');
  let found = !extra.length && !(note !== undefined && tag !== undefined);
  if (found && note !== undefined) found = typeof note === 'string' && Boolean(await store.getNote(req.user, note));
  if (found && tag !== undefined) {
    found = typeof tag === 'string' && (await store.listTags(req.user)).some((t) => t.tag === tag);
  }
  if (!found) return res.status(404).sendFile(page('404.html'));
  res.sendFile(page('index.html'));
});

const api = express.Router();
app.use('/api', api);

api.post('/login', express.json(), async (req, res) => {
  const { username, password } = req.body || {};
  if (typeof username !== 'string' || typeof password !== 'string' || !(await checkPassword(username, password))) {
    await new Promise((r) => setTimeout(r, 500));
    return res.status(401).json({ error: 'Wrong username or password' });
  }
  const token = await createSession(username);
  res.append('Set-Cookie', sessionCookie(token));
  res.json({ user: username });
});

api.post('/logout', async (req, res) => {
  await destroySession(req.token);
  res.append('Set-Cookie', clearedCookie());
  res.json({ ok: true });
});

api.use((req, res, next) => {
  if (!req.user) return res.status(401).json({ error: 'Not logged in' });
  res.set('Cache-Control', 'no-store');
  next();
});

api.get('/session', (req, res) => res.json({ user: req.user }));

api.get('/notes', async (req, res) => {
  const { tag, q, trash } = req.query;
  res.json(await store.listNotes(req.user, {
    tag: typeof tag === 'string' ? tag : '',
    q: typeof q === 'string' ? q : '',
    trash: trash === '1',
  }));
});

api.get('/tags', async (req, res) => res.json(await store.listTags(req.user)));

api.post('/notes', express.json(), async (req, res) => {
  const tags = store.cleanTags(req.body?.tags ?? []);
  if (!tags) return res.status(400).json({ error: 'Invalid tags' });
  res.status(201).json(await store.createNote(req.user, { tags }));
});

// Loads the note for /notes/:id routes, 404 if missing.
async function withNote(req, res, next) {
  const note = await store.getNote(req.user, req.params.id);
  if (!note) return res.status(404).json({ error: 'Note not found' });
  req.note = note;
  next();
}

api.get('/notes/:id', withNote, (req, res) => res.json(req.note));

api.put('/notes/:id', withNote, express.json({ limit: '50mb' }), async (req, res) => {
  const { text } = req.body || {};
  if (typeof text !== 'string') return res.status(400).json({ error: 'Missing text' });
  if (req.note.trashedAt) return res.status(409).json({ error: 'Note is in the trash' });
  res.json(await store.saveText(req.user, req.note.id, text));
});

api.put('/notes/:id/tags', withNote, express.json(), async (req, res) => {
  const tags = store.cleanTags(req.body?.tags);
  if (!tags) return res.status(400).json({ error: 'Tags must be lowercase a-z and 0-9' });
  res.json(await store.saveTags(req.user, req.note.id, tags));
});

api.post('/notes/:id/trash', withNote, async (req, res) => {
  res.json(await store.setTrashed(req.user, req.note.id, true));
});

api.post('/notes/:id/restore', withNote, async (req, res) => {
  res.json(await store.setTrashed(req.user, req.note.id, false));
});

api.delete('/notes/:id', withNote, async (req, res) => {
  if (!req.note.trashedAt) return res.status(409).json({ error: 'Move the note to the trash first' });
  await store.deleteNote(req.user, req.note.id);
  res.json({ ok: true });
});

api.post('/trash/empty', async (req, res) => {
  res.json({ deleted: await store.emptyTrash(req.user) });
});

api.post('/notes/:id/images', withNote, async (req, res) => {
  if (req.note.trashedAt) return res.status(409).json({ error: 'Note is in the trash' });
  if (req.headers['content-type'] !== 'image/png') {
    return res.status(415).json({ error: 'Only PNG screenshots are allowed' });
  }
  const name = await store.saveImage(req.user, req.note.id, req);
  if (!name) return res.status(415).json({ error: 'Only PNG screenshots are allowed' });
  res.status(201).json({ name });
});

api.get('/notes/:id/images/:name', async (req, res) => {
  const { id, name } = req.params;
  if (!store.ID_RE.test(id) || !store.IMAGE_NAME_RE.test(name)) return res.sendStatus(404);
  const file = store.imagePath(req.user, id, name);
  try {
    await fs.access(file);
  } catch {
    return res.sendStatus(404);
  }
  res.set('Cache-Control', 'private, max-age=31536000, immutable');
  res.type('image/png').sendFile(file);
});

api.use((req, res) => res.status(404).json({ error: 'Not found' }));

app.use((req, res) => res.status(404).sendFile(page('404.html')));

app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({ error: err.expose ? err.message : 'Server error' });
});

await fs.mkdir(path.join(store.DATA_DIR, 'notes'), { recursive: true });
app.listen(PORT, '0.0.0.0', () => console.log(`Margin listening on http://0.0.0.0:${PORT} (data: ${store.DATA_DIR})`));
