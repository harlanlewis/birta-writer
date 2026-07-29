# Performance harnesses

Two runners share this directory's page stub (`index.html`) and fixtures
(`fixtures.mjs`): the **launch** harness (`e2e/perf.mjs`) and the **typing**
harness (`e2e/perf-typing.mjs`).

> **This file documents how the harnesses work, not what they last measured.**
> Absolute timings belong in the commit or ticket that changed them — a figure
> written here reads as current forever and is wrong the moment anything lands.
> Thresholds and budgets are the exception: those are configuration, they live in
> `verdict.mjs` / `bundle-baseline.json`, and the numbers quoted below are meant
> to match them. If they disagree, the code is right.

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

## Spans reported (median of runs 2..10)

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

**`paint` (`create-end` → `editor-painted`) is the easiest span to overlook** —
it is ProseMirror's first DOM build plus style/layout/paint, *including any work
a plugin schedules from its `view()` onto the frames before that paint*. Work
moved in front of first paint is invisible to every other span, so if a plugin
schedules its own rAF at mount, suspect this one.

## The A/B gate (how the optimization loop decides)

Absolute timings drift with machine load, so the gate is a **same-session A/B**:

```bash
node esbuild.mjs --production --metafile && pnpm perf --json before.json
node e2e/perf-bundle.mjs --json bundle-before.json
# ...make the change, rebuild...
node esbuild.mjs --production --metafile && pnpm perf --json after.json
node e2e/perf-bundle.mjs --json bundle-after.json
pnpm perf --compare before.json after.json            # launch verdict
node e2e/perf-bundle.mjs --compare bundle-before.json bundle-after.json  # eager-bytes verdict
```

- **improved**: median `launch` down ≥3% AND ≥10 ms on ≥1 fixture, nothing up past the same floors.
- **regressed**: any fixture up >3% AND >10 ms → do not commit.
- Eager bytes are gated by a **budget ceiling** (`pnpm perf:bundle --check`), not a
  ratchet — see `e2e/perf-bundle.mjs`.

Removing eager bytes therefore produces **no CI signal on its own**: `--check`
just passes with more room, and the space is immediately re-spendable. Finish a
bytes win with `--set-budget` so the ratchet sticks.

`baseline.json` is a checked-in historical reference, **not** the gate. It
records a measurement; it is not one. Rebuild and re-run before quoting anything
from it, and refresh it whenever you move the ceiling.

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
- gates only the **strong-signal fixtures** (`GATED_FIXTURES` in `verdict.mjs`);
  the small ones are reported but never fail;
- **double-confirms** — a regression must reproduce on the same fixture across
  two full passes before the job fails, killing transient CI false reds.

**Escape hatch for an intentional launch cost:** add the `perf-accept` PR label
or a `Perf-Regression-Accepted: <reason>` commit trailer; the gate reports the
regression but doesn't block (CI passes it through as `PERF_ACCEPT`).

`dist-base/` and `dist-head/` are **left in the working tree** — the runner
clears them before rebuilding, never after. They are gitignored, and
`.vscodeignore` does not honour `.gitignore`, so both are listed there *and* in
`scripts/check-vsix.mjs`'s banned set: without that, running an A/B locally and
then packaging silently ships two extra copies of the bundle in the VSIX.

## Fixtures

Generated deterministically (no `Date`/`Math.random`) in `fixtures.mjs`, so a
run is reproducible: `tiny`, `medium` (mixed prose/lists/tables/code), `large`
(the same section shape repeated), `code-heavy` (many languages + mermaid),
`math` (KaTeX), `link-heavy` (bare autolinks exercising the embed recognizer
walk). Sizes are computed from `FIXTURES` rather than written down, so a table
can't drift from what the fixture actually holds.

Injected by the runner as `window.__perfInit` before any script runs, so fixture
I/O never pollutes the `roundtrip` measurement.

**`large` and `xlarge` repeat a section that contains a table and a code block.**
Worth knowing before designing a probe: a caret walked blindly into one of those
fixtures lands in a table cell or a code block about as often as in prose, and
those have very different costs.

# Typing-cost harness (`e2e/perf-typing.mjs`)

Measures the **synchronous dispatch block of one edit**. The bundle wraps
transaction dispatch (`instrumentTransactions` in `webview/perf.ts`) so every
transaction stamps a User-Timing measure: `mdw:tx-apply` for doc-changing ones,
`mdw:tx-select` for selection-only ones. Each covers state apply + view DOM
reconciliation + every plugin view's `update`.

The runner drives **real Playwright keystrokes** into each fixture and reports
the distribution after a discarded warmup burst.

```bash
pnpm build && pnpm perf:typing            # all typing fixtures
node e2e/perf-typing.mjs xlarge           # one fixture
node e2e/perf-typing.mjs --keys 150 --json after.json
node e2e/perf-typing.mjs --compare before.json after.json
```

The same marks work in the webview devtools against any real document
(Performance panel → User Timing), which is how to profile a user-reported slow
file.

## The three columns, and which of them decide

| column | span | gated? |
| --- | --- | --- |
| `median` / `p95` / `max` | `mdw:tx-apply` — a doc-changing edit | ✅ ≥10% AND ≥0.5 ms |
| `caret` | `mdw:tx-select` — a selection-only transaction | ✅ same floors |
| `block` | buffered longtasks summed over the burst | ❌ reported only |

**`caret` exists because selection-only transactions were once dispatched
unmeasured**, on the reasoning that they were "not the cost being tracked". That
left caret movement as the one class of transaction nothing in the repo
measured — no harness, no CI gate, not `block` — and a plugin doing
whole-document work on every arrow key sat there unnoticed as long as that held.
**A cost no instrument reports is a cost that regresses freely.** It is a
separate span so the headline typing median still means exactly what it did and
is never diluted by caret moves.

**`block` is reported and never gated.** Its longtask threshold is a fixed
50 ms, so a slower or loaded machine pushes sub-threshold tasks over it and the
number inflates super-linearly — a null A/B on identical bundles moves it while
dispatch medians hold, and the same burst reads more than an order of magnitude
higher on a CI runner than on a laptop. So it informs — including the "median
improved but block regressed → work was *moved*, not removed" warning — and
never decides. (`--compare` does fail on it; that runs on a machine you control,
CI does not.)

A missing column on either side of an A/B — a merge-base predating the metric —
is **skipped, never read as a zero baseline**, which would make every comparison
against an older commit a 100% regression.

## Where the caret burst runs, and why it matters

It runs on the **already-mounted page**, after the typed burst. Both are
deliberate:

- **Already-mounted**: mount is a large fraction of a big-fixture sample, so
  folding the caret burst into the existing sample costs burst time only rather
  than a second mount.
- **After, never before**: arrow keys walk the caret into whatever the fixture
  holds. Running the caret burst first parked the caret in a code block, and the
  headline typing median silently stopped measuring prose typing — it read
  several times higher and nothing failed. Ordering the two bursts wrongly
  changes what the benchmark means.

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
merge-base build — and `--typing` points it at `node e2e/perf-typing.mjs --ab`.
That comparer:

- **interleaves** head/base bursts per pair; the first pair is discarded as
  warmup, and durations are **pooled** across pairs before taking the median;
- measures **only the gated fixture** (`TYPING_GATED_FIXTURES`). The smaller ones
  cannot inform the decision — a large percentage move on them is still a
  fraction of the absolute floor, and a regression that scales with document
  size shows on the largest fixture first and hardest. Use `pnpm perf:typing`
  for the full spread;
- **double-confirms** — a regression must reproduce across two full passes.

**Escape hatch:** the same `perf-accept` PR label / `Perf-Regression-Accepted:
<reason>` commit trailer as the launch gate, deliberately not a second one.

### When it runs, and what it costs

**It does not run on most PRs.** It lives in its own workflow
(`.github/workflows/typing-perf.yml`) behind a `paths` filter, so a PR touching
only docs, `src/`, or CI config skips it. It fires on `webview/**`, `packages/**`
and the perf harness itself — deliberately wider than "the files that could
regress typing", because narrowing a gate to specific plugins is how it silently
stops covering what it was built for.

It is also **not** in branch protection's required set, on purpose: a required
check that a `paths` filter skips leaves a PR waiting forever on a status that
never arrives.

Three rules about its cost, each learned by getting it wrong first:

- **Size it from a completed CI job, never from a laptop.** Successive estimates
  of this job's runtime were wrong until it was simply run and read. A CI runner
  is roughly twice as slow per keystroke as a dev laptop.
- **Fixture count is a weak lever.** The largest fixture dominates the job, so
  dropping a smaller one buys little. The real levers are its keystroke count
  and the pair count — and, if it ever matters more, mounting the document once
  per side instead of once per sample.
- **It shares nothing with `launch-perf` by design.** The two harnesses must not
  share a runner (see *Run one harness at a time* in `AGENTS.md`); concurrent
  runs produce failures and inflated `block` values that are not real.

### What a green `typing-perf` does and does not prove

The gate is percentage-based with an absolute floor, which makes it **less
sensitive in absolute terms on the slower machine**, and means **a uniform
per-keystroke regression below the floor passes silently**. Adding a flat cost to
every keystroke is a real regression this gate cannot see. It catches *scaling*
regressions — work proportional to document size — not small constant ones.
Don't read a green `typing-perf` as "no cost was added".

# Methodology rules

Each of these has produced a confident, wrong conclusion here at least once.

- **A programmatic dispatch loop is not a proxy for real editing.** Dispatching
  N transactions in one JS task skips the per-frame layout that real input always
  pays, which makes any editing gesture look substantially cheaper than it is.
  Measured that way, a keyboard gesture appeared far more expensive than the
  "same" programmatic one and the difference was attributed to our own plugins;
  the transactions were in fact byte-identical. **Drive real keys, or force a
  layout flush and a frame between dispatches.**
- **Attribute a cost by removing the suspected work and re-measuring**, never
  from a profile's self-time column. A profile is for generating the hypothesis.
- **Instrument the right seam.** ProseMirror binds `spec.state.apply` into a
  `FieldDesc` at `Configuration` construction, so patching the spec afterwards
  is a silent no-op; the live surface is `view.state.config.fields`. And
  `appendTransaction` runs in `applyTransaction`, *outside* the state-field loop,
  so per-field accounting misses it — it can be most of a span while reading as
  unattributed.
- **Split `state.apply` from `updateState` before blaming either.** Different
  edit shapes have opposite profiles: typing is dominated by plugin state,
  structural edits by view reconciliation. A conclusion drawn from one does not
  transfer to the other.
- **Re-measure before quoting any recorded number**, including from this repo's
  own JSON baselines. They record a measurement; they are not one.
- **Give the machine to itself.** A perf capture run alongside anything else is
  not evidence.
