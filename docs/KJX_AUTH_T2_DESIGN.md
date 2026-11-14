# T2 identity and authorization design

Authority: approved decisions dated 2026-11-14, then v1.1, then v1.0;
baseline `fec6429`. T3 owns participant names/IDs; T4 owns directory/manual.

## Identity and compatibility boundary

`AUTH_MODE` defaults to `legacy`; invalid values fail startup. Copy the supplied
zero-dependency verifier unchanged (source HEAD `0fef219d3d08be37bc691b243fffcb11e9d6d7c6`).
In kjx mode verify X-Auth-Token on every request, including static pages; only
GET /api/health is public. Store verified identity on the request, cache users in
kjx_users (60-second write throttle), never trust display/user headers or legacy
admin credentials. Project passwords remain a separate gate, with admin bypass.
Unsafe methods require the configured public Origin (Referer fallback). No default
ACAO in kjx mode. Session returns identity, capabilities and central auth links;
legacy GET only appends fields. Legacy POST/DELETE stay intact. The owner approved
v1.1 R1.2's narrow exception: two GET-body assertions project the original fields;
all other legacy authorization and Cookie assertions remain unchanged.

## Capability table

| Capability | Minimum role / condition |
| --- | --- |
| view, pcf.presence | viewer |
| pcf.comment.create, pcf.comment.edit_own | reviewer; own requires matching initiatorId |
| pcf.comment.status, pcf.comment.meta | reviewer for own comment; manager for others |
| pcf.comment.edit_any, pcf.document.write, pcf.settings | manager |
| drawing.update, builder.export, builder.import_reply, bulk.import, bulk.command | manager |
| team.setup, settings.write, project.create, project.delete, drawing.void | admin |
| history.restore, cloud.sync, admin.console, admin.only | admin |
| pcf.replace | manager (approved decision 6 overrides v1.1 matrix) |

All inventory §1/B routes declare capability metadata, including multiplexed PCF
and admin subroutes and side-effecting GET download/page creation. Unknown routes
fail closed in kjx mode; a route-registry metatest checks explicit declarations.
POST project-detail is view; unlock is view; tracker PUT and heartbeat PUT retain
admin-only defaults. PCF page GET retains view and audits auto-creation; full
exports/downloads/imports and PUT document require manager. Admin prefix requires
admin.console; derived-token login and old session mutations return 410.

## Guards and atomicity

Router guards run after identity and Origin checks, before project/business logic.
The listener also gates non-API static requests. Existing admin/Bearer branches
remain untouched in legacy mode; kjx skips them in favor of verified capabilities.
PCF scoped grants bind user ID and reject mismatches even with a valid JWT;
PCF_GRANT_SECRET is optional, minimum 32 UTF-8 bytes, independent of exchange HMAC.

Project PATCH classifies every top-level/config/drawing/tracker entry; unknown
fields and implicit project creation require admin. Authorize the entire body
inside the existing locks/transaction, before the first write. Managers may update
existing drawing business fields; destructive/team/settings fields need admin.
The browser's unchanged projectName envelope is allowed; an attempted rename
requires settings.write. Unmapped discipline text restricts PCF writes to manager+.
`authorizeOps` checks all 13 op kinds against the latest document within serial,
before applying anything. Unknown ops fail closed. Missing initiatorId is not own.
Comment-wide status/meta requires ownership of every affected round. Reply edits,
record deletion/restoration and participant reassignment require edit_any.

## Audit and verification

One writeAudit function owns audit_log INSERTs. Add nullable actor_id/actor_name,
source and op-types metadata idempotently without changing legacy audit fields.
Request-scoped actor context covers asynchronous handlers; offline/background
writes have no actor and an explicit source. One audit row per op batch retains
existing COMMENTS semantics and includes the op-kind list. A source grep test
forbids direct audit INSERTs elsewhere.

Keep old tests unchanged except the explicitly approved R1.2 GET-body projections.
Add JWT failure/role matrices, all registered route
coverage (including side-effecting GET), 13-op own/other/anonymous matrix, atomic
PATCH/op rejection, Origin, admin console, CORS, project-password isolation,
user-bound grants, audit and legacy-header-ignore tests. Run hub:build, hub:test
and hub:e2e before the draft PR; record exact totals and any deviations.

Latest foreground validation after PR #5 security review fixes: hub:build passed;
hub:test 291/291 (274 baseline + 17 new tests); hub:e2e 13/13 (12 baseline scripts +
one two-mode Builder handoff regression). No dependency/lockfile changes or deployment.

H1: stored uploaded Builder HTML is a sandboxed octet-stream attachment in both
legacy and kjx. Confirmed handoff uses fetch/blob/File, not direct online rendering;
Chromium verifies navigation downloads without executing uploaded scripts and the
controlled PCF handoff still previews/applies replies in both modes.
L2: independent literal T1 §1/B method/path cases cover APIs, comments.xlsx,
Builder/admin subroutes, PCF pages/images, manual/static and OPTIONS; policy ↔ case
coverage is checked both ways. Static/preflight view policies are explicit.
T3 still owns participant-ID writes and Daily Log actor UI; T4 owns directory/manual.
