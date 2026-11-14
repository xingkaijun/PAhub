# T7 acceptance and security fixes

Target: PR #7, `feat/p4-6-kjx-features`, baseline
`78177f888123dc74e60b300863579df35255abdd`.
Source evidence: T5 `docs/KJX_AUTH_ACCEPTANCE.md` on
`test/p5-kjx-acceptance` at `a613561` (45/48 passed; D1-D3 failed).
No production deployment or full T5 reacceptance is claimed here.

## D1 — viewer write controls remain visible

Root cause: Inventory controls were merely disabled; PCF's gate used the
nonexistent add-comment-btn and did not include Save. Toolbar display:flex
rules could override hidden and even a low-specificity important stylesheet.

Fix: use session capabilities to omit Inventory team/bulk/import/delete/command
and editing inputs; retain readable values. Hide unauthorized lobby creation.
PCF gates use actual IDs, write-only menu/actions and editing controls; denied
nodes get inline display:none!important and rendered content becomes read-only.
The adapter is kjx-only. Legacy controls and persistent templates are unchanged.
Tracker completion and APR controls use admin.only, not the drawing-update
isEditMode mirror. Read-only tracker names/progress remain visible.

Regression: unit checks gate coverage; Chromium verifies viewer Inventory and
PCF controls are absent/nonvisible, no editable content remains, and direct
writes still return 403. Existing legacy browser suites remain unchanged.

## D2 — manager assignment plus unchanged tracker is rejected

Authority: v1.1 R3.1 does not separately classify reviewTracker. Approved decision
item 5 assigns unclassified fields to admin. **Real tracker changes remain
admin.only**; they are not reclassified as drawing.update or team.setup.

Root cause: every assignee edit marked tracker dirty even when no tracker value
changed. PATCH included that unchanged slice, authorization checked its presence,
and failed batches left persistent dirty state that poisoned later saves.

Fix:
- kjx assignee edits do not dirty tracker. Actual drawing/config changes are
  filtered against edit baselines; existing dirty tracker slices are compared
  with server data before transmission.
- Under PATCH drawing locks and transaction, strip only recognized fields whose
  values deeply match stored drawing/config/tracker values, from both permission
  checks and the write body. Normalize the documented boolean/numeric tracker
  representation; unknown properties are never treated as no-ops.
- Unauthorized real tracker/config changes still atomically reject the batch.
- A kjx 403 save produces an explicit no-writes/reload notice and suppresses
  repeated automatic resubmission. Reload workspace confirms discard, clears
  dirty state, and reloads server data rather than silently losing edits.

Regression: HTTP tests accept identical tracker/config alongside manager
assignment and reject real tracker change/removal/unknown fields with zero
writes. Store tests cover non-dirty tracker and denied-save recovery. Chromium
changes an assignee and then saves a remark in the same manager context; both
persist and the first PATCH has no reviewTracker.

## D3 — clean new workspace never reaches the server

Classification: **pre-existing product defect**, not the acceptance proxy or
T2-T6 regression. `git show fec6429:store/projectSlice.ts` and App.tsx show the
same add-localOnly object plus hasDirty=false save skip and delayed name lookup.
Confirmed via code regression and kjx/legacy actual HTTP/browser paths.

Fix: localOnly projects must send their own initial config even with no dirty
flags. Saving a new inactive project does not borrow or clear the existing
workspace's dirty state. App identifies the new project by ID, awaits the save,
checks its result, loads/selects it, and does not log success for a skipped or
failed save. This genuine creation defect is fixed in both kjx and legacy,
as explicitly requested; other legacy behavior remains unchanged.

Regression: store and HTTP tests cover both modes and the fec6429 defect path.
Chromium opens an existing clean project, opens the hall in another tab of that
context, creates a workspace, observes the actual PATCH and checks SQLite and
refresh persistence in both modes.

## Additional PR #7 independent security review

1. CI shallow checkout could not resolve fec6429 used by actual reader tests.
   Set checkout fetch-depth: 0. Do not change or replace compatibility assertions.
2. GET PCF initiators previously returned full directory records to managers.
   Return only {id,name}; scope and authorization are unchanged. HTTP regression
   verifies exact object keys; admin team directory retains its richer contract.
3. kjx Daily Log CSV/Copy previously quoted but did not neutralize formulas.
   Flatten tabs/newlines to spaces and prefix a single quote when the first
   non-whitespace character is =, +, -, or @. Apply to Actor and all row text;
   CSV metadata text is sanitized/escaped too. Legacy branches retain their
   existing export bytes. Tests cover leading whitespace/control characters,
   formulas, quotes and embedded row/cell separators.

## Final foreground validation

- hub:build: PASS, frontend/server type checks and builds.
- hub:test: **318/318**, zero failures, zero skips (313 baseline + 4 acceptance
  regression tests + 1 spreadsheet-safe export test).
- hub:e2e: **15/15**, zero failures (14 baseline + two-mode T7 browser suite).
- Full selections, no skip-build flag, 600-second foreground limits.
- pre-T2 legacy tests, dependency lockfile and persistent PCF templates unchanged.
- git diff --check passed before commit. PR CI result is recorded in the PR body
  after publication; local passing tests alone are not claimed as CI success.
