# Autosave P0

Base: main `97bf04fced802cf325b21badcb4406c4a90a4882` (PR #13 was not merged
when the branch was created). Scope is P0 only: no Daily Log simplification,
Tracker offline queue redesign, quota/P1 work, or general P2 synchronization
protocol. No deployment or production operations.

## Save status

Kjx main application has a persistent save-status bar: pending count, saving,
last successful confirmation time, or failure reason and retry deadline. Retry
now can bypass temporary backoff; sign-in failures offer a session check, while
403 and 413 disable blind resubmission. Status survives refresh via localStorage
and never treats an interrupted in-flight request as saved. The existing close
warning and Save Now remain. UI text is English, matching the application; the
Guide note has Chinese/English variants.

Hosted kjx PCF pages have the same status vocabulary and a separate localStorage
status keyed by actor/document. Existing PCF save feedback, IndexedDB recovery,
entity-clock conflicts, tombstones and receipts are retained. Legacy template
files are not changed, and legacy application behavior/controls remain intact.

## Requests, retry and confirmation

- One ProjectSlice save operation is in flight at a time. Same-project callers
  share one promise; other-project operations wait. PCF uses its existing write
  busy flag plus an adapter-level lock.
- Kjx save HTTP requests have a 15-second timeout including response consumption;
  AbortSignal is passed to fetch. Tracker-baseline reads and rollback reads are
  also bounded. Timeout says confirmation is unknown, not that nothing was saved.
- Temporary network/timeout/5xx retries use 3s, 6s, 12s, 24s, 48s, then 60s cap;
  success resets attempts. Multiple timers/manual autosave callers converge on
  the same lock. Manual Retry now bypasses only temporary waiting.
- 401 preserves the pending request and stops automatic submission until session
  verification succeeds. Save-specific requests do not navigate away before
  recording this status; the sign-in/check-session button uses the normal auth
  flow. Requests belonging to a different saved actor are not replayed.
- 403 uses the existing project rollback semantics, clears pending request and
  dirty changes, and retains a visible rejection status. A genuinely new allowed
  edit can start a new request; the rejected request is never retried.
- 413 retains local pending work, stops both automatic and manual retry, and asks
  the user to contact an administrator. It does not continuously submit the same
  oversized payload. Correcting/removing oversize work requires an explicit next
  workflow rather than silently truncating user data.
- 409 drawing/config handling remains field-specific: conflicting values adopt
  the server, remaining nonconflicting work may save as a fresh request. Other
  invalid client errors stop automatic retry.

The request, project snapshot, original dirty fields/baselines and Tracker slice
are frozen before submission and persisted. New edits made while confirmation
is unknown remain separate; successful replay clears only the acknowledged
snapshot and leaves newer edits pending. Hydration applies the same project
normalization to frozen and live copies.

### Lost response safety

A timeout/500 can occur after commit, so merely resubmitting a frozen PATCH with
field baselines is not enough when another editor has subsequently changed it.
Kjx PATCH autosave adds saveRequestId; a small server-side project_save_receipts
table records the acknowledgement in the same transaction, keyed by project,
verified actor and request ID with a body hash. Replay checks project access and
returns that exact acknowledgement instead of writing/auditing twice or
reapplying over later edits. Reusing an ID with different content is 409. There
is no receipt for rejected/rolled-back requests. It is initialized idempotently
only in kjx; legacy without this field is unchanged. Retention is seven days and
100 confirmations per actor/project. After expiry, normal baseline checks remain
but exact replay is not promised; users should resolve long-stalled work rather
than relying indefinitely on a receipt.

This limited addition is required to meet P0's explicit no-duplicate/no-false-
conflict requirement for unknown confirmation. It is not a generic all-writer
P2 API or data model migration. Existing PCF uses its original UUID batch receipt.

## PCF member rejection

Member project.member 403 and ordinary 403 both clear rejected PCF local queues
and batches and reset to acknowledged data. Member rejection marks the project
and known documents rejected in localStorage, then deletes the corresponding
IndexedDB records before navigating back to the hall. Unknown older documents
are blocked by the project marker too. Other open tabs observe the marker and
stop replaying; a hosted recovery hook checks it before the template starts
IndexedDB restoration (DOMContentLoaded would be too late). If IndexedDB deletion
fails, the rejection marker still prevents automatic resubmission. Fresh edits
made after renewed access get a document resume timestamp, not the rejected
old batch. This cannot revoke bytes/files already downloaded by the user.

## Project switching

Chosen strategy: **block kjx switching until current work is confirmed saved**.
Both lobby selection and store loadProject first try saving the current dirty
project. Failed save, permanent-error stop or newer still-pending edits reject
switching with a clear message. Current project, dirty fields and pending request
remain in localStorage. Return/reload reopens the same pending work; after a
successful retry the switch can continue. This avoids adding a larger per-project
multi-edit outbox/data migration and avoids legacy global dirty flags attaching
to another project. Legacy save/discard switch prompts are retained.

## Validation

Unit tests: retry sequence/permanent stops, same-key and cross-key locks, abort
on timeout, frozen payload/baseline preservation, newer edits after replay,
persisted interruption/restart recovery, session-gated resume, switch blocking
and successful continuation, PCF IndexedDB member rejection, and real HTTP
commit-before-timeout receipt replay with later editor changes.

Browser suite: pending/failure/saved statuses and screenshots; backoff retries
use identical requests; Retry now succeeds; 413 does not loop; project switching
remains on the pending project; PCF member-403 deletes IndexedDB before returning
to the hall. Existing legacy/403/409/PCF recovery tests remain unchanged.

Screenshots generated locally under hub-server/test/artifacts/:
- autosave-p0-pending.png
- autosave-p0-failed.png
- autosave-p0-saved.png

Final verification: hub:test **339/339**, zero failures/skips; hub:e2e
**18/18**, zero failures; hub:build PASS, including a separate final foreground
build. Full selections, no skip-build flag. The combined validation command was
started in the foreground and moved to background by the harness at its overall
600-second limit while the final build completed; its final exit code was 0.
All three screenshots were regenerated and opened for visual inspection.
GitHub CI results are checked after publishing, not inferred from local tests.

No blocking owner decision remains. Seven-day/100-per-actor-project receipt
retention and a 15-second request deadline are explicit bounded defaults; exact
replay after receipt expiry is not guaranteed. Old baseline clients keep normal
field conflict protection. Cross-tab/global-client locking, storage quota UX,
Tracker offline intent persistence and Daily Log changes remain outside P0.
