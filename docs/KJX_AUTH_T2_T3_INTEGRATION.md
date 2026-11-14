# Wire T3 identities into T2 PCF authorization

This integration supersedes PR #3 (`2306940f437236d3073b62f77f3d6815830de9a2`)
and targets PR #5's branch `feat/p4-2-kjx-identity-authz`, not `main`.
Authority: approved decisions dated 2026-11-14, especially items 3 and 4,
and v1.1 R4.

## Integration and conflict resolution

- Apply the T3 commit with `git cherry-pick --no-commit`. Git auto-merges
  `database.ts` and `pcf-storage.ts`; there are no textual conflict markers.
- Resolve the duplicate users-table initialization semantically: retain T2's
  `initializeIdentitySchema` entry point and its eight columns (`id`, `username`,
  `name`, `title`, `disciplines`, `role`, `first_seen`, `last_seen`). T3's columns
  are identical; no additional fields are discarded. Omit T3's duplicate
  `003_kjx_users.sql` and its `database.ts` invocation. The PCF migration version
  remains unchanged.
- Retain T3's `upsertKjxUser` / `getKjxUser` helpers. T2 identity verification
  delegates to the single upsert helper, retaining its 60-second per-user write
  throttle. `RequestUser` reuses the helper's user shape with a narrowed role.
- Preserve T2 audit writes and T3 optional request-actor storage plumbing,
  including identity-bound batch receipt hashes. In hosted kjx `POST ops`,
  convert only verified `requestUser` into `{ sub: user.id, name: user.name }`.
  Body-supplied request actors and participant IDs never establish ownership.
- New `comment.add`, `round.add`, and `rounds.addAll` rounds record the request
  user's ID and display-name snapshot. Builder reply imports do not receive a
  request actor and do not assign `responderId`; existing business identity
  fields survive complete export/import.
- Restrict T3's identity-field `round.meta` no-op filter to authenticated
  request-actor calls. Legacy continues rejecting those unsupported fields
  with 400, as before. Reviewer participant-name changes remain forbidden;
  manager/admin name edits never rewrite participant IDs.
- Keep T3's conditional offline export projection so absent legacy identity
  fields remain absent and the legacy projection remains byte-identical.

## Authorization within a batch

`authorizeOps` projects only comment/round IDs and server-owned initiator IDs
in operation order, without mutating the stored document or copying content
and images. This permits a reviewer to create and edit a round in one request,
including `round.add` followed by `comment.status` when every round is theirs.
Existing, deleted, or tombstoned IDs cannot be shadowed to acquire ownership.
No projection removes another user's round or changes participant IDs.

Reviewer owner content and `minHeight` require ownership of that round.
Comment-wide status/meta require ownership of every round, including new rounds
in the same batch. Missing legacy IDs are never inferred from names. A foreign
or anonymous round denies the complete batch before writes, revision changes,
or audit insertion.

## Tests and compatibility

T3 contributes six data-model/cache/export/template tests. The integration adds
eight HTTP/authorization regression tests to the T2-only test file, including
same-batch add/edit and add/status, foreign/legacy-round atomic rejection,
spoofed identities, participant metadata, manager bulk additions, real builder
and complete exchange round trips, and identity-bound receipt replay.

Two T2-specific fixture adjustments are necessary: its old-round denial test
now explicitly removes IDs to represent a pre-identity document, and its
owned-round edit test creates the round as a reviewer instead of manually
seeding an ID. No pre-T2 legacy tests are changed, including the original
`permissions.test.ts`; the two previously approved T2 session assertion changes
remain untouched. No template/schema upgrade, dependency/lockfile changes,
production-server operation, main push, or PR merge is included.

Initial foreground verification of integration commit
`adfaf225bdbbd4230a9e4597f68fd978e9d741a3`: `hub:build` passed,
`hub:test` 303/303 (289 T2 + 6 T3 + 8 integration), and `hub:e2e` 12/12.
Final foreground verification after merging T2 security commit
`1a231723606c97950c4dc49ee06bd60c62d50519`: `hub:build` passed,
`hub:test` 305/305 (291 T2 + 6 T3 + 8 integration), and `hub:e2e` 13/13,
with zero failures or skips. All three commands used 600-second foreground
limits; no E2E build or test selection was skipped.

The T2 follow-up auto-merged without textual conflicts, including
`kjx-permissions.test.ts`. Preserve its independent literal T1 route inventory,
policy-to-case and case-to-policy coverage, attachment tests, and all integration
ownership regressions. Integration adds no routes; the independent inventory
passes against the merged application. Retain T2's attachment/sandbox response
headers in both modes and its two-mode browser handoff regression unchanged.
The upstream follow-up is complete; there are no outstanding validation items.
