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
many languages + mermaid), `math` (~1 KB, KaTeX), `link-heavy` (~19 KB, 360
bare autolinks exercising the embed recognizer walk). Injected by the runner as
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

## The `caret` column (selection-only dispatch)

Added in MAR-137, and the reason is a cautionary tale about metric coverage:
`instrumentTransactions` used to dispatch selection-only transactions
*unwrapped*, on the stated grounds that they were "not the cost being tracked".
So caret moves were the one class of transaction **nothing in this repo
measured** — not `pnpm perf:typing`, not `typing-perf` in CI, not `block`.

`@milkdown/plugin-prism` ran two whole-document walks *above* its own
`docChanged` test. Every arrow key and every click on the 300 KB fixture paid
2.4 ms of blocked main thread, and it was invisible by construction for as long
as that instrumentation gap stood. **A cost no instrument reports is a cost that
regresses freely.**

So selection transactions now stamp their own span, `mdw:tx-select`, and the
harness reports the median as `caret`:

- It is a **separate span** from `mdw:tx-apply`, so the headline typing median
  means exactly what it always did and is never diluted by caret moves.
- It **is gated**, on the same floors as the typing median (≥10% AND ≥0.5 ms).
  Unlike `block` it is a clean per-transaction median rather than a
  threshold-sensitive whole-burst sum, so it does not inflate on a loaded runner
  — which is precisely why `block` is reported and this one decides.
- Missing on either side (a merge-base predating the metric) → **skipped, never
  read as a zero baseline**, which would make every A/B against an older commit
  a 100% regression.
- Validated the way MAR-224 validated the typing gate — by reintroducing the
  regression and watching it fire: `caret 3.45ms → 5.25ms (+52%) ✗ REGRESSED`,
  confirmed across two passes, while the null A/B against a metric-less
  merge-base correctly reported no caret row at all.

Two things about how the burst is placed, both learned the hard way:

- It runs on the **already-mounted page**. Mount is ~38% of an `xlarge` sample,
  so folding the caret burst into the existing sample costs burst time only —
  **measured at +0.25 s per sample (12.26 s → 12.51 s)**, roughly 2 s across the
  whole CI job.
- It runs **after** the typed burst, never before. Arrow keys walk the caret
  into whatever the fixture holds, and `xlarge` is 440 sections of prose +
  table + code block. Running it first parked the caret in a code block and the
  headline typing median read **38.5 ms instead of 5.4** — the ordering silently
  changed what the benchmark measured.

## Edit shapes the harness does NOT cover

Measured 2026-07-29 on `xlarge`, after both MAR-137 fixes, so the gap is
recorded rather than implied:

| shape | median | covered by a gate? |
| --- | --- | --- |
| typing in prose | 6.2 ms | ✅ `median` |
| moving the caret | 3.5 ms | ✅ `caret` |
| **Enter (structural edit)** | **34.3 ms** | ❌ |
| **typing inside a code block** | **38.1 ms** | ❌ |

The last two are ~6× prose typing and neither fix touched them: a structural
edit takes the walk paths that typing now skips, and a caret inside a code block
makes the highlighter recompute decorations for the *whole document* on every
keystroke (upstream behavior, deliberately preserved). They are real costs with
no gate; see MAR-137 lane 1 before assuming typing perf is "done".

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
a same-session A/B. Per-keystroke medians are small, so the noise gate
is **≥10% AND ≥0.5 ms**. The same marks work in the webview devtools against
any real document (Performance panel → User Timing), which is how to profile a
user-reported slow file.

## Automated typing gate (`pnpm perf:typing:ab`, CI job `typing-perf`)

`--compare` diffs two JSONs you captured by hand. **`--ab` is the stronger form
and the one CI runs** — it interleaves both bundles in one browser session, so
machine drift cancels within each pair rather than across a stash-and-rebuild.

```bash
pnpm perf:typing:ab                          # vs origin/main: builds merge-base + head, compares
node e2e/perf-ab.mjs --typing --runs 5 --json typing-ab.json
PERF_ACCEPT="reason" pnpm perf:typing:ab     # accept an intentional typing cost locally
```

`e2e/perf-ab.mjs` is shared with the launch gate — same detached-worktree
merge-base build — and `--typing` points it at `node e2e/perf-typing.mjs --ab`
instead of `perf.mjs --ab`. That comparer:

- **interleaves** head/base bursts per pair; the first pair is discarded as warmup,
  and durations are **pooled** across pairs before taking the median;
- measures **only the gated fixture** (`xlarge`). The others can't inform the
  decision: `medium` reads 1.8 ms per keystroke on CI, so even a large
  percentage move is a fraction of the 0.5 ms absolute floor. `large` was
  dropped on the same reasoning at the margin — ~1/5 the sensitivity for a
  third of the runtime. Use `pnpm perf:typing` for the full spread;
- **double-confirms** — a regression must reproduce across two full passes;
- **reports `block`, never gates it.** Two independent measurements say it can't
  be a gate: a null A/B (identical bundles) moved it ~15% on `xlarge` while the
  dispatch medians held within 1.1%, and the same `xlarge` burst reads **679 ms
  locally vs 15,037 ms on a CI runner — 22×**, because its longtask threshold is
  a fixed 50 ms and a slower machine pushes every sub-threshold task over it. So
  it informs — including the "median improved but block regressed → work moved,
  not removed" warning — and never decides. This is a deliberate divergence from
  `--compare`, which does fail on block; `--compare` runs on a machine you
  control, CI does not.

**Escape hatch:** the same `perf-accept` PR label / `Perf-Regression-Accepted:
<reason>` commit trailer as the launch gate, deliberately not a second one.

### When it runs, and what it costs

**It does not run on most PRs.** It lives in its own workflow
(`.github/workflows/typing-perf.yml`) behind a `paths` filter, so a PR touching
only docs, `src/`, or CI config skips it entirely. It fires on `webview/**`,
`packages/**` and the perf harness itself — deliberately wider than "the files
that could regress typing", because narrowing a gate to specific plugins is how
it silently stops covering what it was built for.

It is also **not** in branch protection's required set, on purpose: a required
check that a `paths` filter skips leaves a PR waiting forever on a status that
never arrives.

**Every figure below is a completed CI job, not an estimate** — three successive
estimates of this runtime were wrong before it was simply run and read:

| config | one pass | job total |
| --- | --- | --- |
| 3 fixtures, 4 pairs, 80 keys | 8m30s | 9m23s |
| 2 fixtures, 4 pairs, 80 keys | 7m16s | 7m55s |
| **1 fixture, 2 pairs, 60 keys** (current) | — | **~3 min** |

One run of the 2-fixture config was still going past 13 min before being
cancelled — unexplained runner variance, so treat these as typical, not
guaranteed.

**Fixture count is a weak lever, which is the non-obvious part.** Dropping
`medium` cut only ~15%, because `xlarge` dominates everything. Per sample on a
dev laptop (CI ≈ 2× that):

| fixture | mount | settle+warmup | 80-key burst | total |
| --- | --- | --- | --- | --- |
| `large` | 1.3s | 1.7s | 3.5s | 6.4s |
| `xlarge` | 6.4s | 2.4s | 8.0s | 16.7s |

So if this needs to get cheaper again, the levers are **`xlarge`'s keystroke
count and the pair count** — and, if it ever matters more, mounting the document
once per side instead of once per sample (mount is ~38% of `xlarge`).

A CI runner is ~2× slower per keystroke than a dev laptop (`xlarge` 45.8–47.5 ms
vs 22.8 ms), so *never* size this job from local timings. It is a separate CI
job from `launch-perf` because the two harnesses must not share a runner (see
*Run one harness at a time* in `AGENTS.md`).

Reference deltas from that first CI run, for calibrating the thresholds against
real runner variance: on an unchanged webview, `medium` 0%, `large` +3.8%,
`xlarge` −3.2% — all comfortably inside the 10% gate.

Reference numbers — **re-measured 2026-07-25, after MAR-215 roughly halved
per-keystroke dispatch.** The previous figures here were captured 2026-07-16 and
had gone stale in exactly the way this file warns about, to the point of
contradicting the CI numbers above (they put the laptop's `xlarge` at ~47 ms,
which is now the *CI runner's* number, not the laptop's).

| fixture | M-series laptop | CI runner (ubuntu-latest) |
| --- | --- | --- |
| `medium` (12 KB) | 0.9–1.1 ms | 1.8 ms |
| `large` (96 KB) | 4.7–4.9 ms | 10.6 ms |
| `xlarge` (300 KB) | 22.6–23.0 ms | 47.5 ms |

Laptop figures are pooled over 4 interleaved pairs × 80 keystrokes; CI figures
are from the first `typing-perf` run. Total per-keystroke block runs above the
dispatch median (the span misses the pre-dispatch input path and rAF followers).

Two consequences worth holding onto:

- **The gate is percentage-based, so it is *less* sensitive in absolute terms on
  the slower machine.** 10% of `xlarge` is ~2.3 ms locally but ~4.8 ms on CI.
- **A uniform per-keystroke regression below that floor passes silently.** Adding
  a flat ~2 ms to every keystroke is a real cost this gate cannot see: it is
  under 10% on `xlarge`, and on the small fixtures it is under the 0.5 ms
  absolute floor. The floors exist to stop flapping and that is the price they
  charge — the gate catches *scaling* regressions (work proportional to document
  size, the MAR-215 shape), not small constant ones. Don't read a green
  `typing-perf` as "no cost was added."

The scaling is ProseMirror's per-keystroke view reconciliation (see MAR-137) — at
300 KB every keystroke blows the 16 ms frame budget, which is why MAR-137's
engine-lane decision exists.
