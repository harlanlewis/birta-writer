# Performance harnesses

Two runners share this directory's page stub (`index.html`) and fixtures
(`fixtures.mjs`): the **launch** harness below, and the **typing** harness
(`e2e/perf-typing.mjs`) at the end.

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
- Eager bytes are gated by a **budget ceiling** (`pnpm perf:bundle --check`), not a
  ratchet — see `e2e/perf-bundle.mjs`.

`baseline.json` is a checked-in **historical reference** (not the gate); update it
only inside an accepted-optimization commit.

## Automated launch gate (`pnpm perf:ab`, CI job `launch-perf`)

The manual A/B above is for the optimization loop. The same comparison runs
**automatically on every PR** and is a **required, blocking check** — because
boot time is a first-class metric and a same-session delta is trustworthy where
an absolute threshold isn't.

```bash
pnpm perf:ab                       # vs origin/main: builds merge-base + head, compares
node e2e/perf-ab.mjs --base origin/main --runs 9 --json ab.json
PERF_ACCEPT="reason" pnpm perf:ab  # accept an intentional launch cost locally
```

`e2e/perf-ab.mjs` builds the merge-base (in a detached git worktree, with that
commit's own deps) and the head into `dist-base/` and `dist-head/`, then calls
`node e2e/perf.mjs --ab dist-base dist-head`, which:

- **interleaves** head/base measurements per pair so slow machine drift cancels;
- gates only the **strong-signal fixtures** (`medium`, `large`); the small ones
  are reported but never fail;
- **double-confirms** — a regression must reproduce on the same fixture across
  two full passes before the job fails, killing transient CI false reds.

**Escape hatch for an intentional launch cost:** add the `perf-accept` PR label
or a `Perf-Regression-Accepted: <reason>` commit trailer; the gate reports the
regression but doesn't block (CI passes it through as `PERF_ACCEPT`).

## Fixtures

Generated deterministically (no Date/random) in `fixtures.mjs`: `tiny` (~0.1 KB),
`medium` (~12 KB mixed), `large` (~96 KB, 141 headings), `code-heavy` (~1 KB,
many languages + mermaid), `math` (~1 KB, KaTeX). Injected by the runner as
`window.__perfInit` before any script runs, so fixture I/O never pollutes the
`roundtrip` measurement. (Sizes measured from `FIXTURES`, not estimated — they
read as "how big is the document this row describes", so a wrong one misleads.)

# Typing-cost harness (`e2e/perf-typing.mjs`)

Measures **per-keystroke dispatch block** — the dominant slice of MAR-137
(large-document typing lag). The bundle wraps transaction dispatch
(`instrumentTransactions` in `webview/perf.ts`) so every doc-changing
transaction stamps an `mdw:tx-apply` measure: state apply + view DOM
reconciliation + every plugin view's `update`. The runner types real keystrokes
(Playwright `keyboard.type`) into each fixture and reports the distribution
(median / p95 / max) after a discarded warmup burst.

**What the span does NOT cover**: ProseMirror's pre-dispatch input path
(DOM-observer read, input-rule scan) and rAF-coalesced followers (TOC refresh,
the scheduled serialize) — on `xlarge` this was over half the burst's real
main-thread block before the TOC fast path landed. The **`block` column**
closes that blind spot (MAR-163): a buffered longtask observer sums every
main-thread task ≥50 ms during the measured burst, and `--compare` gates on it
(≥25% and ≥250 ms) alongside the dispatch median — so work merely *moved* out
of dispatch into a rAF now shows as a block regression instead of a fake win,
and work *removed* from a rAF (invisible to the median) shows as the
improvement it is. Granularity caveat: tasks under 50 ms don't register, so
`block` reads 0 on the small fixtures and only carries signal where
keystrokes already blow the frame budget (`large`/`xlarge`).

```bash
pnpm build && pnpm perf:typing            # all typing fixtures
node e2e/perf-typing.mjs xlarge           # one fixture
node e2e/perf-typing.mjs --keys 150 --json after.json
node e2e/perf-typing.mjs --compare before.json after.json
```

Fixtures are `TYPING_FIXTURES` in `fixtures.mjs`: `tiny`/`medium`/`large` shared
with the launch harness plus `xlarge` (~300 KB — the MAR-137 tail; kept out of
the launch set so `pnpm perf` runtimes and `baseline.json` stay comparable).

Same A/B discipline as launch: absolute ms drift with machine load, so gate on
a same-session `--compare`. Per-keystroke medians are small, so the noise gate
is **≥10% AND ≥0.5 ms**. The same marks work in the webview devtools against
any real document (Performance panel → User Timing), which is how to profile a
user-reported slow file.

Reference numbers (2026-07-16, M-series laptop, median of 80 keystrokes):
`tiny` ~0.7 ms, `medium` (12 KB) ~1.3 ms, `large` (96 KB) ~7 ms, `xlarge`
(300 KB) ~47 ms dispatch block (total per-keystroke block ≈ +30% on top). The
scaling is ProseMirror's per-keystroke view reconciliation (see MAR-137) — at
300 KB every keystroke blows the 16 ms frame budget, which is why MAR-137's
engine-lane decision exists.
