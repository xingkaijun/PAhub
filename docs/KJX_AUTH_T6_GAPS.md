# T6 feature gap inventory

Baseline: `origin/feat/p4-5-kjx-integration` at
`232dee8a40aedfb9f0ae9cd7433521835eae65fa`. Line numbers in this initial
inventory refer to that baseline. Authority: current T6 request, approved
2026-11-14 decisions, v1.1 R4, then v1.0.

| Requirement | Baseline status | Evidence / remaining work |
| --- | --- | --- |
| C1 new-round identity, no historic backfill, ignore spoofed creator | Implemented | `hub-server/src/pcf-model.ts:8,107,148,157,172`; `hub-server/src/pcf-api.ts:170`; server writes verified ID/name for comment.add, round.add and rounds.addAll. |
| C1 admin/manager designate another initiator by verified ID | Not implemented | `hub-server/src/pcf-model.ts:205` only stores participant display text; identity round.meta fields are filtered at `:109`. Add explicit privileged assignment resolved against directory/project team/local cache; invalid ID 400, reviewer submitted values cannot establish another identity. |
| C1 Builder import actor | Implemented, needs feature regression | `hub-server/src/pcf-builder-replies.ts:30-44` uses writeAudit; `hub-server/src/router.ts:91` request audit context supplies verified actor; `hub-server/src/audit.ts:13-17`. responderId is not set by imports. Test actor_id/name for an actual Builder import. |
| C1 template version / upgrade dry-run | Partial | `hub-server/src/pcf-template.ts:9-28` version 6; `hub-server/scripts/upgrade-pcf.mjs:1-11` bundles upgrade in memory. Existing T3 no-op coverage in `hub-server/test/kjx-people-model.test.ts:78`. Decide whether a kjx-only hosted adapter needs a persistent template bump; verify dry-run and old/new file readability without altering legacy template bytes. |
| C1 rollback to fec6429 | Readable at reader level; verify by executable regression | fec6429 `hub-server/src/pcf-html.ts:12-13` parses #pcf-data using JSON.parse and ignores unknown IDs; `pcf-template.ts:16` accepts newer template versions as current. Authoritative JSON remains readable by old load/initData. Old code does not enforce identity and may omit IDs from restricted Builder projections: reading is compatible, identity-preserving old writes are not guaranteed. |
| C2 logged-in name/read-only creator UI | Not implemented | `pcf/template/PG-PCF-hub.html:1602,1642,1678` uses free-text defaults and participant controls; `hub-server/src/pcf-kjx-adapter.ts:18-24` only gates general action buttons. Add kjx-only controls; do not modify legacy creation/inputs. |
| C2 admin/manager initiator dropdown / self-only fallback | Not implemented | No directory client or candidate route. Public team directory must remain admin-only, so provide a separately scoped PCF candidate endpoint for admin/manager; no browser calls to kjx-auth. |
| C3 actor migration, unified audit INSERTs | Implemented | `hub-server/src/audit.ts:7-17`; six business write sites delegate to writeAudit. Existing no-bypass grep regression at `hub-server/test/kjx-permissions.test.ts:654-665`. Preserve and extend coverage. |
| C4 audit API exposes actor | Not implemented | `hub-server/src/activity-routes.ts:10-15` SELECT and response omit actor_id/name. Add kjx-only response fields; legacy response unchanged. |
| C4 Actor column/filter | Not implemented | `components/DailyLogReport.tsx:18-29,110-138` rows omit actor; merge at `:43` combines multiple people. Add identity-aware merge/filter and English Actor controls in kjx only. Local/historic/legacy rows display em dash when Actor is shown. ActivityReport is aggregate drawing analytics, not an audit table. |
| C4 CSV/Copy/PDF Actor | Not implemented | `components/DailyLogReport.tsx:366-397` export headers/rows omit actor; PDF at `:312` captures report DOM. Add Actor to exports and PDF report section with filtered rows. |
| C5 admin-only directory proxy, service token/cache/timeout | Not implemented | No team/directory route; `hub-server/src/app.ts:35-42` registers existing APIs only. Supplied token client exists at `hub-server/src/kjx-auth-client.ts:244-275` but is unused. Add server-only env-driven proxy, 5-minute cache, 5-second timeout, >=60-second failure backoff and redacted warnings. |
| C5 roles/professional mapping | Partially implemented | `hub-server/src/discipline-map.ts:1-7` already maps approved disciplines. Directory must request app=pahub&active=1 without role and filter admin/manager/reviewer on server. |
| C5 Team Setup directory selection/name snapshot | Partially implemented data model only | `types.ts:45`, `hub-server/src/project-write.ts:52` and `project-read.ts:22` already store/read reviewer id + name. `components/DrawingList.tsx:793-889` and `components/Settings.tsx:375` only use existing reviewers. Add directory dropdowns and fallback message; selected reviewer.id is kjx sub, name is snapshot. Manual fallback must not claim a kjx identity. |
| C5 people reconciliation tool | Intentionally not required | Approved decision item 2: owner clears demo reviewers before cutover; do not create a mapping tool or demo-data migration. |

## Explicit implementation assumptions / apparent conflicts

- The T6 request explicitly restores privileged designation from v1.0 C1.
  Default new-round creation still writes the caller and ignores raw spoofed
  participant fields. Privileged reassignment is a separate explicit operation
  carrying a user ID; only resolved names/IDs may be stored.
- The team directory endpoint is admin-only. PCF managers obtain only scoped
  initiator candidates through a PCF capability-guarded endpoint, not the
  admin-only team route. When directory service is unavailable, PCF UI shows
  only the logged-in user; backend validated project-team/local-cache lookup
  remains available for explicit assignment, per R4.1/R4.2.
- All T6 functionality is kjx-gated. Keep pre-T2 tests unchanged and preserve
  upstream H1's approved both-mode attachment hardening. No secrets are written.

This inventory was written before feature implementation.

## Final status (T6)

| Requirement | Final status | Implementation / verification |
| --- | --- | --- |
| C1 privileged designation | Implemented | `hub-server/src/pcf-initiator.ts:8-35`, `pcf-api.ts:178`, `pcf-model.ts:204-210`: explicit round.meta field=initiator with initiatorId; resolve server-owned ID/name, missing ID 400 before any batch mutation. Default creation still ignores spoofed creator fields. |
| C1 Builder audit | Implemented and verified | Actual Builder import regression asserts importer ID/name on BUILDER_REPLY and the API; responderId remains absent. Existing unified writeAudit and grep guard remain in place. |
| C1 upgrade/rollback | Verified; version-bump deviation | Persistent template remains version 6 because all T6 PCF UI is injected only in kjx hosting. No persisted template/data-schema change requires upgrade. Tests execute actual fec6429 reader/model from git blobs against new HTML and JSON; both preserve IDs on read. upgradeFile dry-run covers current v6 and older v5; the actual upgrade CLI dry-run is executed on a sample and does not rewrite it. Reading on rollback does not require restoring PCF data; old-code writes/exports can omit identity fields and do not enforce kjx ownership, so backup is still required before an operational rollback. |
| C2 PCF creator UI | Implemented | `hub-server/src/pcf-kjx-adapter.ts:24`: current-account round creation, reviewer read-only Owner, manager/admin validated dropdown. Directory unavailable: only caller is selectable; existing other-user names remain a disabled display snapshot. Template files unchanged. |
| C3 audit consistency | Already implemented, retained | Single INSERT in audit.ts, inherited grep no-bypass test passes. Request audit actor and background/offline null semantics unchanged. |
| C4 Actor API/UI/filter/exports | Implemented | `activity-routes.ts:10-15`, `DailyLogReport.tsx:70,263,389,409,539,837`, `lib/auditActors.ts`: kjx-only actor fields, per-user merge boundaries, English filter, em-dash historical/local rows, Copy/CSV and multipage PDF Actor section. Chromium exercises actual filter and exports. |
| C5 directory service | Implemented | `kjx-directory.ts:15-75`: env-only credentials, supplied service-token helper, audience kjx-auth, active app=pahub directory, role filtering, mapped discipline, five-minute cache/coalescing, total five-second refresh deadline including token and body, 60-second error backoff, fixed redacted warning. |
| C5 route authorization | Implemented | `team-directory-routes.ts:3`: admin-only team proxy; `pcf-api.ts:155`: separately capability-scoped manager/admin PCF candidates. Both added to the literal independent route inventory; no browser direct connection to kjx-auth. |
| C5 Team Setup snapshots/fallback | Implemented | `DirectoryPicker.tsx:5-24`, `DrawingList.tsx:830`, `Settings.tsx:348,382`: directory IDs stored in existing reviewers.id/assignment fields and name snapshots in display_name; browser test verifies persistence. Manual fallback uses a manual- prefixed local surrogate only because legacy reviewers.id/assignment schema requires a key, never a claimed kjx sub, and cannot be designated as an authenticated initiator. |
| Reconciliation tool | Not applicable by approved decision | No demo migrations or reconciliation tool added. |

## Final verification

- `npm ci`: installed locked dependencies in the new T6 worktree; no lockfile changes.
- `npm run hub:build`: PASS, both TypeScript checks and frontend/server builds.
- `npm run hub:test`: **313/313**, 0 failures, 0 skips (305 integration baseline + 8 T6 tests).
- `npm run hub:e2e`: **14/14**, 0 failures (13 existing suites + T6 feature browser suite).
- All three final commands ran in the foreground with 600-second limits, full selections, no skip-build flag.
- T6 tests cover token success/401/timeout, directory 401/timeout, cache/backoff, non-admin 403, spoofed creator, existing/missing designation, project-team fallback, importer audit, Actor selection/escaping/export, old-reader execution and upgrade CLI dry-run.
- Browser regression covers creator read-only/save, manager assignment, directory-backed Team Setup persistence, Actor merge/filter/Copy/CSV/PDF, self-only PCF outage options and manual-name fallback.
- `git diff --check`: PASS. No pre-T2 tests, legacy templates, immutable v2.6 source, or dependency lockfile changed.

## Deviations and owner decision points

1. No persistent PCF template version +1: hosted-only adapter avoids changing legacy/offline behavior and operational upgrades. Compatibility is executable-tested. Confirm this versioning interpretation during PR review if a bookkeeping version bump is required regardless of persisted changes.
2. Privileged designation uses explicit round.meta initiator + initiatorId, not raw creator fields; this preserves the approved default server-owner rule. Reviewer creation spoofing is ignored; reviewer participant reassignment remains 403 as required by decision item 4.
3. Separate PCF initiator-candidate endpoint is necessary because the requested team directory is admin-only while PCF designation allows managers.
4. Manual fallback requires a non-kjx surrogate primary key in the existing reviewer schema. Only the entered name is an identity snapshot; no authenticated userId is fabricated. Confirm only if a distinct no-key manual-assignee data model is desired (would be a broader schema change).
5. New behavior is kjx-only. The already approved upstream H1 both-mode attachment change remains inherited; it is not reverted. No production operations, secrets, main push, PR merge, or people reconciliation are included.
