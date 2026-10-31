// TruthUp web UI. One page per event, edited by clicking on it: the summary, and two
// tabs, Timeline (click a name to edit an actor, click an arrow to edit an action, click
// one lifeline and then another to add one) and Details. Action IDs live in the file
// only, as hidden comments; the page never shows them. An action goes from one actor to one or
// more others. The Markdown file is the source of
// truth: edits change a parsed model, which is written back to Markdown, and Save
// sends that file to the server, which makes one git commit.

import {
  parseEvent, serializeEvent, buildDiagram, nextRecordId, sortedRecords, actorId, weekday, actorSpans, ARROWS,
} from './format.js';

const $ = sel => document.querySelector(sel);
const main = $('#main');
const dark = matchMedia('(prefers-color-scheme: dark)').matches;
const touch = matchMedia('(pointer: coarse)').matches;
const Click = touch ? 'Tap' : 'Click';
const narrow = matchMedia('(max-width: 860px)');
// Diagrams shrink to fit, but never below this share of their real size (so text stays
// readable); anything wider scrolls sideways.
const minDiagramScale = () => (narrow.matches ? 0.75 : 0.6);

// Phones get a compact layout: long arrow labels wrap, so actors sit closer together.
function initMermaid() {
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: 'strict',
    theme: dark ? 'dark' : 'default',
    sequence: {
      mirrorActors: false,  // no repeat of the actor boxes at the bottom
      ...(narrow.matches
        ? { wrap: true, width: 110, actorMargin: 20, messageFontSize: 14, actorFontSize: 13, noteFontSize: 13 }
        : {}),
    },
  });
}
initMermaid();
narrow.addEventListener('change', () => { initMermaid(); if (state.tab === 'timeline') renderMain(); });

const state = {
  events: [],
  id: null,
  model: null,
  markdown: '',
  saved: '',
  lastCommit: null,
  pick: null,   // actor ID chosen as "from" while adding an action by clicking lifelines
  tab: 'timeline',
};

// ------------------------------------------------------------ helpers

function h(tag, props = {}, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'value' || k === 'checked' || k === 'selected') el[k] = v;
    else el.setAttribute(k, v === true ? '' : v);
  }
  for (const kid of kids.flat()) {
    if (kid != null && kid !== false) el.append(kid instanceof Node ? kid : String(kid));
  }
  return el;
}

async function api(path, { method = 'GET', body } = {}) {
  const res = await fetch(`/api/events${path}`, {
    method,
    headers: body ? { 'Content-Type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
  return data;
}

const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch { /* storage unavailable */ } },
};

const author = () => $('#author').value.trim();
const today = () => new Date().toLocaleDateString('en-CA');
const dirty = () => Boolean(state.id) && state.markdown !== state.saved;
const short = hash => (hash ? hash.slice(0, 7) : '');
const actorName = id => state.model.actors.find(a => a.id === id)?.name || id;

function ago(iso) {
  if (!iso) return '';
  const s = (Date.parse(iso) - Date.now()) / 1000;
  const rtf = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' });
  for (const [unit, sec] of [['year', 31536000], ['month', 2592000], ['day', 86400], ['hour', 3600], ['minute', 60]]) {
    if (Math.abs(s) >= sec) return rtf.format(Math.round(s / sec), unit);
  }
  return 'just now';
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// Every edit goes through here: change the model, regenerate the file, redraw.
function change(fn, { rerender = true } = {}) {
  fn(state.model);
  state.markdown = serializeEvent(state.model);
  if (rerender) renderMain();
  else refreshSaveButton();
}

// ------------------------------------------------------------ data flow

async function loadEvents() {
  state.events = (await api('')).events;
  renderSidebar();
}

// A file in an older format (e.g. visible [E1] tags) is converted as soon as it is
// opened: the page shows the current format and Save commits the conversion.
async function openEvent(id) {
  try {
    const data = await api(`/${id}`);
    const model = parseEvent(data.markdown);
    Object.assign(state, {
      id,
      markdown: serializeEvent(model),
      saved: data.markdown,
      model,
      lastCommit: data.lastCommit,
      pick: null,
      tab: 'timeline',
    });
  } catch (err) {
    state.id = null;
    toast(err.message);
  }
  renderSidebar();
  renderMain();
}

// Commit message from what changed since the last save, e.g. `…: add "Claim paid"`.
function commitMessage() {
  const before = parseEvent(state.saved);
  const after = state.model;
  const parts = [];
  const quote = r => `"${r.text.length > 40 ? `${r.text.slice(0, 39)}…` : r.text}"`;
  const old = new Map(before.records.map(r => [r.id, r]));
  for (const r of after.records) {
    const o = old.get(r.id);
    if (!o) parts.push(`add ${quote(r)}`);
    else if (['date', 'from', 'to', 'arrow', 'text', 'details'].some(k => String(o[k]) !== String(r[k]))) parts.push(`revise ${quote(r)}`);
  }
  for (const r of before.records) if (!after.records.some(x => x.id === r.id)) parts.push(`remove ${quote(r)}`);
  for (const a of after.actors) {
    const o = before.actors.find(x => x.id === a.id);
    if (!o) parts.push(`add actor ${a.name}`);
    else if (o.name !== a.name || o.contact !== a.contact || o.kind !== a.kind) parts.push(`edit actor ${a.name}`);
    else if (o.joins !== a.joins || o.leaves !== a.leaves) parts.push(`change when ${a.name} joins or leaves`);
  }
  for (const a of before.actors) if (!after.actors.some(x => x.id === a.id)) parts.push(`remove actor ${a.name}`);
  if (before.summary !== after.summary) parts.push('update summary');
  if (before.meta.title !== after.meta.title) parts.push('rename event');
  if (!parts.length) parts.push(serializeEvent(before) !== state.saved ? 'convert to the current file format' : 'edit');
  const msg = `${state.id}: ${parts.join(', ')}`;
  return msg.length > 120 ? `${msg.slice(0, 117)}...` : msg;
}

async function save() {
  if (!dirty()) return;
  if (!author()) {
    $('#author').focus();
    toast('Enter your name first (top right). It is recorded with each save.');
    return;
  }
  try {
    const res = await api(`/${state.id}`, {
      method: 'PUT',
      body: { markdown: state.markdown, message: commitMessage(), author: author(), baseCommit: state.lastCommit?.hash },
    });
    state.saved = state.markdown;
    state.lastCommit = res.lastCommit;
    toast(res.unchanged ? 'Nothing changed' : `Saved (commit ${short(res.lastCommit?.hash)})`);
    await loadEvents();
    renderMain();
  } catch (err) {
    if (err.status === 409) {
      if (confirm(`${err.message}\n\nReload now? Your unsaved changes will be lost.`)) openEvent(state.id);
    } else {
      toast(`Save failed: ${err.message}`);
    }
  }
}

function confirmLeave() {
  return !dirty() || confirm('You have unsaved changes. Discard them?');
}

// ------------------------------------------------------------ sidebar

function renderSidebar() {
  const list = $('#event-list');
  list.replaceChildren(...state.events.map(e => h('li', {},
    h('a', {
      href: `#/e/${e.id}`,
      class: e.id === state.id ? 'active' : '',
    },
    h('span', { class: 't' }, e.title),
    h('span', { class: 'm' }, `${e.records} action${e.records === 1 ? '' : 's'} · ${ago(e.lastCommit?.date)}`)),
  )));
  if (!state.events.length) list.append(h('li', { class: 'hint' }, 'No events yet.'));
}

// ------------------------------------------------------------ event page

function refreshSaveButton() {
  const btn = $('#save');
  if (!btn) return;
  btn.disabled = !dirty();
  btn.textContent = dirty() ? 'Save' : 'Saved';
}

function renderMain() {
  // On phones the event list and an open event are separate screens (see style.css).
  document.body.classList.toggle('has-event', Boolean(state.id && state.model));
  if (!state.id || !state.model) {
    main.replaceChildren(h('div', { class: 'empty' },
      h('p', {}, 'Pick an event on the left, or create a new one.'),
      h('button', { class: 'primary', onclick: openNewDialog }, 'New event')));
    return;
  }
  const m = state.model;
  // A one-line title that wraps (and grows) instead of being cut off on narrow screens.
  const title = h('textarea', {
    class: 'title-input',
    rows: 1,
    value: m.meta.title ?? '',
    'aria-label': 'Event title',
    oninput: e => {
      fitTitle(e.target);
      change(mm => { mm.meta.title = e.target.value.replace(/\s*\n+\s*/g, ' '); }, { rerender: false });
    },
    onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); e.target.blur(); } },
  });
  main.replaceChildren(
    h('div', { class: 'event-head' },
      title,
      h('button', { id: 'save', class: 'primary', onclick: save, title: 'Save as a git commit (Ctrl/Cmd+S)' })),
    h('p', { class: 'meta-line' },
      `Started ${m.meta.created || 'unknown'}`,
      state.lastCommit ? ` · last saved ${ago(state.lastCommit.date)} by ${state.lastCommit.author}` : ''),
    h('article', { class: 'doc' }, summarySection(), tabsSection()),
  );
  fitTitle(title);
  refreshSaveButton();
}

function fitTitle(el) {
  el.style.height = 'auto';
  el.style.height = `${el.scrollHeight}px`;
}

// --- Summary: click to edit in place

function summarySection() {
  const m = state.model;
  const view = h('div', {
    class: `summary editable${m.summary ? '' : ' placeholder'}`,
    role: 'button',
    tabindex: 0,
    title: `${Click} to edit`,
    onclick: () => edit(),
    onkeydown: e => { if (e.key === 'Enter') { e.preventDefault(); edit(); } },
  }, m.summary || `${Click} to add a summary of where things stand.`);

  const section = h('section', {}, h('h2', {}, 'Summary'), view);
  function edit() {
    const ta = h('textarea', { rows: 4, value: m.summary, 'aria-label': 'Summary' });
    let done = false;
    const finish = keep => {
      if (done) return;
      done = true;
      if (keep && ta.value.trim() !== m.summary) change(mm => { mm.summary = ta.value.trim(); });
      else renderMain();
    };
    ta.addEventListener('blur', () => finish(true));
    ta.addEventListener('keydown', e => {
      if (e.key === 'Escape') finish(false);
      if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) finish(true);
    });
    view.replaceWith(ta);
    ta.focus();
  }
  return section;
}

// --- Timeline and Details, as two tabs

function tabsSection() {
  const m = state.model;
  const tab = (id, label) => h('button', {
    role: 'tab',
    class: 'tab',
    'aria-selected': String(state.tab === id),
    onclick: () => { state.tab = id; renderMain(); },
  }, label);
  return h('section', {},
    h('div', { class: 'section-head' },
      h('div', { class: 'tabs', role: 'tablist' }, tab('timeline', 'Timeline'), tab('details', 'Details')),
      h('span', { class: 'spacer' }),
      h('button', { onclick: () => editActor(null) }, '+ Actor'),
      h('button', { onclick: () => editRecord(null), disabled: !m.actors.length }, '+ Action')),
    state.tab === 'timeline' ? timelinePanel() : detailsPanel());
}

function timelinePanel() {
  const m = state.model;
  const diagram = h('div', { id: 'diagram', class: 'diagram' });
  state.pick = null;
  if (!m.actors.length) {
    diagram.append(h('p', { class: 'hint' }, 'Start by adding the people or organizations involved with + Actor.'));
  } else {
    renderDiagram(diagram);
  }
  return h('div', { role: 'tabpanel' },
    h('p', { id: 'connect-hint', class: 'hint' }, pickHint(null)),
    h('div', { id: 'actor-bar', class: 'actor-bar', 'aria-hidden': 'true' }),
    diagram);
}

let renderCount = 0;
async function renderDiagram(container) {
  const seq = String(++renderCount);
  container.dataset.seq = seq;
  const domId = `mmd-${seq}`;
  try {
    // Drawn from the parsed event, so the diagram is always in the current format.
    const { svg } = await mermaid.render(domId, buildDiagram(state.model));
    if (container.dataset.seq !== seq) return;
    container.innerHTML = svg;
    sizeDiagram(container);
    wireDiagram(container.querySelector('svg'));
  } catch (err) {
    document.getElementById(domId)?.remove();
    document.getElementById(`d${domId}`)?.remove();
    if (container.dataset.seq === seq) {
      container.replaceChildren(h('pre', { class: 'diagram-error' }, `Diagram error: ${err.message ?? err}`));
    }
  }
}

// Fit the diagram to the page, but never below minDiagramScale() of its real size.
function sizeDiagram(container) {
  const svg = container.querySelector('svg');
  const natural = svg?.viewBox?.baseVal?.width;
  if (!natural) return;
  const avail = container.clientWidth;
  const width = natural <= avail ? natural : Math.max(avail, natural * minDiagramScale());
  svg.setAttribute('width', String(Math.round(width)));
  svg.style.width = `${Math.round(width)}px`;
  svg.style.maxWidth = 'none';
}

function wireDiagram(svg) {
  if (!svg) return;
  const lifelines = [...svg.querySelectorAll('line.actor-line')].map(el => ({
    el,
    id: el.getAttribute('data-id') || el.getAttribute('name'),
    x: Number(el.getAttribute('x1')),
    top: Number(el.getAttribute('y1')),
    bottom: Number(el.getAttribute('y2')),
  })).filter(l => l.id);
  if (!lifelines.length) return;
  const xs = lifelines.map(l => l.x).sort((a, b) => a - b);
  const gaps = xs.slice(1).map((x, i) => x - xs[i]);
  const reach = Math.max(40, Math.min(...gaps, 400) / 2);

  const toSvg = e => {
    const pt = svg.createSVGPoint();
    pt.x = e.clientX;
    pt.y = e.clientY;
    return pt.matrixTransform(svg.getScreenCTM().inverse());
  };
  const nearest = p => {
    let best = null;
    for (const l of lifelines) if (!best || Math.abs(l.x - p.x) < Math.abs(best.x - p.x)) best = l;
    return best && Math.abs(best.x - p.x) <= reach ? best : null;
  };

  // Arrows (label or line) open their action. Mermaid draws one line per arrow in source
  // order, which is date order with one arrow per recipient. A label can be several text
  // elements (wrapped on phones); each belongs to the first arrow line just below it.
  const arrowIds = sortedRecords(state.model).flatMap(r => r.to.map(() => r.id));
  const lines = [...svg.querySelectorAll('.messageLine0, .messageLine1')];
  if (lines.length === arrowIds.length) {
    const openFor = id => e => { e.stopPropagation(); editRecord(id); };
    const lineYs = lines.map(l => l.getBBox().y);
    lines.forEach((line, i) => {
      if (line.tagName !== 'line') return;
      const area = line.cloneNode();
      area.removeAttribute('marker-end');
      area.removeAttribute('style');
      area.setAttribute('class', 'hit-area');
      area.addEventListener('click', openFor(arrowIds[i]));
      line.after(area);
    });
    for (const t of svg.querySelectorAll('text.messageText')) {
      const b = t.getBBox();
      let best = -1;
      lineYs.forEach((y, i) => {
        if (y >= b.y + b.height - 6 && (best < 0 || y < lineYs[best])) best = i;
      });
      if (best < 0) continue;
      t.classList.add('hit');
      t.addEventListener('click', openFor(arrowIds[best]));
    }
  }

  // Actor boxes open the actor; clicks on lifelines pick from → to for a new record.
  svg.addEventListener('mousemove', e => {
    const p = toSvg(e);
    const l = nearest(p);
    const inBody = l && p.y >= l.top && p.y <= l.bottom;
    for (const x of lifelines) x.el.classList.toggle('hover', inBody && x === l);
    svg.style.cursor = l ? 'pointer' : '';
  });
  svg.addEventListener('mouseleave', () => lifelines.forEach(x => x.el.classList.remove('hover')));
  stickyActors(svg, lifelines);

  const BOX = 80;  // actor boxes sit just above (and below) each lifeline
  svg.addEventListener('click', e => {
    const p = toSvg(e);
    const l = nearest(p);
    if (!l) return;
    if (p.y < l.top || p.y > l.bottom) {
      if (p.y >= l.top - BOX && p.y <= l.bottom + BOX) editActor(l.id);
    } else if (state.pick == null) setPick(l.id);
    else {
      const from = state.pick;
      setPick(null);
      editRecord(null, { from, to: l.id });
    }
  });
}

// While the actor boxes are scrolled out of view, a bar pinned under the title shows the
// name of every actor whose lifeline is present at that point, above its line.
let stopStickyActors = () => {};
function stickyActors(svg, lifelines) {
  stopStickyActors();
  const bar = $('#actor-bar');
  const scroller = svg.parentElement;
  if (!bar || !scroller) return;
  const labels = new Map(lifelines.map(l => [l.id, h('button', {
    class: 'actor-chip', tabindex: -1, onclick: () => editActor(l.id),
  }, actorName(l.id))]));
  const inner = h('div', { class: 'actor-bar-inner' }, [...labels.values()]);
  bar.replaceChildren(inner);
  const headerTop = top => { bar.style.top = `${top}px`; };

  const update = () => {
    if (!svg.isConnected) return stopStickyActors();
    const head = $('.event-head');
    const pinTop = head ? head.getBoundingClientRect().bottom : 0;
    headerTop(head ? head.offsetHeight : 0);
    const ctm = svg.getScreenCTM();
    if (!ctm) return;
    const y = (pinTop + 18 - ctm.f) / ctm.d;              // diagram y under the bar
    const boxesGone = lifelines.some(l => y > l.top);
    const before = lifelines.every(l => y < l.top) || lifelines.every(l => y > l.bottom);
    inner.classList.toggle('show', boxesGone && !before);
    const left = bar.getBoundingClientRect().left;
    const sLeft = scroller.getBoundingClientRect().left;
    const sRight = scroller.getBoundingClientRect().right;
    for (const l of lifelines) {
      const chip = labels.get(l.id);
      const x = ctm.a * l.x + ctm.e;
      const visible = y >= l.top && y <= l.bottom && x >= sLeft && x <= sRight;
      chip.classList.toggle('show', visible);
      // Centered over its line, but kept fully inside the visible part of the diagram.
      const half = chip.offsetWidth / 2;
      const cx = Math.min(Math.max(x, sLeft + half), sRight - half);
      chip.style.left = `${cx - left}px`;
    }
  };
  const opts = { passive: true };
  window.addEventListener('scroll', update, opts);
  window.addEventListener('resize', update, opts);
  scroller.addEventListener('scroll', update, opts);
  stopStickyActors = () => {
    window.removeEventListener('scroll', update);
    window.removeEventListener('resize', update);
    scroller.removeEventListener('scroll', update);
    stopStickyActors = () => {};
  };
  update();
}

function setPick(id) {
  state.pick = id;
  for (const el of document.querySelectorAll('#diagram line.actor-line')) {
    el.classList.toggle('picked', id != null && (el.getAttribute('data-id') || el.getAttribute('name')) === id);
  }
  const hint = $('#connect-hint');
  if (!hint) return;
  hint.classList.toggle('active', id != null);
  hint.textContent = pickHint(id);
}

function pickHint(id) {
  return id != null
    ? `From ${actorName(id)}: now click who it went to. Press Esc to cancel.`
    : `${Click} a name to edit it. ${Click} an arrow to edit the action. To add an action, ${Click.toLowerCase()} one line and then another.`;
}

// --- Details: readable list grouped by date, click an entry to edit

function detailsPanel() {
  const recs = sortedRecords(state.model);
  if (!recs.length) return h('div', { role: 'tabpanel' }, h('p', { class: 'hint' }, 'No actions yet.'));
  const items = [];
  let day = null;
  for (const r of recs) {
    if (r.date !== day) {
      day = r.date;
      items.push(h('h3', { class: 'day' }, r.date ? `${weekday(r.date)} ${r.date}` : 'Undated'));
    }
    items.push(h('div', {
      class: 'detail editable',
      role: 'button',
      tabindex: 0,
      title: `${Click} to edit`,
      onclick: () => editRecord(r.id),
      onkeydown: e => { if (e.key === 'Enter') editRecord(r.id); },
    },
    h('div', { class: 'detail-head' }, `${actorName(r.from)} → ${r.to.map(actorName).join(', ')}`),
    h('div', { class: 'detail-text' }, r.text),
    r.details
      ? h('div', { class: 'detail-body' }, r.details)
      : h('div', { class: 'detail-body placeholder' }, `No details yet. ${Click} to add.`)));
  }
  return h('div', { role: 'tabpanel' }, items);
}

// ------------------------------------------------------------ edit dialogs

// One shared <dialog>. onSubmit returns false to keep it open (validation failed).
function openDialog({ title, fields, submitLabel, onSubmit, onDelete, deleteLabel, deleteDisabled }) {
  const dialog = $('#edit-dialog');
  const form = h('form', { method: 'dialog' },
    h('h2', {}, title),
    fields,
    h('p', { class: 'form-error', role: 'alert' }),
    h('div', { class: 'row' },
      onDelete ? h('button', {
        type: 'button', class: 'danger', disabled: deleteDisabled,
        title: typeof deleteDisabled === 'string' ? deleteDisabled : null,
        onclick: () => { if (onDelete() !== false) dialog.close(); },
      }, deleteLabel) : null,
      h('span', { class: 'spacer' }),
      h('button', { type: 'button', onclick: () => dialog.close() }, 'Cancel'),
      h('button', { class: 'primary', value: 'ok' }, submitLabel)));
  form.addEventListener('submit', e => {
    e.preventDefault();
    const err = onSubmit();
    if (typeof err === 'string') {
      form.querySelector('.form-error').textContent = err;
      return;
    }
    dialog.close();
  });
  form.addEventListener('input', () => { form.querySelector('.form-error').textContent = ''; });
  dialog.replaceChildren(form);
  dialog.showModal();
  form.querySelector('input, select, textarea')?.focus();
}

const field = (label, control) => h('label', { class: 'field' }, h('span', {}, label), control);
const fieldGroup = (label, control) => h('div', { class: 'field', role: 'group', 'aria-label': label }, h('span', {}, label), control);

function actorSelect(value) {
  return h('select', {}, state.model.actors.map(a => h('option', { value: a.id, selected: a.id === value }, a.name || a.id)));
}

function editRecord(id, preset = {}) {
  const m = state.model;
  if (!m.actors.length) return editActor(null);
  const r = id ? m.records.find(x => x.id === id) : null;
  const last = sortedRecords(m).at(-1);
  const arrows = { ...ARROWS };
  if (r?.arrow && !arrows[r.arrow]) arrows[r.arrow] = r.arrow;

  const date = h('input', { type: 'date', value: r?.date || today(), required: true });
  const from = actorSelect(r?.from ?? preset.from ?? last?.to[0] ?? m.actors[0].id);
  const initialTo = r?.to ?? [preset.to ?? last?.from ?? m.actors[Math.min(1, m.actors.length - 1)].id];
  const toBoxes = m.actors.map(a => h('input', { type: 'checkbox', value: a.id, checked: initialTo.includes(a.id) }));
  const to = h('div', { class: 'checks' },
    m.actors.map((a, i) => h('label', { class: 'check' }, toBoxes[i], a.name || a.id)));
  const arrow = h('select', {}, Object.entries(arrows).map(([v, label]) =>
    h('option', { value: v, selected: v === (r?.arrow || '->>') }, label === 'reply' ? 'Reply (dashed)' : label === 'message' ? 'Message / action' : v)));
  const text = h('input', { value: r?.text ?? '', placeholder: 'What was done or said, in a few words (shown on the arrow)' });
  const details = h('textarea', {
    rows: 5, value: r?.details ?? '',
    placeholder: 'Details: exact words, how it happened (call, email, letter), evidence',
  });

  openDialog({
    title: r ? 'Edit action' : 'New action',
    fields: [
      h('div', { class: 'field-row' }, field('Date', date), field('Type', arrow)),
      field('From', from),
      fieldGroup('To (one or more)', to),
      field('Action', text),
      field('Details', details),
    ],
    submitLabel: r ? 'Done' : 'Add',
    deleteLabel: 'Delete action',
    onDelete: r && (() => {
      if (!confirm(`Delete "${r.text}"? Earlier saved versions keep it in the git history.`)) return false;
      change(mm => { mm.records.splice(mm.records.indexOf(r), 1); });
    }),
    onSubmit: () => {
      if (!date.value) return 'Pick a date.';
      const recipients = toBoxes.filter(b => b.checked).map(b => b.value);
      if (!recipients.length) return 'Pick at least one actor under To.';
      if (!text.value.trim()) return 'Describe the action.';
      const values = {
        date: date.value, from: from.value, arrow: arrow.value, to: recipients,
        text: text.value.trim(), details: details.value.trim(),
      };
      if (r) {
        change(() => Object.assign(r, values));
      } else {
        change(mm => mm.records.push({ id: nextRecordId(mm), ...values, before: [], after: [] }));
        toast(`Action added. ${Click} Save to keep it.`);
      }
    },
  });
}

function uniqueActorId(base) {
  const taken = new Set(state.model.actors.map(a => a.id));
  let id = base;
  for (let n = 2; taken.has(id); n++) id = `${base}${n}`;
  return id;
}

function editActor(id) {
  const m = state.model;
  const a = id ? m.actors.find(x => x.id === id) : null;
  const used = a ? m.records.filter(r => r.from === a.id || r.to.includes(a.id)).length : 0;
  const name = h('input', { value: a?.name ?? '', placeholder: 'e.g. Landlord, Dr. Lee, City council' });
  const contact = h('input', { value: a?.contact ?? '', placeholder: 'Role, phone, email, reference number' });
  const kind = h('select', {},
    h('option', { value: 'actor', selected: a?.kind === 'actor' }, 'Person (stick figure)'),
    h('option', { value: 'participant', selected: !a || a.kind !== 'actor' }, 'Organization or other (box)'));

  // When this actor enters and leaves the timeline, tied to its own first/last action.
  const span = a ? actorSpans(m).get(a.id) : null;
  const label = r => `${r.date} · ${r.text}`;
  const joins = h('input', { type: 'checkbox', checked: Boolean(a?.joins && span?.canJoin), disabled: !span?.canJoin });
  const leaves = h('input', { type: 'checkbox', checked: Boolean(a?.leaves && span?.canLeave), disabled: !span?.canLeave });
  const joinHint = !span?.first
    ? 'Add an action involving this actor first.'
    : span.canJoin
      ? `Appears on the timeline at ${label(span.first)}`
      : span.first.date === sortedRecords(m)[0]?.date
        ? 'Involved from the first day, so it is there from the start.'
        : `Its first action ("${span.first.text}") is one it sends. To show it joining, its first action must be one it receives, e.g. someone contacts it.`;
  const leaveHint = span?.last ? `Its line ends after ${label(span.last)}` : 'Add an action involving this actor first.';

  openDialog({
    title: a ? `Edit ${a.name}` : 'New actor',
    fields: [
      field('Name', name), field('Role / contact', contact), field('Shown as', kind),
      a ? fieldGroup('On the timeline', h('div', { class: 'checks stacked' },
        h('label', { class: 'check' }, joins, 'Joins later, at its first action'),
        h('p', { class: 'hint' }, joinHint),
        h('label', { class: 'check' }, leaves, 'Leaves after its last action'),
        h('p', { class: 'hint' }, leaveHint))) : null,
    ],
    submitLabel: a ? 'Done' : 'Add',
    deleteLabel: 'Remove actor',
    deleteDisabled: used ? `Used in ${used} action${used === 1 ? '' : 's'}. Delete or change those first.` : false,
    onDelete: a && (() => change(mm => { mm.actors.splice(mm.actors.indexOf(a), 1); })),
    onSubmit: () => {
      const n = name.value.trim();
      if (!n) return 'Enter a name.';
      if (a) {
        change(() => Object.assign(a, {
          name: n, contact: contact.value.trim(), kind: kind.value,
          joins: joins.disabled ? a.joins : joins.checked,
          leaves: leaves.disabled ? a.leaves : leaves.checked,
        }));
      } else {
        change(mm => mm.actors.push({
          id: uniqueActorId(actorId(n)), name: n, contact: contact.value.trim(), kind: kind.value, joins: false, leaves: false,
        }));
      }
    },
  });
}

// ------------------------------------------------------------ new event

function openNewDialog() {
  const form = $('#new-form');
  form.reset();
  form.elements.created.value = today();
  $('#new-dialog').showModal();
}

$('#new-form').addEventListener('submit', async e => {
  if (e.submitter?.value !== 'create') return;
  const form = $('#new-form');
  const seen = new Set();
  const actors = form.elements.actors.value.split(',').map(s => s.trim()).filter(Boolean).map(name => {
    let id = actorId(name);
    for (let n = 2; seen.has(id); n++) id = `${actorId(name)}${n}`;
    seen.add(id);
    return { id, name, kind: /^(me|i|myself)$/i.test(name) ? 'actor' : 'participant' };
  });
  try {
    const res = await api('', {
      method: 'POST',
      body: { title: form.elements.title.value, created: form.elements.created.value, actors, author: author() || 'Anonymous' },
    });
    await loadEvents();
    location.hash = `#/e/${res.id}`;
    toast('Event created');
  } catch (err) {
    toast(err.message);
  }
});

// ------------------------------------------------------------ boot

function route() {
  const id = /^#\/e\/([a-z0-9-]+)/.exec(location.hash)?.[1] ?? null;
  if (id === state.id) return;
  if (!confirmLeave()) {
    location.hash = state.id ? `#/e/${state.id}` : '#/';  // stay; the re-fired route() is a no-op
    return;
  }
  state.markdown = state.saved;  // discarded
  if (id) openEvent(id);
  else { state.id = null; state.model = null; renderSidebar(); renderMain(); }
}

$('#author').value = store.get('truthup.author') ?? '';
$('#author').addEventListener('input', e => store.set('truthup.author', e.target.value.trim()));
$('#new-event').addEventListener('click', openNewDialog);
$('#back').addEventListener('click', () => { location.hash = '#/'; });
$('#new-cancel').addEventListener('click', () => $('#new-dialog').close());
window.addEventListener('hashchange', route);
window.addEventListener('beforeunload', e => { if (dirty()) e.preventDefault(); });
window.addEventListener('keydown', e => {
  if ((e.metaKey || e.ctrlKey) && e.key === 's') { e.preventDefault(); save(); }
  if (e.key === 'Escape' && state.pick != null && !$('#edit-dialog').open) setPick(null);
});

await loadEvents().catch(err => toast(`Could not load events: ${err.message}`));
route();
