# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

TruthUp records long-running, multi-person events (a dispute, a repair, a negotiation, a news story) so the details aren't forgotten. Each **event is one Markdown file** whose heart is a **Mermaid sequence diagram, the Timeline**: who did or said what to whom, on which date. Events live in a **git repository**, and every **Save in the web page is one git commit**, so both the event's history and the history of *how it was recorded* are kept.

It is a small local web app: a zero-dependency Node server ([server.mjs](server.mjs)) plus a plain-JS page ([web/](web/)). Mermaid is the only npm dependency, used only by the browser.

## Commands

```bash
npm install        # installs mermaid (the only dependency)
npm start          # serve at http://127.0.0.1:5180, data repo in ./data
npm test           # node --test tests/*.test.mjs (format + API tests)
```

```bash
node --test tests/format.test.mjs   # one test file
```

Environment: `TRUTHUP_DATA` (data repo folder, default `./data`), `PORT` (default 5180), `HOST` (default `127.0.0.1`). Requires Node 22+ and the `git` CLI.

On first start the server creates the data folder, runs `git init -b main`, and seeds it with `examples/*.md` (one commit per file). `data/` is gitignored. It is the user's own repository of real events, separate from this app's repo.

**Events are managed only by the local git repo on the web server** (user's rule): the server commits each save into its own data repo, and events never leave that machine. **Events must never be pushed to GitHub.** This app repo is public (github.com/masonwang/TruthUp). Never add, commit or push anything from `data/` (or any other events folder) to it, never add a remote to the data repo, and never move real events into `examples/`. Keep `data/` in `.gitignore`.

## Architecture

```
web/format.js   Markdown <-> model (pure, no DOM). Shared by the browser, the server and the tests
server.mjs      HTTP server: static files, /vendor/mermaid.min.js, events JSON API, git commits
web/app.js      The page: sidebar of events + one page per event, edited by clicking
web/index.html  Shell: top bar (author name), sidebar, #main, New-event dialog, shared #edit-dialog
web/style.css   Tokens on :root with a dark-mode override; no framework
examples/       Seed event(s) copied into a new data repo
tests/          format.test.mjs (parser/writer), api.test.mjs (server against a temp git repo)
```

### Source of truth and data flow

The **Markdown file is the source of truth**. The page:
1. `GET /api/events/:id` → `parseEvent(markdown)` → `state.model`.
2. Every edit goes through `change(fn)`, which mutates the model, sets `state.markdown = serializeEvent(model)` and re-renders.
3. The diagram is always drawn from `buildDiagram(state.model)`, never from the raw file text, so older files never show their old syntax.
4. **Save** → `PUT /api/events/:id {markdown, message, author, baseCommit}` → server writes the file and commits.

`openEvent` stores the canonical `serializeEvent(parseEvent(file))` as `state.markdown` but keeps the file text as `state.saved`. An older-format file therefore opens already converted, with Save enabled, and its commit message becomes "convert to the current file format".

### Server API (`server.mjs`, `createApp({ dataDir, seed })`)

| Method & path | Does |
|---|---|
| `GET /api/events` | List: id, title, created, action count, last commit (sorted by last change) |
| `POST /api/events {title, created, actors, author}` | Creates `events/<yyyy-mm>-<slug>.md` (unique suffix `-2`…), commits `<id>: open event` |
| `GET /api/events/:id` | `{markdown, lastCommit}` |
| `PUT /api/events/:id {markdown, message, author, baseCommit}` | 409 if `baseCommit` ≠ the file's last commit (someone saved meanwhile). No commit if unchanged |
| `DELETE /api/events/:id` | `git rm` + commit |
| `GET /api/events/:id/history` | `git log --follow` for the file (not shown in the page any more) |
| `GET /api/events/:id/versions/:hash` | File at that commit + its diff (not shown in the page any more) |

Commit identity: the **committer is always `TruthUp <truthup@localhost>`** (set via env, so no global git config is needed). The **author is the name typed in the page** (`Name <slug@truthup.local>`, default `Anonymous`). Git operations run through a promise queue (`locked`) so concurrent saves never hit `index.lock`. Event IDs must match `^[a-z0-9][a-z0-9-]{0,80}$` and hashes `^[0-9a-f]{7,40}$`. That validation is the path-traversal guard, so keep it. The server binds to `127.0.0.1` and has no auth: don't widen `HOST` without adding authentication. A port already in use gives a friendly message instead of a stack trace.

## The event file format (`web/format.js`)

```markdown
---
id: 2026-09-kitchen-leak
title: Kitchen sink leak, repair and insurance claim
created: 2026-09-03
---

# Kitchen sink leak, repair and insurance claim

## Summary
## Actors        table: | ID | Name | Role / contact |
## Timeline      one ```mermaid sequenceDiagram
## Details       one entry per action
## <other>       any extra section is kept verbatim (extraSections)
```

Model: `{ meta, summary, actors[{id,name,kind,contact,joins,leaves}], records[{id,date,from,arrow,to[],text,details,before[],after[]}], preamble[], trailing[], extraSections[] }`. In code an action is a "record". In the UI it's always called an **action**.

### Timeline rules (what `buildDiagram` emits)

- **One shaded block per date**: `rect rgba(127, 127, 127, 0.08)`, then `Note over <first>,<last>: YYYY-MM-DD (Wkd)` as its first statement (the parser recognizes a date block by that note), then the arrows, then `end`. Records are sorted by date (stable within a day: `sortedRecords`).
- **Action IDs are permanent but never visible.** In the diagram an ID is a Mermaid comment on the line before the action's arrows (`%% E5`). In Details it's an HTML comment right under the heading (`<!-- E5 -->`). New actions get `nextRecordId` = max + 1, so an action added later for an earlier date has a high number but sorts by date. **Never show IDs** in the page, the diagram labels, the details headings or commit messages (the user asked for this explicitly). Commit messages quote the action text instead: `add "…"`, `revise "…"`, `remove "…"`.
- **One action → one or more recipients**: one arrow per recipient. Only the first arrow carries the text, and the rest are unlabelled (`A->>C:`, which Mermaid accepts). When parsing, an unlabelled arrow with no `%%` ID, the same sender, arrow type and date, directly after an action, is another recipient of that action.
- `->>` = message/action, `-->>` = reply. Other Mermaid arrow types are kept as-is.
- **Actors joining and leaving** (`actorSpans`): an actor can join at its first action (`create participant X as Name` right before the arrow reaching it, instead of being declared at the top) and leave after its last action (`destroy X` before its last arrow). The model only stores `joins`/`leaves` flags. Placement is derived from the actions, so the diagram never references an actor before it exists or after it's gone. Mermaid constraints, verified in the browser:
  - `create` only works when the created actor is the **receiver** of the next arrow. So `canJoin` requires the actor's first action to be one it receives, **not** on the first day (someone must already be on the timeline). Otherwise the flag is ignored and the actor is declared up front.
  - `destroy` works whether the actor is sender or receiver. An actor that joins and leaves on the same single action just stays.
  - An actor can't come back after `destroy`. That would need a second actor.
  - Date notes only span actors alive at that point (`living` columns), because a note over a not-yet-created actor would implicitly create it.
- Actor column order: the Actors table order wins on parse (joiners appear late in the Mermaid source).
- `;` and `#` break Mermaid message text, so they're written as `#59;` / `#35;` (`encodeMermaidText`) and decoded on parse.
- Lines TruthUp doesn't model (notes, `alt`/`loop`/`opt`, `autonumber`, other `%%` comments…) are kept: before the first action → `preamble`, between actions → the next record's `before`, at the end of a date block → the previous record's `after`, else `trailing`.

### Backward compatibility (keep it)

`parseEvent` still reads older files, and the next save rewrites them in the current format:
- v0.1: `## Sequence` instead of `## Timeline`, and a `status: open|concluded` front-matter key (dropped on parse).
- v0.2: visible tags on arrows (`A->>B: [E5] text`, extra recipients `A->>C: [E5]`) and headings `### E5 · date · from → to · text`.

### Invariants (do not break)

- `serializeEvent(parseEvent(x))` must be byte-identical for a canonical file (the example is tested this way). Parsing a legacy file must give the same records as its canonical form.
- An ID that has been used can't be reused by a different action. A duplicate is parsed as a new action and given a fresh ID.
- The arrow → action mapping in the page relies on Mermaid emitting **one `.messageLine0/1` per arrow, in source order**. `wireDiagram` maps lines by index to `sortedRecords(model).flatMap(r => r.to.map(() => r.id))` (only when the counts match). Labels are *not* one per arrow: with wrapping (phones), one label becomes several `text.messageText` elements, so each text is attached to the first arrow line just below it (by `getBBox`). If `buildDiagram` ever emits arrows in a different order than `sortedRecords`, clicks open the wrong action.

## The page (`web/app.js`), as the user wants it

These are deliberate product decisions from the user. Don't reintroduce what was removed.
- **One page per event**, edited by clicking: the title is an inline input, the **Summary** is click-to-edit text, and below it are **two tabs: Timeline and Details**, with `+ Actor` and `+ Action` to their right.
- **One Save button** (Ctrl/Cmd+S), shown as "Saved" when clean. No commit-message box, no status dropdown, no Markdown/History tabs (those existed in v0.1 and were removed at the user's request).
- In the Timeline: click an actor's box → actor dialog (name, role/contact, person or box, "Joins later, at its first action", "Leaves after its last action", Remove when unused). Click an arrow (label, or the invisible wide `hit-area` line) → action dialog. Click one lifeline then another → new action prefilled from → to (Esc cancels). In Details: entries grouped by date, click one to edit.
- Action dialog: date, type (message/reply), from, **To (one or more)** checkboxes, action text, details.
- `mermaid.initialize({ sequence: { mirrorActors: false } })`: **no actor boxes repeated at the bottom.**
- **Sticky actor names** (`stickyActors`): when the top actor boxes scroll away, a zero-height sticky `#actor-bar` under the sticky title shows a chip per actor above its lifeline, only for actors whose lifeline exists at that scroll position (joiners appear and leavers disappear). Its listeners are removed when the diagram re-renders.
- The author name lives in `localStorage` (`truthup.author`) and is required before saving.
- **Phones** (`max-width: 860px`, the `narrow` media query):
  - The event list and an open event are separate screens: `body.has-event` hides the sidebar and shows a "‹ Events" back button in the top bar.
  - Mermaid is re-initialized with a compact layout (`wrap: true`, `width: 110`, `actorMargin: 20`, smaller fonts), which roughly halves the diagram width.
  - `sizeDiagram` fits the diagram to the page but never below 75% of its real size on phones (60% on desktop). Anything wider scrolls sideways, and the sticky actor chips follow, clamped inside the visible area.
  - Hints say "Tap" instead of "Click" on touch screens (`pointer: coarse`).
  - Inputs are 16px so iOS Safari doesn't zoom on focus. Dialog fields stack below 480px.
  - The title is an auto-growing one-line textarea, so it wraps instead of being cut off. Enter blurs it.
- Leaving an event with unsaved changes asks first (the `route()` guard covers the sidebar, the back button and the logo link).
- `<dialog>` handling: use the form `submit` event (with `e.submitter`), not the dialog `close` event, which didn't fire reliably in the embedded browser. Cancel buttons are `type="button"` so Enter submits the primary action.

## Constraints

- **No CDN or runtime external scripts.** Mermaid is served by the server from `node_modules/mermaid/dist/mermaid.min.js` at `/vendor/mermaid.min.js`. The browser loads nothing from the internet.
- The server and `format.js` have zero dependencies. Keep `format.js` free of DOM APIs, because Node imports it too.
- Plain JS (ES modules, `"type": "module"`), no build step, no framework. UI helpers: `h(tag, props, ...kids)` builds DOM. Never set `innerHTML` except with Mermaid's own sanitized SVG (`securityLevel: 'strict'`).
- Wrap every `localStorage` access in try/catch (the `store` helper).

## Verifying changes

- `npm test` covers `format.js` and the server API (it spins the server up on a temporary git repo). The page (`web/app.js`) is **not** covered headlessly, so check UI changes in a real browser.
- **Never test against the user's `data/` folder** (it holds their real events). Run a throwaway server instead and remove it afterwards:
  ```bash
  TRUTHUP_DATA=/tmp/truthup-test-data PORT=5181 node server.mjs
  ```
- Any new Mermaid construct must be checked with `mermaid.parse`/`render` in the browser: Mermaid's rules (e.g. `create` only on a received arrow) aren't visible from Node.
- The user usually runs their own server on 5180 in a terminal tab. Static files are read on every request (a page reload picks up `web/` changes), but changes to `server.mjs` or `format.js` need that server restarted.
- `.claude/launch.json` defines `truthup` (port 5180). In the desktop app the preview launcher has been confused by the Photo3D server on 5173, so starting the server yourself and opening the URL directly works more reliably.

## Docs

[README.md](README.md) is for users (running it, using the page, file format). [PLAN.md](PLAN.md) holds decisions, the roadmap (Mermaid `timeline`) and open questions. Keep both in step with behaviour changes.
