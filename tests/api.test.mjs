import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp } from '../server.mjs';
import { parseEvent, serializeEvent } from '../web/format.js';

const dataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'truthup-test-'));
const app = createApp({ dataDir });
await app.init();
const server = http.createServer(app.handle).listen(0, '127.0.0.1');
await new Promise(r => server.once('listening', r));
const base = `http://127.0.0.1:${server.address().port}`;

test.after(async () => {
  server.close();
  await fs.rm(dataDir, { recursive: true, force: true });
});

async function call(method, url, body) {
  const res = await fetch(base + url, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json() };
}

const gitLog = () => execFileSync('git', ['log', '--format=%an|%s'], { cwd: dataDir, encoding: 'utf8' }).trim().split('\n');

test('a new data repo is seeded with the example event', async () => {
  const { status, body } = await call('GET', '/api/events');
  assert.equal(status, 200);
  assert.deepEqual(body.events.map(e => e.id), ['2026-09-kitchen-leak']);
  assert.equal(body.events[0].records, 13);
});

test('create, save (= commit), history, old version, conflict, delete', async () => {
  const created = await call('POST', '/api/events', {
    title: 'Car accident claim', created: '2026-10-01', author: 'Alex',
    actors: [{ id: 'Me', name: 'Me', kind: 'actor' }, { id: 'Insurer', name: 'Insurer' }],
  });
  assert.equal(created.status, 200);
  assert.equal(created.body.id, '2026-10-car-accident-claim');
  const id = created.body.id;

  const opened = await call('GET', `/api/events/${id}`);
  const model = parseEvent(opened.body.markdown);
  assert.deepEqual(model.actors.map(a => a.id), ['Me', 'Insurer']);
  const firstCommit = opened.body.lastCommit.hash;

  model.records.push({ id: 'E1', date: '2026-10-02', from: 'Me', arrow: '->>', to: ['Insurer'], text: 'File claim', details: 'By phone.', before: [], after: [] });
  const saved = await call('PUT', `/api/events/${id}`, {
    markdown: serializeEvent(model), message: `${id}: record E1 File claim`, author: 'Alex', baseCommit: firstCommit,
  });
  assert.equal(saved.status, 200);
  assert.notEqual(saved.body.lastCommit.hash, firstCommit);
  assert.equal(gitLog()[0], `Alex|${id}: record E1 File claim`);

  const unchanged = await call('PUT', `/api/events/${id}`, {
    markdown: serializeEvent(model), author: 'Alex', baseCommit: saved.body.lastCommit.hash,
  });
  assert.equal(unchanged.body.unchanged, true);

  const stale = await call('PUT', `/api/events/${id}`, { markdown: 'x', author: 'Sam', baseCommit: firstCommit });
  assert.equal(stale.status, 409);

  const hist = await call('GET', `/api/events/${id}/history`);
  assert.deepEqual(hist.body.commits.map(c => c.message), [`${id}: record E1 File claim`, `${id}: open event`]);

  const old = await call('GET', `/api/events/${id}/versions/${firstCommit}`);
  assert.equal(parseEvent(old.body.markdown).records.length, 0);
  assert.match(old.body.diff, /\+# Car accident claim/);

  const del = await call('DELETE', `/api/events/${id}`, { author: 'Alex' });
  assert.equal(del.status, 200);
  assert.equal((await call('GET', `/api/events/${id}`)).status, 404);
  assert.equal(gitLog()[0], `Alex|${id}: delete event`);
});

test('bad ids and hashes are rejected', async () => {
  assert.equal((await call('GET', '/api/events/..%2Fsecret')).status, 400);
  assert.equal((await call('GET', '/api/events/Bad_Id')).status, 400);
  assert.equal((await call('GET', '/api/events/2026-09-kitchen-leak/versions/HEAD')).status, 400);
  assert.equal((await call('POST', '/api/events', { title: '  ' })).status, 400);
});

test('static files and vendored Mermaid are served', async () => {
  for (const p of ['/', '/app.js', '/format.js', '/style.css', '/vendor/mermaid.min.js']) {
    const res = await fetch(base + p);
    assert.equal(res.status, 200, p);
    await res.arrayBuffer();
  }
  assert.equal((await fetch(`${base}/../package.json`)).status, 404);
});
