# kjx reviewer view and scoped manager Config

Base: main `7a40c79103318ef0bec0eb0d3f118926b47b8a99`.

## Root causes and fixes

1. Inventory read-only branches returned bare strings/numbers instead of the
   editable cell presentation. Those values inherited default font sizing.
   Read-only spans now use matching per-column typography/backgrounds; status
   uses the same badge without a select, and assignees use the same avatar group
   without an interactive trigger. No write inputs/selects exist in reviewer rows.
2. Read-only assignees used join and exposed raw IDs. Editable avatars resolved
   only IDs from Team Setup roster, while drawing-only assignments could have no
   roster snapshot. Authorized project/detail and drawing subset responses now
   carry project-scoped assigneeNames from reviewer snapshots or kjx_users cache.
   No reviewer directory privilege, external fetch or project membership grant
   is introduced. Unknown UUIDs display Unknown reviewer, never their raw value.
3. Checkboxes compared IDs only; old assignment names did not match, while avatar
   resolution followed a separate path. One shared resolver uses exact ID first,
   then unique exact-name compatibility. Avatars deduplicate ID/name aliases,
   checkbox state uses the same resolution, and edits normalize known names to
   IDs. Duplicate/ambiguous names are not guessed as an identity. No bulk stored
   data migration and no name-based tracker authorization are added.
4. Unauthorized edits were retained after 403 with a reload notice. Store
   mutation functions now reject changes before dirty tracking when session
   capability is absent. On kjx save 403, reload authoritative project/tracker or
   fall back to a pre-edit in-memory snapshot (plus legacy persisted baselines),
   restore displayed values and clear pending sync flags, with an English no-
   permission notice. Snapshot copies are not persisted. Hosted PCF also disables
   other-user/reply editing for reviewers and clears rejected ops/local queue
   back to the acknowledged baseline; legacy template remains unchanged.
5. Config navigation and regular project settings both required admin-only
   settings.write. Add project.settings for manager/admin and authorize only the
   known regular project keys (holidays, cycles, report name, sync interval,
   summary/milestones); Team Setup keeps its own existing capability. Membership
   guard still rejects nonmember manager routes. Global settings, password writes,
   project deletion, /admin, Local Backup and Fix Deadline are not broadened.

## Validation

- Full foreground hub:test: **331/331**, no failures/skips.
- Full foreground hub:e2e: **17/17**, no failures.
- Full foreground hub:build: PASS, frontend/server types and bundles.
- git diff --check PASS. No dependency lockfile, immutable/persistent PCF
  template or pre-T2 legacy tests changed.
- Added mixed-ID/name resolver unit test, scoped manager Config HTTP test,
  drawing-only assignee snapshot API test and unauthorized-store/offline rollback
  test. Updated kjx-only obsolete assertions for the new accepted behavior.
- Browser checks reviewer absence of edit controls, matching computed font sizes
  against admin, avatar labels and no UUID text, mixed checkbox states, real
  manager Config persistence, admin-only action visibility, and simulated late
  403 restoration with no rejected value/dirty flags in localStorage.

## Screenshot artifacts

Under this worktree's hub-server/test/artifacts/ (generated, not committed):
- reviewer-inventory-readonly.png
- admin-inventory-comparison.png
- assignees-mixed-id-name-dropdown.png
- manager-project-config.png

All four were opened and inspected. They use the same fixture and viewport.
Reviewer toolbar legitimately omits write actions; row styling is aligned.

## Remaining boundaries

Unknown/missing UUID snapshots show a placeholder until identity/name data is
available. Ambiguous identical names are not converted automatically; use the
ID-backed selection to resolve them. Existing tracker self-marking still requires
an actual assigned kjx sub, not a guessed legacy name. A denied project save
rolls back unsaved project work rather than retaining rejected optimistic edits,
as requested; network/409 conflict behavior remains separate. No deployment,
main push, production database access, PR merge or SGP0 operation occurred.
