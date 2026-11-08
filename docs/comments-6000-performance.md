# Comments register: 6,000-comment acceptance

Fixture: 200 PCFs, 30 comments each, using the complete current hosted template
(not reduced HTML). There are 2,000 Cost Affect comments, 4,400 open comments
and 1,600 closed comments. All data lives in an OS temporary directory; no
8080/8081/8082 data is used. Measurements are local wall-clock samples, not
network latency guarantees.

## Reproduce

Build in PAhub-preview only, then run:

```text
node hub-server/test/comments-6000-fixture.mjs
```

It prints the random origin and cold/warm/change/Excel measurements, asserts
all 6,000 rows and the changed marker, and remains available for browser QA.
Navigate the Playwright CLI to that origin, then run:

```text
node node_modules/playwright/cli.js cli -s=pahub-next run-code --filename hub-server/test/comments-6000.acceptance.js
```

The script enters through the project lobby, measures applied filters and
search through painted results, checks pagination and stable-ID PCF links,
records scroll frame timings and pageerrors, and takes screenshots under
output/playwright/. Stop the fixture with Ctrl+C after browser QA.

## Server measurements

| Request | HTTP duration | Parsed PCFs | Bytes |
| --- | ---: | ---: | ---: |
| Cold | 1,602.12 ms | 200 | 3,605,961 |
| Warm | 49.98 ms | 0 | 3,605,961 |
| Conditional ETag 304 | 11.26 ms | 0 | 0 |
| After saving one PCF through the real ops API | 141.24 ms | 1 | 3,605,920 |
| Excel export | 1,008.46 ms | 0 | 11,617,783 |

PAHUB_COMMENTS_PROFILE=1 now reports parsedFiles alongside scan/query time.
The unit regression also asserts cold=2, warm=0, changed=1, warm=0 with two
PCFs; this instrumentation is opt-in and does not change the API response.
File metadata is scanned on each request, but unchanged HTML is not reread
or reparsed. The updated response was verified to contain the saved marker.

## Browser baseline and optimization

The table is paginated (25/50/100 rows), not 6,000 DOM rows. Baseline applied
Cost Affect filtering took 274 ms; search within that tag took 286 ms; reset
took 299 ms; next page took 211 ms. pageerrors=0, stable comment-ID focus
passed, and the retired Intelligence navigation was absent.

Scrolling exposed viewport-sized backdrop-filter repaint work. The initial
90-frame sweep had P95 122 ms. A direct before/after browser experiment
measured P95 95 ms before and 32 ms after disabling only the Comments outer
surface blur; idle P95 was 18 ms. Production now uses an opaque Comments
surface instead of that blur. Charts are memoized so editing filter drafts
does not render all three charts again. Other pages retain their layout.

The optimized production browser rerun is pending: the normal permission
approval service returned upstream HTTP 400 before the command executed.
This is an infrastructure failure, not a passed browser acceptance. The
acceptance script and existing light/dark screenshots are retained for the
final unified run. No screenshots or temporary data are committed.

Build and hub:test passed in PAhub-preview: 76/76, exit 0.
