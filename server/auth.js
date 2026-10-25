// Users (created with the CLI) and login sessions, both stored as JSON files.
import path from 'node:path';
import fs from 'node:fs/promises';
import crypto from 'node:crypto';
import { promisify } from 'node:util';
import { DATA_DIR, readJson, writeJson } from './store.js';

const scrypt = promisify(crypto.scrypt);
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const SESSIONS_FILE = path.join(DATA_DIR, 'sessions.json');

export const USERNAME_RE = /^[a-z0-9_-]{1,32}$/;
export const SESSION_COOKIE = 'margin_session';
export const SESSION_DAYS = 30;
const SESSION_MS = SESSION_DAYS * 24 * 60 * 60 * 1000;
const RENEW_AFTER_MS = 60 * 60 * 1000;

export function readUsers() {
  return readJson(USERS_FILE, {});
}

export function writeUsers(users) {
  return writeJson(USERS_FILE, users);
}

export async function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = (await scrypt(password, salt, 64)).toString('hex');
  return { salt, hash };
}

// Cached by mtime so users added or removed with the CLI take effect immediately.
let usersCache = { mtimeMs: -1, users: {} };
async function currentUsers() {
  let mtimeMs = 0;
  try {
    mtimeMs = (await fs.stat(USERS_FILE)).mtimeMs;
  } catch {}
  if (mtimeMs !== usersCache.mtimeMs) usersCache = { mtimeMs, users: await readUsers() };
  return usersCache.users;
}

export async function checkPassword(username, password) {
  const users = await currentUsers();
  const user = Object.hasOwn(users, username) ? users[username] : null;
  // Hash even for unknown users so timing doesn't reveal which usernames exist.
  const salt = user ? user.salt : 'x'.repeat(32);
  const hash = await scrypt(String(password), salt, 64);
  return Boolean(user) && crypto.timingSafeEqual(hash, Buffer.from(user.hash, 'hex'));
}

let sessions = null;
let saveTimer = null;
async function loadSessions() {
  if (!sessions) sessions = await readJson(SESSIONS_FILE, {});
  return sessions;
}
function persistSessions() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => writeJson(SESSIONS_FILE, sessions).catch(console.error), 200);
}

export async function createSession(username) {
  await loadSessions();
  const token = crypto.randomBytes(32).toString('hex');
  sessions[token] = { user: username, expires: Date.now() + SESSION_MS };
  persistSessions();
  return token;
}

export async function destroySession(token) {
  await loadSessions();
  if (token && sessions[token]) {
    delete sessions[token];
    persistSessions();
  }
}

// Returns { user, renewed } for a valid session; renews it (sliding 30 days) on use.
export async function lookupSession(token) {
  if (!token) return null;
  await loadSessions();
  const s = Object.hasOwn(sessions, token) ? sessions[token] : null;
  if (!s) return null;
  const now = Date.now();
  const users = await currentUsers();
  if (s.expires < now || !Object.hasOwn(users, s.user)) {
    delete sessions[token];
    persistSessions();
    return null;
  }
  let renewed = false;
  if (s.expires - now < SESSION_MS - RENEW_AFTER_MS) {
    s.expires = now + SESSION_MS;
    persistSessions();
    renewed = true;
  }
  return { user: s.user, renewed };
}

export function parseCookies(header = '') {
  const out = {};
  for (const part of header.split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function sessionCookie(token) {
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MS / 1000}`;
}

export function clearedCookie() {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;
}
