// TruthUp event file format.
//
// An event is one Markdown file:
//
//   ---                      front matter: id, title, created (+ any extra keys)
//   # Title
//   ## Summary               free text
//   ## Actors                table: ID | Name | Role / contact
//   ## Timeline              one ```mermaid sequenceDiagram, one `rect` block per date
//                            (files from v0.1 call this section `## Sequence`; both are read)
//   ## Details               one `### date · from → to · text` entry per action
//   ## <anything else>       kept as-is
//
// Every action (record) has a permanent ID (E1, E2…) that links its arrows to its
// details. IDs are never shown: in the diagram they are Mermaid comments (`%% E5`), in
// Details an HTML comment under the heading (`<!-- E5 -->`). An action goes from one
// actor to one or more actors, drawn as one arrow per recipient; only the first arrow
// carries the text (`A->>B: Sent the report`, then `A->>C:`).
// Files from v0.2 tagged arrows and headings visibly (`[E5] …`, `### E5 · …`); both
// are still read.
//
// An actor can join the timeline at its first action (`create participant X` right
// before that arrow) and leave after its last one (`destroy X`: its lifeline stops there
// and its box is drawn at that point). Mermaid only creates an actor on an arrow pointing *to* it, so joining
// needs a first action the actor receives. The model only stores `joins` / `leaves` flags; where the lines go is
// derived from the actor's actions, so the diagram can never reference an actor
// before it exists or after it has left.
//
// parseEvent() turns the file into a model the UI edits; serializeEvent() writes it
// back. Diagram lines TruthUp doesn't model (notes, alt/loop blocks, autonumber…) are
// kept and re-emitted next to the record they followed, so hand edits survive.
// Shared by the browser (web/app.js) and the server/tests (Node), so no DOM here.

export const ARROWS = { '->>': 'message', '-->>': 'reply' };
const META_ORDER = ['id', 'title', 'created'];
const DATE_BLOCK = 'rect rgba(127, 127, 127, 0.08)';
const NO_SUMMARY = '_No summary yet._';
const NO_ACTIONS = '_No actions yet._';
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const ACTOR_RE = /^(participant|actor)\s+(\S+?)(?:\s+as\s+(.+))?$/;
const CREATE_RE = /^create\s+(participant|actor)\s+(\S+?)(?:\s+as\s+(.+))?$/;
const DESTROY_RE = /^destroy\s+(\S+)$/;
const ARROW_RE = /^(\S+?)\s*(--?(?:>>|>|x|\)))([+-]?)\s*([^\s:]+)\s*:\s*(.*)$/;
const DATE_NOTE_RE = /^Note\s+over\s+[^:]+:\s*(\d{4}-\d{2}-\d{2})\b/;
const BLOCK_OPEN_RE = /^(rect|alt|opt|loop|par|critical|break|box)\b/;
const RECORD_ID_RE = /^\[(E\d+)\]\s*(.*)$/;          // v0.2 visible tag
const ID_COMMENT_RE = /^%%\s*(E\d+)\s*$/;
const DETAIL_ID_RE = /^<!--\s*(E\d+)\s*-->$/;

// Mermaid treats `;` and `#` specially in message text; it accepts `#<code>;` entities.
export function encodeMermaidText(s) {
  return String(s).replace(/[\r\n]+/g, ' ').replace(/[#;]/g, c => (c === '#' ? '#35;' : '#59;'));
}

export function decodeMermaidText(s) {
  return String(s).replace(/#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

export function weekday(date) {
  const d = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? '' : WEEKDAYS[d.getUTCDay()];
}

export function slugify(text) {
  return String(text).toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48) || 'event';
}

export function actorId(text) {
  return String(text).replace(/[^A-Za-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'Actor';
}

export function newEvent({ id, title, created, actors = [] }) {
  return {
    meta: { id, title, created },
    summary: '',
    actors: actors.map(a => ({
      id: a.id, name: a.name ?? a.id, kind: a.kind ?? 'participant', contact: a.contact ?? '',
      joins: Boolean(a.joins), leaves: Boolean(a.leaves),
    })),
    records: [],
    preamble: [],
    trailing: [],
    extraSections: [],
  };
}

export function nextRecordId(model) {
  let max = 0;
  for (const r of model.records) {
    const n = Number(/^E(\d+)$/.exec(r.id)?.[1]);
    if (n > max) max = n;
  }
  return `E${max + 1}`;
}

// ---------------------------------------------------------------- parse

export function parseEvent(md) {
  const text = String(md).replace(/\r\n?/g, '\n');
  const model = newEvent({});
  model.meta = {};

  let body = text;
  const fm = /^---\n([\s\S]*?)\n---\n?/.exec(text);
  if (fm) {
    for (const line of fm[1].split('\n')) {
      const m = /^([A-Za-z_][\w-]*):\s*(.*?)\s*$/.exec(line);
      if (m) model.meta[m[1]] = m[2];
    }
    body = text.slice(fm[0].length);
    delete model.meta.status;  // v0.1 files had open/concluded; no longer used
  }

  const sections = [];
  let current = null;
  for (const line of body.split('\n')) {
    const h1 = /^# (.+)$/.exec(line);
    const h2 = /^## (.+)$/.exec(line);
    if (h1 && !current) {
      if (!model.meta.title) model.meta.title = h1[1].trim();
    } else if (h2) {
      current = { heading: h2[1].trim(), lines: [] };
      sections.push(current);
    } else if (current) {
      current.lines.push(line);
    }
  }

  let details = new Map();
  for (const s of sections) {
    const content = s.lines.join('\n').trim();
    switch (s.heading.toLowerCase()) {
      case 'summary': model.summary = content === NO_SUMMARY ? '' : content; break;
      case 'actors': model.actors = parseActorTable(content); break;
      case 'timeline':
      case 'sequence': parseSequence(content, model); break;
      case 'details': details = parseDetails(content); break;
      default: model.extraSections.push({ heading: s.heading, body: content });
    }
  }

  // Records written by hand without an [E<n>] tag get the next free IDs.
  for (const r of model.records) {
    if (!r.id) r.id = nextRecordId(model);
    r.details = details.get(r.id) ?? '';
  }
  // Any actor used in a record but never declared still needs to be selectable.
  for (const r of model.records) {
    for (const id of [r.from, ...r.to]) {
      if (id && !model.actors.some(a => a.id === id)) {
        model.actors.push({ id, name: id, kind: 'participant', contact: '', joins: false, leaves: false });
      }
    }
  }
  return model;
}

function parseActorTable(content) {
  const actors = [];
  for (const line of content.split('\n')) {
    if (!/^\s*\|/.test(line)) continue;
    const cells = splitTableRow(line);
    if (cells.every(c => /^:?-{2,}:?$/.test(c)) || /^id$/i.test(cells[0] ?? '')) continue;
    if (!cells[0]) continue;
    actors.push({ id: cells[0], name: cells[1] || cells[0], kind: 'participant', contact: cells[2] ?? '', joins: false, leaves: false });
  }
  return actors;
}

function splitTableRow(line) {
  const inner = line.trim().replace(/^\|/, '').replace(/\|$/, '');
  return inner.split(/(?<!\\)\|/).map(c => c.trim().replace(/\\\|/g, '|'));
}

function parseSequence(content, model) {
  const block = /```mermaid\n([\s\S]*?)```/.exec(content);
  if (!block) return;
  const tableActors = model.actors;
  const actors = [];
  const stack = [];            // open blocks: 'date' | 'raw'
  let pendingRect = null;      // a `rect` line waiting to see if it opens a date block
  let date = '';
  let pendingRaw = [];
  let lastRecord = null;
  let pendingId = null;        // from a `%% E<n>` comment, for the next arrow
  let started = false;         // first record or date block seen

  const raw = line => {
    if (started) pendingRaw.push(line);
    else model.preamble.push(line);
  };

  for (const rawLine of block[1].split('\n')) {
    const line = rawLine.trim();
    if (!line || line === 'sequenceDiagram') continue;

    if (pendingRect !== null) {
      const dn = DATE_NOTE_RE.exec(line);
      const rectLine = pendingRect;
      pendingRect = null;
      if (dn) {
        stack.push('date');
        date = dn[1];
        started = true;
        continue;
      }
      stack.push('raw');
      raw(rectLine);
    }

    const created = CREATE_RE.exec(line);
    const actor = created ?? (started ? null : ACTOR_RE.exec(line));
    if (actor) {
      const id = actor[2];
      const table = tableActors.find(a => a.id === id);
      if (!actors.some(a => a.id === id)) {
        actors.push({
          id,
          name: actor[3] ? decodeMermaidText(actor[3].trim()) : (table?.name ?? id),
          kind: actor[1],
          contact: table?.contact ?? '',
          joins: Boolean(created),
          leaves: false,
        });
      }
      continue;
    }
    const idComment = ID_COMMENT_RE.exec(line);
    if (idComment) { pendingId = idComment[1]; continue; }
    const destroyed = DESTROY_RE.exec(line);
    if (destroyed) {
      const a = actors.find(x => x.id === destroyed[1]);
      if (a) a.leaves = true;
      continue;
    }

    if (/^rect\b/.test(line)) { pendingRect = line; continue; }
    if (BLOCK_OPEN_RE.test(line)) { stack.push('raw'); raw(line); continue; }
    if (line === 'end') {
      const kind = stack.pop();
      if (kind === 'date') {
        if (pendingRaw.length && lastRecord) lastRecord.after.push(...pendingRaw);
        else model.trailing.push(...pendingRaw);
        pendingRaw = [];
      } else {
        raw(line);
      }
      continue;
    }

    const arrow = ARROW_RE.exec(line);
    if (arrow) {
      started = true;
      const text = decodeMermaidText(arrow[5].trim());
      const tagged = RECORD_ID_RE.exec(text);
      const kind = arrow[2] + arrow[3];
      // Another recipient of the action on the line just before: an unlabelled arrow
      // with no ID comment of its own (or, in v0.2 files, the same visible tag).
      const continues = tagged
        ? lastRecord?.id === tagged[1] && !tagged[2]
        : !pendingId && text === '';
      if (continues && lastRecord && !pendingRaw.length && !lastRecord.after.length &&
          lastRecord.from === arrow[1] && lastRecord.arrow === kind && lastRecord.date === date) {
        if (!lastRecord.to.includes(arrow[4])) lastRecord.to.push(arrow[4]);
        continue;
      }
      // An ID used earlier can't be reused; the arrow becomes a new action.
      const wanted = tagged ? tagged[1] : pendingId;
      pendingId = null;
      const reused = wanted && model.records.some(r => r.id === wanted);
      const record = {
        id: wanted && !reused ? wanted : '',
        date,
        from: arrow[1],
        arrow: kind,
        to: [arrow[4]],
        text: tagged ? tagged[2] : text,
        details: '',
        before: pendingRaw,
        after: [],
      };
      pendingRaw = [];
      model.records.push(record);
      lastRecord = record;
      continue;
    }
    raw(line);
  }
  if (pendingRect !== null) raw(pendingRect);
  if (pendingRaw.length) model.trailing.push(...pendingRaw);

  // Actors from the table that the diagram never declared are kept too, and the
  // table's order wins (actors that join later appear late in the diagram source).
  for (const a of tableActors) if (!actors.some(x => x.id === a.id)) actors.push(a);
  const order = new Map(tableActors.map((a, i) => [a.id, i]));
  const rank = a => order.get(a.id) ?? Number.MAX_SAFE_INTEGER;
  model.actors = actors.map((a, i) => [a, i]).sort((x, y) => rank(x[0]) - rank(y[0]) || x[1] - y[1]).map(([a]) => a);
}

function parseDetails(content) {
  const map = new Map();
  let id = null;
  let awaitingId = false;      // just saw a heading; its ID comment should follow
  let lines = [];
  const flush = () => { if (id) map.set(id, lines.join('\n').trim()); };
  for (const line of content.split('\n')) {
    if (line.startsWith('### ')) {
      flush();
      id = /^### (E\d+)\b/.exec(line)?.[1] ?? null;
      awaitingId = !id;
      lines = [];
    } else if (awaitingId) {
      if (!line.trim()) continue;
      id = DETAIL_ID_RE.exec(line.trim())?.[1] ?? null;
      awaitingId = false;
      if (!id) lines.push(line);
    } else if (id) {
      lines.push(line);
    }
  }
  flush();
  return map;
}

// ---------------------------------------------------------------- serialize

export function sortedRecords(model) {
  return model.records
    .map((r, i) => [r, i])
    .sort((a, b) => (a[0].date || '').localeCompare(b[0].date || '') || a[1] - b[1])
    .map(([r]) => r);
}

const involves = (r, id) => r.from === id || r.to.includes(id);

// Where each actor really joins / leaves. Joining needs a first action that the actor
// receives (Mermaid's rule), after the first day (someone has to be on the timeline
// already). Leaving needs an action; an actor that joins and leaves at the same single
// action just stays.
export function actorSpans(model) {
  const recs = sortedRecords(model);
  const firstDate = recs[0]?.date;
  const spans = new Map();
  for (const a of model.actors) {
    const first = recs.find(r => involves(r, a.id)) ?? null;
    const last = recs.findLast(r => involves(r, a.id)) ?? null;
    const canJoin = Boolean(first && first.date !== firstDate && first.from !== a.id);
    const join = a.joins && canJoin ? first : null;
    const leave = a.leaves && last && !(join && last === first) ? last : null;
    spans.set(a.id, { first, last, join, leave, canJoin, canLeave: Boolean(last) });
  }
  return spans;
}

function declareLine(a, keyword) {
  const label = a.name && a.name !== a.id ? ` as ${encodeMermaidText(a.name)}` : '';
  return `${keyword}${a.kind === 'actor' ? 'actor' : 'participant'} ${a.id}${label}`;
}

export function buildDiagram(model) {
  const out = ['sequenceDiagram'];
  const ind = '    ';
  const spans = actorSpans(model);
  const byId = new Map(model.actors.map(a => [a.id, a]));
  const columns = [];   // left-to-right order as Mermaid lays them out
  const alive = new Set();
  for (const a of model.actors) {
    if (spans.get(a.id).join) continue;
    out.push(ind + declareLine(a, ''));
    columns.push(a.id);
    alive.add(a.id);
  }
  for (const line of model.preamble) out.push(ind + line);

  let open = null;
  for (const r of sortedRecords(model)) {
    if (r.date !== open) {
      if (open) out.push(`${ind}end`);
      open = r.date || null;
      const living = columns.filter(id => alive.has(id));
      if (open && living.length) {
        out.push('', `${ind}${DATE_BLOCK}`);
        const wd = weekday(open);
        const span = living.length > 1 ? `${living[0]},${living[living.length - 1]}` : living[0];
        out.push(`${ind}Note over ${span}: ${open}${wd ? ` (${wd})` : ''}`);
      } else {
        open = null;
      }
    }
    for (const line of r.before ?? []) out.push(ind + line);
    const arrow = r.arrow || '->>';
    out.push(`${ind}%% ${r.id}`);
    const create = id => {
      if (spans.get(id)?.join !== r || alive.has(id) || columns.includes(id)) return;
      out.push(ind + declareLine(byId.get(id), 'create '));
      columns.push(id);
      alive.add(id);
    };
    const destroy = id => {
      if (spans.get(id)?.leave !== r || !alive.has(id)) return;
      out.push(`${ind}destroy ${id}`);
      alive.delete(id);
    };
    r.to.forEach((to, i) => {
      create(to);
      if (i === r.to.length - 1) destroy(r.from);
      if (to !== r.from && i === r.to.lastIndexOf(to)) destroy(to);
      out.push(`${ind}${r.from}${arrow}${to}:${i === 0 && r.text ? ` ${encodeMermaidText(r.text)}` : ''}`);
    });
    for (const line of r.after ?? []) out.push(ind + line);
  }
  if (open) out.push(`${ind}end`);
  for (const line of model.trailing) out.push(ind + line);
  return out.join('\n');
}

export function serializeEvent(model) {
  const meta = { ...model.meta };
  const fm = [];
  for (const k of META_ORDER) if (meta[k] !== undefined && meta[k] !== '') fm.push(`${k}: ${oneLine(meta[k])}`);
  for (const [k, v] of Object.entries(meta)) if (!META_ORDER.includes(k)) fm.push(`${k}: ${oneLine(v)}`);

  const name = id => oneLine(model.actors.find(a => a.id === id)?.name || id);
  const parts = [
    `---\n${fm.join('\n')}\n---`,
    `# ${oneLine(meta.title || 'Untitled event')}`,
    `## Summary\n\n${model.summary?.trim() || NO_SUMMARY}`,
    '## Actors\n\n| ID | Name | Role / contact |\n|----|------|----------------|\n' +
      model.actors.map(a => `| ${cell(a.id)} | ${cell(a.name)} | ${cell(a.contact)} |`).join('\n'),
    `## Timeline\n\n\`\`\`mermaid\n${buildDiagram(model)}\n\`\`\``,
    '## Details\n\n' + (sortedRecords(model)
      .map(r => `### ${r.date || 'undated'} · ${name(r.from)} → ${r.to.map(name).join(', ')} · ${oneLine(r.text)}\n` +
        `<!-- ${r.id} -->` + (r.details?.trim() ? `\n\n${r.details.trim()}` : ''))
      .join('\n\n') || NO_ACTIONS),
    ...model.extraSections.map(s => `## ${s.heading}${s.body ? `\n\n${s.body}` : ''}`),
  ];
  return parts.join('\n\n') + '\n';
}

function oneLine(s) {
  return String(s ?? '').replace(/[\r\n]+/g, ' ').trim();
}

function cell(s) {
  return oneLine(s).replace(/\|/g, '\\|');
}
