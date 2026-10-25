#!/usr/bin/env node
// Margin user management.
//   margin-user add <username>      create a user (prompts for a password)
//   margin-user passwd <username>   change a user's password
//   margin-user remove <username>   delete a user (their notes stay on disk)
//   margin-user list                list users
import readline from 'node:readline';
import { readUsers, writeUsers, hashPassword, USERNAME_RE } from './server/auth.js';

function ask(question, { hidden = false } = {}) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    if (hidden) {
      rl._writeToOutput = (s) => {
        if (s.includes(question)) rl.output.write(s);
      };
    }
    rl.question(question, (answer) => {
      rl.close();
      if (hidden) process.stdout.write('\n');
      resolve(answer);
    });
  });
}

async function promptPassword() {
  if (process.env.MARGIN_PASSWORD) return process.env.MARGIN_PASSWORD;
  const pw = await ask('Password: ', { hidden: true });
  if (pw.length < 4) fail('Password must be at least 4 characters');
  const again = await ask('Repeat password: ', { hidden: true });
  if (pw !== again) fail('Passwords do not match');
  return pw;
}

function fail(msg) {
  console.error(msg);
  process.exit(1);
}

const [cmd, name] = process.argv.slice(2);
const users = await readUsers();

switch (cmd) {
  case 'add': {
    if (!name || !USERNAME_RE.test(name)) fail('Username must be 1-32 characters: a-z, 0-9, _ or -');
    if (users[name]) fail(`User "${name}" already exists`);
    users[name] = { ...(await hashPassword(await promptPassword())), created: new Date().toISOString() };
    await writeUsers(users);
    console.log(`Created user "${name}"`);
    break;
  }
  case 'passwd': {
    if (!users[name]) fail(`No user "${name}"`);
    users[name] = { ...users[name], ...(await hashPassword(await promptPassword())) };
    await writeUsers(users);
    console.log(`Password changed for "${name}"`);
    break;
  }
  case 'remove': {
    if (!users[name]) fail(`No user "${name}"`);
    delete users[name];
    await writeUsers(users);
    console.log(`Removed user "${name}" (their notes are still in data/notes/${name})`);
    break;
  }
  case 'list': {
    const names = Object.keys(users);
    console.log(names.length ? names.join('\n') : '(no users)');
    break;
  }
  default:
    console.log('Usage: margin-user add|passwd|remove <username>\n       margin-user list');
    process.exit(cmd ? 1 : 0);
}
