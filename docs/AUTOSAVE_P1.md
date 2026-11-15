# Autosave P1

Base: `47b2c874256c8e0a9f494a94a6139d5d9bfa7675` (main, including PCF closure attribution and late Builder reply fixes). No merge, deployment or production data changes.

## Cadence and uninterrupted editing

- Main kjx and legacy use `AUTOSAVE_INTERVAL_MS = 15 * 60 * 1000` from `lib/auto-save.ts`. Fixed cadence begins when a project opens; normal ticks send only dirty work. Keystrokes/manual saves do not reset it. The 3-second debounce and configurable short sync timer are removed. Config displays the fixed interval. Historical autoSyncInterval data remains readable but no longer controls scheduling.
- Save Now, beforeunload warning, kjx save-before-switch blocking and legacy save/discard prompts remain. Hidden visibilitychange/pagehide make best-effort saves; browsers can suspend/kill requests, so these are not durability guarantees. Failed project saves retain separate 3/6/12/24/48/60-second retries and P0 permanent-error gates/receipts.
- The disruptive root cause was `saveProjectAttempt` setting global `isLoading`, mounting App's full-screen **Syncing Data** blur overlay on each save. The 3-second debounce amplified it. Saving now changes only save status, never page-loading state. Existing keyed rows, snapshot-specific acknowledgements and dirty-field SSE merges remain. Browser coverage holds a real PATCH, types into Config, releases the acknowledgement, and verifies focus and newer values remain intact.
- PCF investigation: saved `autoSaveSeconds` defaults to **60 seconds**; standalone/legacy options are Off/30/60/120/300 seconds. Hosted kjx overrides its runtime timer to 15 minutes, exposes Next autosave, corrects hosted options/status labels, and retains manual save, leave warning, IndexedDB persistence, receipt queue and rejection cleanup. Persisted schema/settings and exported/legacy templates are unchanged. PCF already uses `hubRenderLive`/`hubMorph` to preserve focused editors and three-way merge; no full render rewrite was needed on its successful-save path.

## Tracker and confirmation

Each mark, including APR, has a persisted actor/project/drawing/assignee intent. Saving disables the mark and says In progress; duplicate clicks cannot invert an in-flight intent. Failed — Retry preserves the exact desired boolean and exposes the failure reason in its tooltip. Both successful PUTs and lost/error responses require a fresh bounded read-back; the desired value being present is authoritative. Otherwise the intent remains pending, survives reload, and participates in Save Now/leave warning/kjx switch blocking. Another actor cannot replay it. Legacy retains save/discard switching. Tracker marks remain immediate user commands, not background autosave ticks; explicit retry avoids expanding this into a general offline protocol.

Project write `verification.error` is Awaiting confirmation, not Saved. Dirty fields/config/deletions/Tracker and the P0 frozen request remain. Receipts with unsuccessful verification are rechecked without repeating the write or audit, avoiding permanent replay of a transient verification error. Read-back mismatches remain pending. Post-Send read failures retain dirty state. Known-success receipt semantics stay unchanged.

localStorage reads/writes/deletes catch quota/security failures and show a sticky **Local recovery unavailable (storage full or disabled)** warning, without losing in-memory edits or recursively writing the store. Keep the page open and Save Now: recovery is not promised when storage failed. Hosted PCF status-storage failures are visible too; IndexedDB is separate and retains its existing failure notice.

## Daily Log

- Kjx always uses Server and hides Local. Legacy keeps Local/Server.
- Server defaults to Raw entries; Refresh explicitly refetches. The existing project SSE stream dispatches scoped change/catch-up notifications; Daily Log coalesces bursts to one refresh per second and ignores other projects.
- Keyset pages contain 500 rows, ordered by timestamp then numeric audit id; Load more replaces the hard 2000-row truncation. New head inserts do not shift older pages. Refresh starts a fresh first page and intentionally resets loaded depth to keep cursors coherent. Copy/CSV/PDF export **loaded rows**, with a visible more-records notice until the rest is loaded. This bounds initial rendering/network cost.
- Optional Merged consecutive combines only adjacent comment events by the same known actor/drawing/local day, with matching count boundaries. Another actor/drawing/status event breaks the chain; missing actors are never guessed. Filtering follows merging, so actor filtering cannot bridge another actor's event. Same-timestamp records preserve audit-id order. Legacy Server history lacks reliable actors and is conservatively left raw; its Local snapshot list is unchanged.

## Validation and screenshots

Development runs one related test file per invocation. Focused tests cover cadence, nonblocking/newer-edit saving, verification errors, Tracker double-click/lost-response/persisted intent, storage errors, merge boundaries, 2105-row pagination with head inserts, hosted PCF cadence, and receipt verification recovery without duplicate audit.

Browser regression advances the real page clock fifteen minutes (no three-second save), holds PATCH while typing, checks Server-only/Refresh/Load more/SSE throttle, Tracker in-progress/failure/retry/lost receipt and storage quota warning. Existing conflict and affected legacy/kjx cases now click Save Now instead of depending on removed debounce. No behavior assertion was dropped.

Screenshots (fixture data only, git-ignored):
- `hub-server/test/artifacts/autosave-p1-status.png`
- `hub-server/test/artifacts/autosave-p1-daily-server.png`
- `hub-server/test/artifacts/autosave-p1-tracker-failed.png`

Final full hub:test, hub:e2e and hub:build results are recorded after their single submission-stage run. GitHub CI is checked after publishing.

### Submission-stage results (2026-11-15)

The single local full run reported **347/353 unit tests** and **18/20 browser files**.
It exposed six unit regressions (old pagination/merge assertions, conflict
acknowledgements re-marked dirty after removing global loading, and legacy
conflict retry compatibility) and two browser regressions (a Team Setup test
still relying on debounce, and Fix Deadline itself relying on debounce).
All were repaired. Fix Deadline now explicitly awaits Save Now semantics; the
central dirty subscription distinguishes acknowledgements by dirty-field-map
identity rather than global loading.

Per the requested one-full-run rule, only affected files were rerun:
- save-conflict-store: **4/4**
- config-conflict-store: **5/5**
- activity-migration: **2/2**
- kjx-features: **9/9**
- drawing-fields: **7/7**
- autosave-p1: **5/5**
- kjx-features browser: PASS
- kjx-membership browser: PASS
- autosave-p1 browser: PASS (all three screenshots regenerated and inspected)

The combined background command reached its 600-second tool limit after the
full E2E result and during final build startup (esbuild EPIPE). The interrupted
build alone was resumed in the foreground: **hub:build PASS**. There was no
second local full unit/E2E run. GitHub CI supplies the post-fix full unit/build
verification; its outcome is reported separately after publishing.
