# kjx project membership

Base: main `33b0d555330ac56fff39388dfd02893c3d08b37b`.
Authority: Kevin-approved project membership rules supplied for this task.
These supersede the prior kjx project-password gate and admin-only Team Setup /
project creation rules. All access changes are AUTH_MODE=kjx only.

## Team Setup storage inventory and membership calculation

| Storage | Existing use | Membership |
| --- | --- | --- |
| reviewers(id,display_name) | Global name/ID snapshot roster, returned for every project before this change; Settings roster and directory selection upsert it | Not independently sufficient: there is no project_id |
| discipline_defaults(project_id,discipline,reviewer_id) | Default Leads, set by Settings | Yes, exact verified user sub match |
| discipline_default_assignees(project_id,discipline,reviewer_id) | Team Setup default discipline assignees | Yes, exact verified user sub match |
| project_team_reviewers(project_id,reviewer_id), new | Project-scoped Team Setup roster and creator membership | Yes, exact verified user sub match |
| drawing_assignees(drawing_id,reviewer_id) | Individual drawing assignments (older UI may store names) | No: not a Team Setup relationship |
| review_tracker | Completion/approval marks | No |
| kjx_users | Identity/name cache | No: being cached does not grant membership |
| PCF initiatorId/responderId | Per-round attribution | No: ownership is distinct from project access |

Membership is the live UNION of the three project-scoped Team Setup relations.
A request must have a verified user identity; empty/manual- IDs never qualify.
There is no name matching or auto-grant from global reviewers. An actual kjx
sub stored in an existing Default Lead/default-assignee row works immediately,
including users not yet cached locally. Manual names do not acquire a kjx ID.

The new association table is created idempotently only at kjx startup, with a
project foreign key and composite primary key. No destructive migration,
backfill, demo clearing, password deletion, or global roster-to-project guessing.
Old global-only roster membership cannot be reconstructed safely: admin must
save those users into the desired project's Team Setup. Existing scoped lead /
default-assignee links need no migration. Legacy keeps its global roster behavior.

kjx config reads and PATCH acknowledgements return only the project's scoped
roster/name snapshots. Team Setup now supports roster-only add and explicit
Remove member (removes that person from roster, leads and defaults). Settings
lead options store the ID in kjx, retaining the prior name behavior in legacy.
A creator (admin or manager) is inserted into the initial project roster in the
same PATCH transaction, even with an empty submitted roster; later Team Setup
removal is respected. Membership changes use writeAudit with TEAM_SETUP action.

## Authorization and scope

- Admin bypasses membership and sees all projects.
- All non-admin roles, including viewer, require membership; viewer was not
  separately specified, so fail-closed rather than global read access.
- Manager retains PCF/drawing privileges and gains project Team Setup and
  project.create as requested, but cannot manage someone else's project.
- Other existing capabilities (settings.write, admin console, real tracker
  changes, drawing void/history restore) remain unchanged. No broad manager
  admin-console/global-settings grant.
- Only exact PATCH /api/projects/:newId permits nonmember manager creation;
  existing project PATCH cannot self-enroll a nonmember.
- Team directory remains globally usable by admin; managers must provide
  projectId and belong to that project. Reviewer/viewer still lack team.setup.
- Global GET settings no longer copies the first project's config/roster into
  kjx responses, preventing a project-specific configuration side channel.

## Project route inventory

The central router guard handles all methods, including OPTIONS and unregistered
subpaths, before handlers read data. Paths resolve project ID from the existing
projectFromPath matcher; team directory uses its explicit projectId query.

| Route family | Methods / contents covered |
| --- | --- |
| /api/projects | GET filters list; no unauthorized names returned |
| /api/projects/:p | POST detail, PATCH drawing/config/roster, implicit creation exception |
| /api/projects/:p/unlock | POST membership checked; kjx returns unlocked without cookie/password |
| /api/projects/:p/drawings | GET selected drawing IDs and tracker |
| /api/projects/:p/drawings/:d/status | POST drawing status |
| /api/projects/:p/review-tracker | GET, PUT |
| /api/projects/:p/comments[.xlsx] | GET register/Excel, including conditional/compressed responses |
| /api/projects/:p/audit | GET Daily Log/activity |
| /api/projects/:p/heartbeat | GET, PUT |
| /api/projects/:p/events | GET project SSE |
| /api/projects/:p/builder-replies/... | GET pending/file, POST preview/apply/skip |
| /api/pcf/:p/index, /presence | GET project PCF index/presence |
| /api/pcf/:p/exports/batch | POST Send All batch |
| /pcf/:p/:d | GET/HEAD hosted page and automatic document creation |
| /pcf/:p/:d/images/:hash | GET/HEAD image bytes |
| /api/pcf/:p/:d/... | POST session/create/presence/ops/exports/imports; PUT document; GET data/meta/presence/events/exports/history/download/initiators; export download/void and history restore |
| /api/team/directory?projectId=:p | GET scoped directory |

Admin console paths remain admin.console only. Static frontend/manual/session /
health have no project data and retain their existing contracts. No browser
service-token access is introduced.

Membership is rechecked after asynchronous body reads, under PATCH/PCF drawing
locks, after directory lookup, and inside queued bulk-import apply. PCF also
checks membership directly, not merely through its router wrapper. Open drawing
and project SSE check on every event and close on Team Setup removal; periodic
checks also cover external SQL changes. Already delivered bytes cannot be revoked.
Nonmember responses are generic 403 project.member, without project names.

## Password and frontend behavior

Kjx uses membership instead of project passwords. Stored password hashes and
versions remain untouched; legacy password cookies/challenges/UI remain intact.
Kjx list/detail/acknowledgements report no password gate; lobby lock indicators,
password editor and prompts are hidden. Health labels reflect team protection.

List refresh replaces the kjx selectable project set, rather than retaining stale
cached projects. Startup does not show kjx cached cards before authorization.
A removed local project is retained in membershipRecovery as a non-selectable,
non-submittable local recovery snapshot rather than silently deleting work.
Forbidden requests show clear membership guidance and return to the hall; SSE
errors refresh the list. Local downloaded copies and previously delivered data
are not remotely erased.

## Verification and changes to tests

Final foreground commands, full selections, 600-second timeout:
- hub:build PASS (frontend/server types and builds).
- hub:test **325/325**, zero failures/skips (319 baseline + six membership tests).
- hub:e2e **16/16**, zero failures (15 baseline + membership browser suite).
- git diff --check PASS; no dependency/lockfile/persistent-template changes.

Membership tests cover list grant/revoke for reviewer and manager, admin bypass,
manual/global/drawing-assignment nonmembership, existing lead links, manager
creation/roster operations, all project route families, stored password bypass,
legacy visibility, stale frontend list recovery, and both project/drawing SSE
closure. Browser checks both roles, Team Setup grant/revoke and no password UI.

Only kjx-era test fixtures/policy expectations were updated to seed real project
membership and reflect the newly approved Team Setup/project-create/password
rules. No pre-T2 legacy tests were modified. The first complete E2E run failed
one kjx fixture lacking reviewer name snapshots; corrected that fixture to the
actual Team Setup shape and reran all suites successfully.

## Findings / deviations

1. Global roster had no recoverable project ownership: no unsafe backfill.
2. Drawing assignments do not grant membership; only project Team Setup links do.
3. Viewer uses membership too (fail-closed unspecified case).
4. Global directory without projectId remains admin-only; manager must scope it.
5. Existing cached/downloaded local data cannot be un-delivered. Recovery copies
   preserve prior work but do not grant online access.
6. Manager gets team.setup/project.create, not unrelated admin-only powers.
No deployment, main push, PR merge, real secrets, or SGP0 access is included.
