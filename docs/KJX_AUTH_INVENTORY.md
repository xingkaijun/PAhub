# kjx-auth integration inventory (T1)

Scope: PAhub `fec64291badad13f0d4b9cde9db2cd53909f5e65`; source-only inventory, no production connection. v1.1 supersedes v1.0. Instruction references below use `kjx-docs/PAhub接入kjx-auth实施指令-v1.0.md` and `kjx-docs/PAhub接入kjx-auth实施指令-v1.1修订.md`, outside this repository. Production figures are quoted from v1.1:35–40, not independently checked. No kjx-mode implementation exists in this baseline.

## 1. Write routes and capability mapping; B. Complete route table

Conventions: `p`, `d`, `s`, `f`, `id`, `t` stand for one path segment. Table paths are anchored regular-expression patterns, with `/` shown literally and `[^/]+` abbreviated as `S`; `?` means optional, `|` alternation. Exact registration/source is cited per row. `T` = API_TOKEN Bearer only when configured, `P` = project password session if protected, admin bypasses; `A` = admin session or configured API_TOKEN (or everyone if ADMIN_PASSWORD absent); `C` = per-drawing scoped credential. `D` = admin-console password-derived token. `none` is not identity authentication. T, P, A are conditional, not equivalent to a logged-in user. Shared router logic `hub-server/src/router.ts:43–64`, project scope `hub-server/src/project-session.ts:8–19`, admin fallback `hub-server/src/admin-session.ts:30–37,63–68`. Listener can independently impose PAHUB_BASIC_AUTH on all paths `hub-server/src/listener.ts:9–17`; CORS preflight OPTIONS `/api*` returns 204 before route checks (`router.ts:47`). Suggested capabilities are future kjx-mode proposals, not current enforcement; all project-scoped routes additionally retain project unlock under v1.1 R2.2.

| Method | Anchored regex / subpath | auth / admin annotation; actual legacy access | Proposed capability | Handler source |
|---|---|---|---|---|
| GET, POST, DELETE | `^/api/session$` | `none`; GET none, POST password, DELETE none | session bootstrap / login / logout; kjx POST/DELETE 410 | `hub-server/src/admin-session.ts:83–122` |
| GET | `^/api/?$` | default; T | view | `hub-server/src/system-routes.ts:9` |
| GET | `^/api/settings$` | default; T | view | `hub-server/src/system-routes.ts:10` |
| GET | `^/api/health$` | default; T | health exemption | `hub-server/src/system-routes.ts:13–15` |
| GET | `^/api/projects$` | default; T | view | `hub-server/src/project-routes.ts:10` |
| POST | `^/api/projects/S/unlock$` | default; T + project password, admin bypass | project unlock, not `project.create` | `hub-server/src/project-routes.ts:9`, `hub-server/src/project-session.ts:25–46` |
| POST | `^/api/projects/S$` | default; T + P; read despite POST | view | `hub-server/src/project-routes.ts:15–23` |
| PATCH | `^/api/projects/S$` | default; T + P + A | body-dependent: `drawing.update`, `team.setup`, `settings.write`, `project.create`, `drawing.void`, `bulk.import`, `bulk.command`; split/authorize every item, default admin when ambiguous | `hub-server/src/project-routes.ts:15–26`, `hub-server/src/project-write.ts:155–183` |
| GET | `^/api/projects/S/drawings$` | default; T + P | view | `hub-server/src/project-routes.ts:28–36` |
| POST | `^/api/projects/S/drawings/S/status$` | default, `admin:true`; T + P + A | drawing.update | `hub-server/src/pcf-routes.ts:17–21` |
| GET | `^/api/projects/S/comments(\\.xlsx)?$` | default; T + P | view | `hub-server/src/pcf-routes.ts:22–44` |
| GET | `^/api/projects/S/events$` | default; T + P, P rechecked during stream | view | `hub-server/src/pcf-routes.ts:45` |
| GET, PUT | `^/api/projects/S/review-tracker$` | default; T + P; PUT additionally A | GET view; PUT default admin, owner decision | `hub-server/src/tracker-routes.ts:10–18` |
| GET | `^/api/projects/S/audit$` | default; T + P | view | `hub-server/src/activity-routes.ts:7–16` |
| GET, PUT | `^/api/projects/S/heartbeat$` | default; T + P; PUT additionally A | GET view; PUT default admin, owner decision | `hub-server/src/activity-routes.ts:18–24` |
| GET | `^/api/projects/S/builder-replies/pending$` | `none`; P + A + T | builder.import_reply | `hub-server/src/pcf-routes.ts:46–64` |
| POST | `^/api/projects/S/builder-replies/preview$` | `none`; P + A + T; preview persists evidence | builder.import_reply | `hub-server/src/pcf-routes.ts:46–64`, `hub-server/src/pcf-builder-replies.ts:94–116` |
| POST | `^/api/projects/S/builder-replies/S/(apply|skip)$` | `none`; P + A + T | builder.import_reply | `hub-server/src/pcf-routes.ts:46–64`, `hub-server/src/pcf-builder-replies.ts:150–184` |
| GET | `^/api/projects/S/builder-replies/S/file/S$` | `none`; P + A + (T or C); if API_TOKEN absent T is satisfied | builder.import_reply | `hub-server/src/pcf-routes.ts:46–55` |
| any other | `^/api/projects/S/builder-replies(?:/S)?(?:/S)?(?:/S)?$` | `none`; P + A + T; unsupported returns 404 | deny | `hub-server/src/pcf-routes.ts:46–64` |

PCF registration for all following rows is `auth:'none'`, no router `admin:true`: `hub-server/src/pcf-routes.ts:66`. P applies in router and again inside PCF (`hub-server/src/pcf-api.ts:49–52`). Define `G` as T or C; when API_TOKEN absent T is automatically satisfied (`hub-server/src/pcf-api.ts:30`). All PCF subpaths are under `^/api/pcf/S/S/...$` except explicitly noted. Unknown combinations return 404; safeId restricts actual project/drawing IDs (`hub-server/src/pcf-model.ts:11–14`, `hub-server/src/pcf-api.ts:46–53,196–199`).

| Method | Anchored regex / tail | Actual legacy access; suggested future capability | Source |
|---|---|---|---|
| GET | `^/api/pcf/S/(index|presence)$` | P + T; view; index may repair persisted index on load | `hub-server/src/pcf-api.ts:53–55`, `hub-server/src/pcf-storage.ts:43–47,54–62` |
| POST | `^/api/pcf/S/exports/batch$` | P + T + A; builder.export | `hub-server/src/pcf-api.ts:56–70` |
| GET, HEAD | `^/pcf/S/S$` | P + (T or PCF cookie); view, but creates document if missing; decide whether to make GET side-effect free | `hub-server/src/pcf-api.ts:73–103` |
| GET, HEAD | `^/pcf/S/S/images/[a-f0-9]{64}$` | P + (T or PCF cookie or C); view | `hub-server/src/pcf-api.ts:74–85` |
| POST | `session` | P + T; grant issuance, view plus appropriate operation checks; not a user identity | `hub-server/src/pcf-api.ts:104–108` |
| GET | `events` | P + G or scoped query credential; view, stream may expire | `hub-server/src/pcf-api.ts:109–110,119–126` |
| GET | `meta`, `data`, `presence`, `exports`, `history` | P + G; view | `hub-server/src/pcf-api.ts:137–140,160,173` |
| POST | `create` | P + G; default admin, decide whether creation must be separated from view | `hub-server/src/pcf-api.ts:138` |
| POST | `presence` | P + G; view/presence (ephemeral write), decide | `hub-server/src/pcf-api.ts:141–146` |
| POST | `ops` | P + G; each op separately authorized atomically, see A | `hub-server/src/pcf-api.ts:147–151` |
| PUT | `document` | P + G + A; pcf.replace | `hub-server/src/pcf-api.ts:114,152–159` |
| POST | `exports` | P + G; builder.export for builder mode; complete mode default admin pending decision | `hub-server/src/pcf-api.ts:161–164` |
| POST | `imports` | P + G + A; builder.import_reply for builder replies; complete replacement/merge requires owner decision, default admin | `hub-server/src/pcf-api.ts:115,165–172` |
| GET | `download` | P + G; **writes** a complete export record; default admin pending decision, not automatically view | `hub-server/src/pcf-api.ts:174–184`, `hub-server/src/pcf-exchange.ts:101–112` |
| GET | `exports/[a-f0-9-]+/download` (case insensitive) | P + G; view existing export, decide whether export access needs stronger capability | `hub-server/src/pcf-api.ts:185–195` |
| POST | `exports/[a-f0-9-]+/void` (case insensitive) | P + G + A; drawing.void (export void, name needs confirmation) | `hub-server/src/pcf-api.ts:118,185–186` |
| POST | `history/[0-9]+/restore` | P + G + A; history.restore | `hub-server/src/pcf-api.ts:118,196–197` |

### `/api/admin*` subroutes

One prefix route `^/api/admin(?:/|$)` is `auth:'none'`, no router admin flag (`hub-server/src/app.ts:36–37`). When ADMIN_PASSWORD is absent the console is disabled. With it set, page and login precede D; all other subpaths require D, not A nor T (`hub-server/src/admin-api.ts:80–92`). D is deterministic and exposes an encoded password prefix: legacy security risk; never reproduce its value. v1.1 R2.1 proposes `admin.console` for all except retired auth.

| Method | Anchored regex | Current auth; suggested | Source |
|---|---|---|---|
| GET | `^/api/admin$` | none if configured; admin.console | `hub-server/src/admin-api.ts:82–83` |
| POST | `^/api/admin/auth$` | password; kjx 410 | `hub-server/src/admin-api.ts:84–90` |
| GET | `^/api/admin/api/tables$` | D; admin.console | `hub-server/src/admin-api.ts:91–97` |
| GET | `^/api/admin/api/tables/S/schema$` | D; admin.console | `hub-server/src/admin-api.ts:98–102` |
| GET, POST | `^/api/admin/api/tables/S$` | D; admin.console; POST INSERT | `hub-server/src/admin-api.ts:103–134` |
| PUT, DELETE | `^/api/admin/api/tables/S/S$` | D; admin.console; UPDATE/DELETE | `hub-server/src/admin-api.ts:136–153` |
| POST | `^/api/admin/api/sql$` | D; admin.console; sanitized read-only snapshot despite POST | `hub-server/src/admin-api.ts:41–79,156–159` |
| GET | `^/api/admin/api/export$` | D; admin.console | `hub-server/src/admin-api.ts:160–163` |
| POST | `^/api/admin/api/import$` | D; admin.console | `hub-server/src/admin-api.ts:164–168` |
| other | `^/api/admin(?:/|$)` | D after exceptions; 404 | `hub-server/src/admin-api.ts:169–170` |

Non-API static assets and SPA paths, including manual, go through listener static handling, not the Router; optionally Basic-auth protected (`hub-server/src/listener.ts:14–29`). No separate `/health` handler was found; `/api/health` queries projects with a SELECT, not literally `SELECT 1` alone (`hub-server/src/system-routes.ts:13–15`). `system-routes.ts:9` lists relative API endpoints, not a separate root route.

A project PATCH can implicitly create a project (`hub-server/src/project-write.ts:167–168`); the UI's `deleteProject` only removes its local state (`store/projectSlice.ts:160–166`), so a remote project-delete route is 待确认, not inferred. Bulk drawing import/commands are client-side changes subsequently sent through PATCH (`store/projectSlice.ts:312–344,411`).

### A. Thirteen PCF op types

All enter the same `POST ops` branch `hub-server/src/pcf-api.ts:147–151`; inside serialization (`pcf-api.ts:135–136`) `opsBatch` loads the current document and calls `applyOps` (`hub-server/src/pcf-storage.ts:123–139`). Per-type implementation and proposed v1.1 R3.2 capability:

| Op | Model implementation | Suggested capability |
|---|---|---|
| comment.add | `hub-server/src/pcf-model.ts:140–147` | pcf.comment.create |
| round.add | `hub-server/src/pcf-model.ts:148–157` | pcf.comment.create |
| content.set | `hub-server/src/pcf-model.ts:192–193` | owner: edit_own if initiatorId matches else edit_any; reply: edit_any |
| comment.status | `hub-server/src/pcf-model.ts:194–195` | pcf.comment.status |
| comment.meta | `hub-server/src/pcf-model.ts:196–200` | pcf.comment.meta; reviewer only own comment, ownership definition needs decision |
| round.meta | `hub-server/src/pcf-model.ts:201–202` | initiator: manager/admin designation; responder: edit_any; minHeight: owner rule |
| project.set | `hub-server/src/pcf-model.ts:203–212` | pcf.document.write |
| settings.set | `hub-server/src/pcf-model.ts:218–222` | pcf.settings |
| roundRegister.set | `hub-server/src/pcf-model.ts:213–217` | pcf.document.write |
| record.delete | `hub-server/src/pcf-model.ts:223–239` | pcf.comment.edit_any |
| record.restore | `hub-server/src/pcf-model.ts:240–246` | pcf.comment.edit_any |
| rounds.addAll | `hub-server/src/pcf-model.ts:158–174` | pcf.document.write |
| history.set | `hub-server/src/pcf-model.ts:175–191` | pcf.document.write |

R3.2 divergences needing specification rather than guessing: (1) `comment.add` does not accept an initial initiator: it creates empty fields; `round.add` copies previous names, not client-supplied initial IDs (`pcf-model.ts:140–155`). `rounds.addAll` also copies them (`pcf-model.ts:158–170`), so P4-4 must specify server identity for this creation path. (2) No `initiatorId` exists in the current model; own/other and comment-level ownership are not currently determinable (`pcf-model.ts:145–155,196–202`). (3) `settings.set` includes participantDefaults, not solely display settings (`pcf-model.ts:114–116,218–222`). (4) `record.delete` cascades to register/history and clears deleted records, not just a single round; restore handles legacy deleted records (`pcf-model.ts:223–246`). (5) `comment.status` and other ops can reconcile approval (`pcf-model.ts:250–252`); `roundRegister.set` may append circulation (`pcf-model.ts:213–216`). (6) current `applyOps` can accept some operations and report conflicts on others (`pcf-model.ts:125–139,248–254`); v1.1 atomic denial is a new authorization rule, distinct from existing conflict semantics. Also generated import/status operations bypass the HTTP ops entry (`hub-server/src/pcf-exchange.ts:396–404`, `hub-server/src/pcf-storage.ts:114–118`), so specify trusted internal actor and coverage.

## 2. audit_log and operation persistence

| Source | Action / scope |
|---|---|
| `hub-server/src/admin-api.ts:30–31,128–168` | INSERT, UPDATE, DELETE, IMPORT; arbitrary allowed tables, no actor; FULL_DB import. |
| `hub-server/src/drawing-status.ts:27` | STATUS transition. |
| `hub-server/src/drawing-write.ts:147–149` | COMMENTS when manually maintained counts change without PCF. |
| `hub-server/src/importer.ts:59` | FULL_DB IMPORT for offline importer. |
| `hub-server/src/pcf-builder-replies.ts:29–43,50–55` | BUILDER_REPLY per applied import; bulk and PCF paths. |
| `hub-server/src/pcf-storage.ts:81–90` | COMMENTS per inserted PCF change, not one audit row per op. |

PCF ops: `pcf-api.ts:147–149` → `pcf-storage.ts:123–139` → `pcf-model.ts:106–254`; applied op summaries grouped into `hub.lastChange.ops` and one `pcf_changes.ops_json` row per revision (`pcf-storage.ts:89–107,137–139`). `audit_log` has one COMMENTS row per revision, not per op (`pcf-storage.ts:89–90`); v1.0 C3's each-op actor requirement needs explicit interpretation. Separate project delta/remark bulk operations commit in `hub-server/src/project-write.ts:155–183` and `hub-server/src/drawing-write.ts:39–43,120–145`; not every operation currently has an audit row. Background and offline import actor must remain null until explicitly modeled (v1.1:137–138).

## 3. Existing credentials, C. People tables, E. session, F. PCF secret

Admin password/session: `hub-server/src/config.ts:39–41`, `hub-server/src/app.ts:26–28`, `hub-server/src/admin-session.ts:30–68`; password absent means all requests admin, and configured API_TOKEN qualifies as admin. Project password hash migration and verification `hub-server/src/project-password.ts:1`, `hub-server/src/app.ts:24–27`; project path/session and 12-hour unlock `hub-server/src/project-session.ts:7–46`. Project-password UI state `App.tsx:89,119`, `components/Settings.tsx:53`, `store/projectSlice.ts:611–621`, `hub-server/src/project-read.ts:15`. Admin UI `components/AdminLoginDialog.tsx:7–10`, `App.tsx:545,674`, `components/DrawingList.tsx:525,764`, `components/ReviewTracker.tsx:507,646`; store `store/uiSlice.ts:8–41`.

E: `/api/session` GET returns `{admin,requiresPassword}` based on cookie/API_TOKEN; POST checks password, throttles failures, sets 12-hour cookie, returns admin/expiry; DELETE clears browser cookie, not server-side revocation of a copied cookie (`hub-server/src/admin-session.ts:63–68,83–122`, `hub-server/test/permissions.test.ts:64–68`). All three are called through `services/api/sessionApi.ts:5–11` and `store/uiSlice.ts:12–30`. Legacy permissions should be an indicative UI capability list, **not** an authorization substitute: admin gets all; non-admin gets `view`, `pcf.comment.create`, `pcf.comment.edit_own`, `pcf.comment.edit_any`, `pcf.comment.status`, `pcf.comment.meta`, `pcf.document.write`, `pcf.settings`, plus builder export and create/presence as applicable, because legacy ops and exports have no per-op admin check (`hub-server/src/pcf-api.ts:109–118,137–164`). Project lock and optional token still gate each request; no own identity exists. `builder.import_reply`, replacement and restore remain admin-only. The session is global, so it cannot accurately represent per-project unlock; owner must decide representation and avoid treating list as a security boundary.

F: `hub-server/src/app.ts:26–28` passes API_TOKEN to `PcfApi`; constructor picks token or `randomBytes(32)` at `hub-server/src/pcf-api.ts:17`. It signs 12-hour per-drawing grants (`pcf-api.ts:19–29`), cookie name (`pcf-api.ts:31–35`), and SSE query credential is this same grant (`pcf-api.ts:109–125`); `pcf-realtime.ts:93–100` only enforces expiry and project access, it does not create a separate HMAC. Production unset is reported by v1.1:24–30, not locally verified. Owner HMAC for offline exchange is a **separate persistent key** (`hub-server/src/pcf-exchange.ts:58–62,85–90`); do not conflate with PCF_GRANT_SECRET.

C: `reviewers` reads `hub-server/src/project-read.ts:19–22,63–65`, upsert `hub-server/src/project-write.ts:49–50`; `drawing_assignees` reads `hub-server/src/drawing-revision.ts:34`, `project-read.ts:32`, writes `drawing-write.ts:120–121`, deletion `project-write.ts:125`; `discipline_defaults` reads `project-read.ts:19,63`, writes `project-write.ts:38–40`; `discipline_default_assignees` reads `project-read.ts:21`, writes `project-write.ts:44–46`. Admin table CRUD can also read/write each (`hub-server/src/admin-api.ts:23,103–153`). Team Setup button/modal `components/DrawingList.tsx:479,506,801`; UI initializes default assignees at `components/DrawingList.tsx:198`. R4 cache and manual reviewer ID migration are proposed, not present (v1.1:113–138).

## 4. API_TOKEN machine callers

Code supports optional global gate (`hub-server/src/router.ts:54`), PCF gates and scoped grants (`hub-server/src/pcf-api.ts:17–35,104–110`), and admin bypass (`hub-server/src/admin-session.ts:63–68`). Browser build configuration can send a Bearer header (`services/api/apiClient.ts:33–45,83–85`), and opens PCF session only when configured (`services/api/pcfApi.ts:10–15`). No external deployment caller, path or frequency can be established by a repository-only search: 待确认; v1.1:24–30 reports API_TOKEN unset and no external callers in production, so the former v1.0 question 4 is retired, not independently verified. `PAHUB_BASIC_AUTH` is a separate optional global listener guard (`hub-server/src/listener.ts:14–15`).

## 5. Frontend request paths and non-API paths

The API client defaults to `/api` and may be configured with a different base (`services/api/apiClient.ts:33–45,83–85`). Its project requests include settings, projects, unlock, project POST read/PATCH write, drawings, tracker, audit, heartbeat, health and project events (`services/api/projectsApi.ts:50–81`); session GET/POST/DELETE (`services/api/sessionApi.ts:5–11`); project comments/XLSX and event stream (`services/api/commentsApi.ts:19–28,36–40,66–68`); PCF index/presence/session/batch (`services/api/pcfApi.ts:7–16`); reply pending/preview/apply/skip (`services/api/builderRepliesApi.ts:12–21`). PCF template uses data, presence, ops, exports/download, document and SSE (`pcf/template/PG-PCF-hub.html:1126,1184–1197,1282,1400–1407,1513`); builder handoff fetches stored reply (`hub-server/src/pcf-api.ts:97–99`). Admin console calls its own subroutes (`hub-server/src/admin.html:327,341`; detailed routes in §1). Non-API: PCF page links `components/DrawingRow.tsx:200`, `components/ReviewTracker.tsx:354`; image fetches `/pcf/.../images/...` (`pcf/template/PG-PCF-hub.html:1489,1656–1657`). `/pcf` pages/images get nginx page redirect on expired identity; broken images accepted by v1.1:144. SSE is under `/api/` (`pcf/template/PG-PCF-hub.html:1406–1412`, `services/api/commentsApi.ts:66–68`, `App.tsx:342`). Static manual is outside API (`hub-server/src/listener.ts:23–29`).

## 6. PCF round semantics and rollback

`owner` is review comment and `reply` builder reply; reports use `initiator` as owner name (`hub-server/src/comments-register.ts:165–175`). Both names are mutable text via `round.meta`, and contents via `content.set` (`hub-server/src/pcf-model.ts:192–202`); builder import creates `reply` ops (`hub-server/src/pcf-exchange.ts:222–230,388–404`). `responder` is text alongside reply but whether it always means shipyard person, including manually entered data, is 待确认; current code does not enforce identity (`pcf-model.ts:201–202`). Export projects only selected round fields (`pcf-exchange.ts:27`), so new IDs may be silently lost on exchange unless explicitly added.

Template version 6 (`hub-server/src/pcf-template.ts:9–16`), schema version 1.0 (`hub-server/src/pcf-schema.ts:5–6`); upgrader scans only project-root HTML, supports dry run/project/drawing and creates backups before writing (`hub-server/scripts/upgrade-pcf.ts:7–24`, `hub-server/src/pcf-template.ts:14–32`). It calls legacy cleanup, so dry-run reports removals rather than promising semantic no-op (`pcf-template.ts:17–28`). Old validator requires schema 1.0 and does not explicitly reject extra round identity fields (`hub-server/src/pcf-v26.ts:69–70,105–112`); old `upgradeFile` treats higher template versions as current (`pcf-template.ts:12–16`). Full rollback round-trip preservation is **待确认**, especially `pcf-exchange.ts:27` field picking and future schema/version changes; do not conclude restore unnecessary before P4-4 tests.

## 7. Discipline mapping (D)

Source of production snapshot: v1.1:35–40, cited as reported evidence, no database connection. kjx list `kjx-docs/kjx-auth-src/server/src/disciplines.ts:5`. Mapping requires owner approval.

| Project | PAhub text | Count | Proposed kjx | Note |
|---|---|---:|---|---|
| TEST-100-Demo-Vessel | Accommodation | 20 | 待确认 | no exact match; OUTFIT candidate only |
| TEST-100-Demo-Vessel | Electrical | 20 | ELEC | proposed |
| TEST-100-Demo-Vessel | Hull | 18 | HULL | proposed |
| TEST-100-Demo-Vessel | Machinery | 20 | MACH | proposed |
| TEST-100-Demo-Vessel | Outfitting | 22 | OUTFIT | proposed |

Reported snapshot also has three demonstration reviewers and 180 drawing_assignees, no real business data (v1.1:39). PAINT/HSE/SEC/DOC/CHS/CCS/PIPE have no reported PAhub counterpart, meaning not observed rather than impossible; codes and meaning beyond source are 待确认 (`kjx-docs/kjx-auth-src/server/src/disciplines.ts:5`).

## 8. Test baseline

Baseline is legacy only; kjx mode does not yet exist. Build/test scripts: `package.json:9–13`.

| Command | Result |
|---|---|
| `npm ci --registry=https://registry.npmjs.org/` | passed, exit 0 |
| `npm run hub:build` | passed, exit 0 (build has no test count) |
| `npm run hub:test` | 274/274 passed, 0 failed, 0 skipped; `native normalized reads preserve the legacy view contract` passed (`hub-server/test/project-migration.test.ts:13–17`), despite v1.0:19 noting a historical failure |
| `npm run hub:e2e` | 12/12 browser smoke scripts passed, 0 failed (`hub-server/scripts/e2e.mjs:9–22,40–49`) |

## 9. Dependency security

`npm audit --omit=dev` initially failed because configured mirror returned HTTP 405. One retry with official registry completed the audit and exited 1: **4 vulnerable packages: 1 moderate, 2 high, 1 critical** (axios, follow-redirects, form-data, jspdf); advisory applicability to this application's execution paths is 待确认. Fixing is outside T1; no audit fix was run. Dependencies and scripts `package.json:18–39`; counts are command output at inventory time, not a static code claim.

## 10. Owner decisions and specification corrections

1. Approve §7 mapping, particularly Accommodation and unknown strings (v1.1:35–40).
2. Approve §1 body-sensitive PATCH classification, tracker PUT, heartbeat PUT, PCF create/presence, complete export/import and GET download/page side effects; a single route-level capability cannot protect heterogeneous PATCH (`hub-server/src/project-write.ts:155–183`; `hub-server/src/pcf-api.ts:91–95,174–175`).
3. Confirm R3.1 defaults for reviewer status/meta and manager settings; define own comment in multi-round comments and handling absent identity (`hub-server/src/pcf-model.ts:145–155,196–202`; v1.1:72–85).
4. Specify ID population for all new-round paths including rounds.addAll and preserve IDs in offline exports (`hub-server/src/pcf-model.ts:140–170`; `hub-server/src/pcf-exchange.ts:27`).
5. Confirm directory roles admin/manager/reviewer, reviewer migration vs clearing demo data, and project password second gate (v1.1:56–61,130–135).
6. Confirm separate PCF_GRANT_SECRET and fallback, legacy list representation, and how admin-console legacy risk is handled until P5-3 (v1.1:24–30,46–54).
7. Confirm Tailnet default and non-API redirect/image behavior (v1.1:144–145,171–183); Origin check is a deliberate supplement to PLAN (v1.0:262–264).
8. Clarify whether audit needs one row per op or one actor-bearing batch row; include offline/background and internal-generated ops (`hub-server/src/pcf-storage.ts:89–90,114–118,137–139`).
9. v1.1 health description says SELECT 1, but implementation selects from projects with LIMIT (`hub-server/src/system-routes.ts:13–15`); fix wording. R3.2's initiator initialization, display-only settings, deletion cascade and export field omissions need correction as in §1A. Existing `GET /download` and PCF page have writes and are not captured by a non-GET route meta-test (`hub-server/src/pcf-api.ts:91–95,174–175`).
10. Rollback compatibility and responder real-world semantics remain unverified (§6); do not decide based solely on structural reading.

T1 is documentation only. No T2 implementation, production access, deployment, merge, or database query was performed. T2 must not begin before owner signs off (v1.0:419; v1.1:159–167).
