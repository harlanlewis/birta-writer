# Launch-performance harness

Measures webview cold-start (open `.md` → editor painted) by driving the **real
built bundle** (`dist/webview.js` + `dist/webview.css`) in headless Chromium and
reading the `mdw:` User-Timing marks the bundle stamps during boot (see
`webview/perf.ts`). Same production code the extension ships, minus VS Code's
chrome and message host (stubbed by `index.html`).

## Run it

```bash
node esbuild.mjs --production --metafile   # build what users get + emit metafile
pnpm perf                                  # all fixtures, median-of-9 table
node e2e/perf.mjs medium                   # one fixture
pnpm perf:bundle                           # zero-variance eager-bytes metric
```

## Spans reported (ms, median of runs 2..10)

| span | marks | what it is |
| --- | --- | --- |
| `launch` | 0 → `editor-painted` | **headline**: navigation start to first painted editor frame |
| `eager` | `eval-start` → `ready-posted` | eager module eval + UI construction |
| `roundtrip` | `ready-posted` → `init-received` | the `ready`→`init` postMessage hop |
| `create` | `create-start` → `create-end` | Milkdown `Editor…create()` (parses the doc) |
| `rtp` | `rtp-start` → `rtp-end` | `computeRoundTripProtection` (re-serializes the doc) |
| `toc` / `toolbar` | `*-start` → `*-end` | those two components' construction |

`launch` minus the sum of the measured spans is the browser's bundle
fetch+parse cost (the eager JS/CSS download before `eval-start`).

## The A/B gate (how the optimization loop decides)

Absolute ms drift with machine load, so the gate is a **same-session A/B**:

```bash
node esbuild.mjs --production --metafile && pnpm perf --json before.json
node e2e/perf-bundle.mjs --json bundle-before.json
# ...make the change, rebuild...
node esbuild.mjs --production --metafile && pnpm perf --json after.json
node e2e/perf-bundle.mjs --json bundle-after.json
pnpm perf --compare before.json after.json            # launch verdict
node e2e/perf-bundle.mjs --compare bundle-before.json bundle-after.json  # eager-bytes verdict
```

- **improved**: median `launch` down ≥3% AND ≥10 ms on ≥1 fixture, nothing up >3%+10 ms.
- **regressed**: any fixture up >3% AND >10 ms → do not commit.
- Eager bytes must never grow >1%; an eager-bytes drop can justify committing a launch-neutral change.

`baseline.json` is a checked-in **historical reference** (not the gate); update it
only inside an accepted-optimization commit.

## Fixtures

Generated deterministically (no Date/random) in `fixtures.mjs`: `tiny` (~0.1 KB),
`medium` (~12 KB mixed), `large` (~96 KB, 141 headings), `code-heavy` (~1 KB,
many languages + mermaid), `math` (~1 KB, KaTeX). Injected by the runner as
`window.__perfInit` before any script runs, so fixture I/O never pollutes the
`roundtrip` measurement. (Sizes measured from `FIXTURES`, not estimated — they
read as "how big is the document this row describes", so a wrong one misleads.)
