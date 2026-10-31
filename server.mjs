// TruthUp server: serves the web UI and keeps every event as a Markdown file in a
// git repository. Saving an event = one git commit. No dependencies besides Node and
// the git CLI (Mermaid is served from node_modules for the browser only).
//
//   TRUTHUP_DATA  data repo folder (default ./data, created and `git init`ed on start)
//   PORT / HOST   listen address (default 127.0.0.1:5180)

import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { parseEvent, serializeEvent, newEvent, slugify } from './web/format.js';

const run = promisify(execFile);
const ROOT = path.dirname(fileURLToPath(import.meta.url));
const WEB = path.join(ROOT, 'web');
const MAX_BODY = 2 * 1024 * 1024;
const ID_RE = /^[a-z0-9][a-z0-9-]{0,80}$/;
const HASH_RE = /^[0-9a-f]{7,40}$/;
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/format.js': ['format.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
const MERMAID = path.join(ROOT, 'node_modules/mermaid/dist/mermaid.min.js');

export function createApp({ dataDir, seed = true }) {
  const DATA = path.resolve(dataDir);
  const EVENTS = path.join(DATA, 'events');
  const rel = id => `events/${id}.md`;
  const file = id => path.join(EVENTS, `${id}.md`);

  // The server commits as "TruthUp"; the person who made the change is the author.
  const gitEnv = { ...process.env, GIT_COMMITTER_NAME: 'TruthUp', GIT_COMMITTER_EMAIL: 'truthup@localhost' };
  const git = async (...args) => (await run('git', args, { cwd: DATA, env: gitEnv, maxBuffer: 32 * 1024 * 1024 })).stdout;

  // One git operation at a time, so concurrent saves never fight over index.lock.
  let queue = Promise.resolve();
  const locked = fn => {
    const p = queue.then(fn, fn);
    queue = p.catch(() => {});
    return p;
  };

  function authorArg(author) {
    const name = String(author || '').replace(/[<>\r\n]/g, '').trim().slice(0, 80) || 'Anonymous';
    return `${name} <${slugify(name)}@truthup.local>`;
  }

  async function commitFile(id, message, author) {
    await git('add', '--', rel(id));
    await git('commit', '-q', '-m', message, `--author=${authorArg(author)}`, '--', rel(id));
    return (await git('rev-parse', 'HEAD')).trim();
  }

  async function lastCommit(id) {
    const out = (await git('log', '-1', '--format=%H%x1f%aI%x1f%an%x1f%s', '--', rel(id))).trim();
    if (!out) return null;
    const [hash, date, author, message] = out.split('\x1f');
    return { hash, date, author, message };
  }

  async function exists(p) {
    return fs.access(p).then(() => true, () => false);
  }

  async function init() {
    await fs.mkdir(EVENTS, { recursive: true });
    if (await exists(path.join(DATA, '.git'))) return;
    await git('init', '-q', '-b', 'main');
    if (!seed) return;
    const examples = path.join(ROOT, 'examples');
    for (const name of await fs.readdir(examples).catch(() => [])) {
      if (!name.endsWith('.md')) continue;
      await fs.copyFile(path.join(examples, name), path.join(EVENTS, name));
      await commitFile(name.slice(0, -3), `${name.slice(0, -3)}: add example event`, 'TruthUp');
    }
  }

  // ------------------------------------------------------------ API handlers

  async function listEvents() {
    const names = (await fs.readdir(EVENTS)).filter(n => n.endsWith('.md')).sort();
    const events = [];
    for (const name of names) {
      const id = name.slice(0, -3);
      if (!ID_RE.test(id)) continue;
      const model = parseEvent(await fs.readFile(file(id), 'utf8'));
      events.push({
        id,
        title: model.meta.title || id,
        created: model.meta.created || '',
        records: model.records.length,
        lastCommit: await lastCommit(id),
      });
    }
    events.sort((a, b) => (b.lastCommit?.date ?? '').localeCompare(a.lastCommit?.date ?? ''));
    return { events };
  }

  async function createEvent(body) {
    const title = String(body.title || '').trim();
    if (!title) throw httpError(400, 'Title is required');
    const created = /^\d{4}-\d{2}-\d{2}$/.test(body.created) ? body.created : new Date().toISOString().slice(0, 10);
    const base = `${created.slice(0, 7)}-${slugify(title)}`;
    let id = base;
    for (let n = 2; await exists(file(id)); n++) id = `${base}-${n}`;
    const model = newEvent({ id, title, created, actors: Array.isArray(body.actors) ? body.actors : [] });
    await fs.writeFile(file(id), serializeEvent(model));
    const commit = await commitFile(id, `${id}: open event`, body.author);
    return { id, commit };
  }

  async function readEvent(id) {
    if (!(await exists(file(id)))) throw httpError(404, 'No such event');
    return { id, markdown: await fs.readFile(file(id), 'utf8'), lastCommit: await lastCommit(id) };
  }

  async function saveEvent(id, body) {
    if (!(await exists(file(id)))) throw httpError(404, 'No such event');
    if (typeof body.markdown !== 'string') throw httpError(400, 'markdown is required');
    const current = await lastCommit(id);
    if (body.baseCommit && current && body.baseCommit !== current.hash) {
      throw httpError(409, 'Someone saved this event after you opened it. Reload to see their version.', {
        lastCommit: current,
      });
    }
    const markdown = body.markdown.replace(/\r\n?/g, '\n');
    if (markdown === (await fs.readFile(file(id), 'utf8'))) return { unchanged: true, lastCommit: current };
    await fs.writeFile(file(id), markdown);
    const message = String(body.message || '').trim() || `${id}: update`;
    await commitFile(id, message, body.author);
    return { lastCommit: await lastCommit(id) };
  }

  async function deleteEvent(id, body) {
    if (!(await exists(file(id)))) throw httpError(404, 'No such event');
    await git('rm', '-q', '--', rel(id));
    await git('commit', '-q', '-m', `${id}: delete event`, `--author=${authorArg(body.author)}`, '--', rel(id));
    return { deleted: id };
  }

  async function history(id) {
    const out = await git('log', '--follow', '--format=%H%x1f%aI%x1f%an%x1f%s%x1e', '--', rel(id));
    const commits = out.split('\x1e').map(s => s.trim()).filter(Boolean).map(line => {
      const [hash, date, author, message] = line.split('\x1f');
      return { hash, date, author, message };
    });
    return { commits };
  }

  async function version(id, hash) {
    const markdown = await git('show', `${hash}:${rel(id)}`).catch(() => {
      throw httpError(404, 'This event did not exist at that commit');
    });
    const diff = await git('show', '--format=', '--no-color', hash, '--', rel(id));
    return { markdown, diff };
  }

  // ------------------------------------------------------------ routing

  async function api(req, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(2); // after /api/events
    const id = parts[0];
    if (id !== undefined && !ID_RE.test(id)) throw httpError(400, 'Bad event id');
    const m = req.method;
    if (!id && m === 'GET') return listEvents();
    if (!id && m === 'POST') return locked(async () => createEvent(await readJson(req)));
    if (parts.length === 1 && m === 'GET') return readEvent(id);
    if (parts.length === 1 && m === 'PUT') { const b = await readJson(req); return locked(() => saveEvent(id, b)); }
    if (parts.length === 1 && m === 'DELETE') { const b = await readJson(req); return locked(() => deleteEvent(id, b)); }
    if (parts[1] === 'history' && parts.length === 2 && m === 'GET') return history(id);
    if (parts[1] === 'versions' && parts.length === 3 && m === 'GET') {
      if (!HASH_RE.test(parts[2])) throw httpError(400, 'Bad commit hash');
      return version(id, parts[2]);
    }
    throw httpError(404, 'Not found');
  }

  async function handle(req, res) {
    const url = new URL(req.url, 'http://localhost');
    try {
      if (url.pathname.startsWith('/api/events')) {
        return send(res, 200, JSON.stringify(await api(req, url)), 'application/json');
      }
      if (req.method !== 'GET') return send(res, 405, 'Method not allowed');
      if (url.pathname === '/vendor/mermaid.min.js') {
        return send(res, 200, await fs.readFile(MERMAID), 'text/javascript; charset=utf-8');
      }
      const entry = STATIC[url.pathname];
      if (!entry) return send(res, 404, 'Not found');
      return send(res, 200, await fs.readFile(path.join(WEB, entry[0])), entry[1]);
    } catch (err) {
      const status = err.status ?? 500;
      if (status === 500) console.error(err);
      return send(res, status, JSON.stringify({ error: status === 500 ? 'Server error' : err.message, ...err.extra }), 'application/json');
    }
  }

  return { init, handle };
}

function httpError(status, message, extra) {
  return Object.assign(new Error(message), { status, extra });
}

function send(res, status, body, type = 'text/plain; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw httpError(413, 'Request too large');
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'Invalid JSON');
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const dataDir = process.env.TRUTHUP_DATA || path.join(ROOT, 'data');
  const app = createApp({ dataDir });
  await app.init();
  const port = Number(process.env.PORT) || 5180;
  const host = process.env.HOST || '127.0.0.1';
  const server = http.createServer(app.handle);
  server.on('error', err => {
    if (err.code !== 'EADDRINUSE') throw err;
    console.error(`Port ${port} is already in use. TruthUp may already be running: open http://${host}:${port}`);
    console.error(`To run another copy, pick a different port, e.g. PORT=${port + 1} npm start`);
    process.exit(1);
  });
  server.listen(port, host, () => {
    console.log(`TruthUp running at http://${host === '0.0.0.0' ? 'localhost' : host}:${port}`);
    console.log(`Events are stored in ${path.resolve(dataDir)} (a git repository)`);
  });
}
