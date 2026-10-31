import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {
  parseEvent, serializeEvent, newEvent, nextRecordId, buildDiagram, actorSpans, encodeMermaidText, decodeMermaidText,
} from '../web/format.js';

const example = fs.readFileSync(new URL('../examples/2026-09-kitchen-leak.md', import.meta.url), 'utf8');

test('example event round-trips byte for byte', () => {
  assert.equal(serializeEvent(parseEvent(example)), example);
});

test('example event parses into actors, records and details', () => {
  const m = parseEvent(example);
  assert.equal(m.meta.id, '2026-09-kitchen-leak');
  assert.deepEqual(m.actors.map(a => a.id), ['Me', 'Landlord', 'Plumber', 'Insurer']);
  assert.equal(m.actors[0].kind, 'actor');
  assert.equal(m.actors[1].name, 'J. Rivera');
  assert.equal(m.actors[1].contact, 'Owner, prefers text messages');
  assert.equal(m.records.length, 13);
  const e11 = m.records.find(r => r.id === 'E11');
  assert.deepEqual(
    { date: e11.date, from: e11.from, to: e11.to, arrow: e11.arrow, text: e11.text },
    { date: '2026-10-20', from: 'Insurer', to: ['Landlord'], arrow: '->>', text: 'Adjuster needs plumber report' },
  );
  assert.match(e11.details, /Adjuster Kim/);
  assert.equal(nextRecordId(m), 'E14');
});

test('special characters survive the diagram and the round trip', () => {
  const m = newEvent({ id: 'x', title: 'Fees; #1 issue', created: '2026-01-05', actors: [{ id: 'A' }, { id: 'B', name: 'Bob | Co' }] });
  m.records.push({ id: 'E1', date: '2026-01-05', from: 'A', arrow: '->>', to: ['B'], text: 'Paid #42; got receipt', details: 'line 1\nline 2', before: [], after: [] });
  const md = serializeEvent(m);
  assert.ok(!/Paid #42; got/.test(buildDiagram(m)), 'raw ; and # must be encoded in the diagram');
  const back = parseEvent(md);
  assert.equal(back.meta.title, 'Fees; #1 issue');
  assert.equal(back.records[0].text, 'Paid #42; got receipt');
  assert.equal(back.records[0].details, 'line 1\nline 2');
  assert.equal(back.actors[1].name, 'Bob | Co');
  assert.equal(serializeEvent(back), md);
  assert.equal(decodeMermaidText(encodeMermaidText('a;b#c')), 'a;b#c');
});

test('records are grouped by date and sorted, keeping order within a day', () => {
  const m = newEvent({ id: 'x', title: 'T', created: '2026-01-01', actors: [{ id: 'A' }, { id: 'B' }] });
  const rec = (id, date, text) => ({ id, date, from: 'A', arrow: '->>', to: ['B'], text, details: '', before: [], after: [] });
  m.records.push(rec('E1', '2026-01-03', 'third day'), rec('E2', '2026-01-01', 'first'), rec('E3', '2026-01-01', 'second'));
  const d = buildDiagram(m);
  assert.ok(d.indexOf('%% E2') < d.indexOf('%% E3') && d.indexOf('%% E3') < d.indexOf('%% E1'));
  assert.equal((d.match(/^\s*rect /gm) ?? []).length, 2);
  assert.match(d, /Note over A,B: 2026-01-01 \(Thu\)/);
});

test('hand-written diagram lines are kept next to their records', () => {
  const md = `---
id: hand
title: Hand edited
status: open
created: 2026-02-01
---

# Hand edited

## Sequence

\`\`\`mermaid
sequenceDiagram
    autonumber
    actor Me
    participant Shop

    rect rgba(127, 127, 127, 0.08)
    Note over Me,Shop: 2026-02-01 (Sun)
    Me->>Shop: [E1] Order a chair
    alt In stock
        Shop-->>Me: [E2] Ships today
    else Out of stock
        Shop-->>Me: Back in two weeks
    end
    Note right of Shop: Called twice
    end
\`\`\`

## Details

### E1 · 2026-02-01 · Me → Shop · Order a chair

Online order.

## Conclusion

Chair arrived.
`;
  const m = parseEvent(md);
  assert.equal(m.records.length, 3);
  assert.equal(m.records[2].id, 'E3', 'untagged arrow gets the next free ID');
  assert.deepEqual(m.preamble, ['autonumber']);
  assert.deepEqual(m.records[1].before, ['alt In stock']);
  assert.deepEqual(m.records[2].before, ['else Out of stock']);
  assert.deepEqual(m.records[2].after, ['end', 'Note right of Shop: Called twice']);
  assert.equal(m.records[0].details, 'Online order.');
  assert.deepEqual(m.extraSections, [{ heading: 'Conclusion', body: 'Chair arrived.' }]);

  const again = parseEvent(serializeEvent(m));
  assert.deepEqual(again.records.map(r => [r.id, r.before, r.after]), m.records.map(r => [r.id, r.before, r.after]));
  const diagram = buildDiagram(m);
  const opens = (diagram.match(/^\s*(rect|alt)\b/gm) ?? []).length;
  const ends = (diagram.match(/^\s*end$/gm) ?? []).length;
  assert.equal(opens, ends, 'every block is closed');
});

test('an action can go to several actors: one arrow each, same ID', () => {
  const m = parseEvent(example);
  const e13 = m.records.find(r => r.id === 'E13');
  assert.deepEqual(e13.to, ['Insurer', 'Landlord']);
  assert.equal(e13.text, 'Sends written report');
  const d = buildDiagram(m);
  assert.match(d, /%% E13\n\s*Plumber-->>Insurer: Sends written report\n(\s*destroy Plumber\n)?\s*Plumber-->>Landlord:\n/);
  assert.match(serializeEvent(m), /### 2026-11-04 · QuickFix Plumbing → HomeSure, J\. Rivera · Sends written report\n<!-- E13 -->/);

  e13.to.push('Me');
  const back = parseEvent(serializeEvent(m));
  assert.deepEqual(back.records.find(r => r.id === 'E13').to, ['Insurer', 'Landlord', 'Me']);
  assert.equal(back.records.length, 13);
});

test('a reused ID that is not a direct continuation becomes a new action', () => {
  const md = example.replace('    Landlord->>Plumber: Requests written report', '    Landlord->>Plumber: Requests written report\n    %% E2\n    Me->>Landlord: Copy-pasted line');
  const m = parseEvent(md);
  assert.equal(m.records.length, 14);
  const extra = m.records.find(r => r.text === 'Copy-pasted line');
  assert.equal(extra.id, 'E14');
  assert.deepEqual(m.records.find(r => r.id === 'E2').to, ['Me']);
});

test('files from v0.1 with a Sequence section still load', () => {
  const m = parseEvent(example.replace('## Timeline', '## Sequence').replace('created:', 'status: open\ncreated:'));
  assert.equal(m.records.length, 13);
  assert.match(serializeEvent(m), /## Timeline/);
  assert.doesNotMatch(serializeEvent(m), /status:/);
});

test('actors join at their first action and leave after their last', () => {
  const m = parseEvent(example);
  const flags = Object.fromEntries(m.actors.map(a => [a.id, [a.joins, a.leaves]]));
  assert.deepEqual(flags, { Me: [false, false], Landlord: [false, false], Plumber: [true, true], Insurer: [true, false] });
  const d = buildDiagram(m);
  // Joiners are not declared up front; they are created right before the arrow that reaches them.
  assert.doesNotMatch(d.split('rect')[0], /Plumber|Insurer/);
  assert.match(d, /create participant Plumber as QuickFix Plumbing\n\s*Landlord->>Plumber: Books a visit/);
  assert.match(d, /create participant Insurer as HomeSure\n\s*Landlord->>Insurer: Opens claim/);
  // Leaving: destroyed right before its last arrow, and never mentioned afterwards.
  assert.match(d, /destroy Plumber\n\s*Plumber-->>Landlord:\n\s*end$/);
  // Date notes only span actors already on the timeline.
  assert.match(d, /Note over Me,Landlord: 2026-09-04/);
  assert.match(d, /Note over Me,Plumber: 2026-09-05/);
  assert.match(d, /Note over Me,Insurer: 2026-10-20/);
});

test('joining needs a first action the actor receives, after the first day', () => {
  const m = parseEvent(example);
  const spans = actorSpans(m);
  assert.equal(spans.get('Plumber').canJoin, true);
  assert.equal(spans.get('Me').canJoin, false, 'involved on the first day');
  // Make the plumber's first action one it sends: it can no longer be shown joining.
  m.records = m.records.filter(r => r.id !== 'E3');
  const after = actorSpans(m).get('Plumber');
  assert.equal(after.canJoin, false);
  assert.equal(after.join, null);
  assert.match(buildDiagram(m), /^\s*participant Plumber as QuickFix Plumbing$/m);
  assert.match(buildDiagram(m), /destroy Plumber/);
});

test('actor order follows the Actors table even though joiners come late in the diagram', () => {
  const m = parseEvent(example);
  [m.actors[2], m.actors[3]] = [m.actors[3], m.actors[2]];
  const back = parseEvent(serializeEvent(m));
  assert.deepEqual(back.actors.map(a => a.id), ['Me', 'Landlord', 'Insurer', 'Plumber']);
});

test('action IDs are never visible, only hidden comments', () => {
  const md = serializeEvent(parseEvent(example));
  const diagram = /```mermaid\n([\s\S]*?)```/.exec(md)[1];
  const visible = diagram.split('\n').filter(l => !/^\s*%%/.test(l)).join('\n');
  assert.doesNotMatch(visible, /\bE\d+\b/);
  const details = md.slice(md.indexOf('## Details'));
  assert.doesNotMatch(details.replace(/<!-- E\d+ -->/g, ''), /\bE\d+\b/);
});

test('an action added later for an earlier date sorts by date, keeping its own ID', () => {
  const m = parseEvent(example);
  const id = nextRecordId(m);
  m.records.push({ id, date: '2026-09-03', from: 'Me', arrow: '->>', to: ['Landlord'], text: 'Calls to follow up', details: 'Phone, 18:00.', before: [], after: [] });
  const back = parseEvent(serializeEvent(m));
  const order = back.records.map(r => r.id);
  assert.equal(id, 'E14');
  assert.deepEqual(order.slice(0, 4), ['E1', 'E2', 'E14', 'E3']);
  assert.equal(back.records[2].details, 'Phone, 18:00.');
});

test('v0.2 files with visible [E<n>] tags load into the same model', () => {
  const m = parseEvent(example);
  const legacy = serializeEvent(m)
    .replace(/^ {4}%% (E\d+)\n( {4}(?:create .*\n {4})?)(\S+?)(-?->>)(\S+?):(?: (.*))?$/gm,
      (_, id, pre, from, arrow, to, text) => `${pre}${from}${arrow}${to}: [${id}]${text ? ` ${text}` : ''}`)
    .replace(/^### (.*)\n<!-- (E\d+) -->$/gm, '### $2 · $1');
  assert.match(legacy, /: \[E13\] Sends written report/);
  assert.match(legacy, /### E1 · 2026-09-03/);
  const back = parseEvent(legacy);
  const key = mm => JSON.stringify(mm.records.map(r => [r.id, r.date, r.from, r.to, r.text, r.details]));
  assert.equal(key(back), key(m));
});

test('a new event serializes to a parseable empty file', () => {
  const m = newEvent({ id: '2026-11-test', title: 'Test', created: '2026-11-01', actors: [{ id: 'Me', kind: 'actor' }] });
  const back = parseEvent(serializeEvent(m));
  assert.equal(back.meta.title, 'Test');
  assert.equal(back.summary, '');
  assert.equal(back.records.length, 0);
  assert.deepEqual(back.actors.map(a => [a.id, a.kind]), [['Me', 'actor']]);
});
