# Performance harnesses

Two runners share this directory's page stub (`index.html`) and fixtures (`fixtures.mjs`): the launch harness (`e2e/perf.mjs`) and the typing harness (`e2e/perf-typing.mjs`).

> This file documents how the harnesses work, not what they last measured. Absolute timings belong in the commit or ticket that changed them. A figure written here reads as current forever and is wrong the moment anything lands. Thresholds and budgets are the exception: those are configuration, they live in `verdict.mjs` / `bundle-baseline.json`, and the numbers quoted below are meant to match them. If they disagree, the code is right.

# Launch-performance harness

Measures webview cold-start (open `.md` → editor painted) by driving the real built bundle (`dist/webview.js` + `dist/webview.css`) in headless Chromium and reading the `mdw:` User-Timing marks the bundle stamps during boot (see `webview/perf.ts`). Same production code the extension ships, minus VS Code's chrome and message host (stubbed by `index.html`).

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
| `toc` / `toolbar` | `*-start` → `*-end` | those two components' construction |
| `rtp` | `rtp-start` → `rtp-end` | **post-paint**: `computeRoundTripProtection` (re-serializes the doc) |
| `proofread` | `proofread-start` → `proofread-end` | **post-paint**: the first whole-document style/lint pass |

`launch` minus the sum of the launch spans is the browser's bundle fetch+parse cost (the eager JS/CSS download before `eval-start`).

`paint` (`create-end` → `editor-painted`) is the easiest span to overlook. It is ProseMirror's first DOM build plus style/layout/paint, *including any work a plugin schedules from its `view()` onto the frames before that paint*. Work moved in front of first paint is invisible to every other span, so if a plugin schedules its own rAF at mount, suspect this one.

### The post-paint spans (`POST_PAINT_SPANS`)

`rtp` and `proofread` fall after `editor-painted`, so they are not part of `launch` and a move in one can never explain a launch delta. They are measured anyway, because deferring work past the last mark does not make it free: on the big fixtures both block the main thread shortly after first paint, squarely the window a user's first keystroke or scroll lands in. `pnpm perf large` prints what they currently cost, which is the only honest way to state it here.

`rtp` was worse than unmeasured. It sat in this table and in `SPANS` the whole time, reading `–` on every run, because its marks were deleted along with the eager call site when round-trip protection moved off the mount path. A dash reads exactly like "cheap". That is what the unattributed post-paint longtask turned out to be (MAR-311): not new work, but work whose attribution had been removed.

Consequences for anyone touching this:

- Both modes wait for these marks, and the A/B gates on them (MAR-314). The wait used to be measure-mode only, because a merge-base bundle can predate a mark entirely and would then pay the settle timeout on every sample. The A/B now learns each side's marks from the warmup pair it already discards and drops whatever that side never stamps, so an unmarked bundle costs one timeout per fixture rather than one per sample. A span the base does not carry ABSTAINS rather than gating: absent is not zero, and the alternative was waiting for the calendar until every plausible merge-base carried the marks. `pnpm perf` prints a `⚠` naming any post-paint mark that never arrived, and the A/B prints every abstention, so an unstamped span is loud rather than a dash.
- The post-paint floors are both wider than launch's 3% / 10 ms, and they are calibrated from CI rather than from a developer machine. That distinction is the whole story: on an idle laptop these spans are steady enough to justify floors near launch's, and floors set that way were cleared by a null CI run on byte-identical bundles. Re-derive them from the `launch-perf` job of a PR that changes no bundled code, re-run a few times on the same commit, and read the spread. `verdict.test.mjs` asserts both directions and asserts that a span which doubles still fires, so this bullet and the constants cannot drift apart, and a future widening cannot quietly stop catching the thing the gate is for.
- `checks.mjs` is the real guard. `pnpm test:e2e` drives this page and fails if either span stops being stamped, or lands before first paint, or if the fixtures stop tripping the style check. Nothing in CI catches those.

## The A/B gate (how the optimization loop decides)

Absolute timings drift with machine load, so the gate is a same-session A/B:

```bash
node esbuild.mjs --production --metafile && pnpm perf --json before.json
node e2e/perf-bundle.mjs --json bundle-before.json
# ...make the change, rebuild...
node esbuild.mjs --production --metafile && pnpm perf --json after.json
node e2e/perf-bundle.mjs --json bundle-after.json
pnpm perf --compare before.json after.json            # launch verdict
node e2e/perf-bundle.mjs --compare bundle-before.json bundle-after.json  # eager-bytes verdict
```

- improved: median `launch` down ≥3% AND ≥10 ms on ≥1 fixture, nothing up past the same floors.
- regressed: any fixture up >3% AND >10 ms → do not commit.
- Eager bytes are gated by a budget ceiling (`pnpm perf:bundle --check`), not a ratchet; see `e2e/perf-bundle.mjs`.

Removing eager bytes therefore produces no CI signal on its own: `--check` just passes with more room, and the space is immediately re-spendable. Finish a bytes win with `--set-budget` so the ratchet sticks.

`baseline.json` is a checked-in historical reference, not the gate, and nothing reads it. It records a measurement; it is not one. Its figures also predate MAR-310's fixture reseeding, so the documents behind them no longer exist. Rebuild and re-run rather than quoting it.

## Automated launch gate (`pnpm perf:ab`, CI job `launch-perf`)

The manual A/B above is for the optimization loop. The same comparison runs automatically on every PR and is a required, blocking check, because boot time is a first-class metric and a same-session delta is trustworthy where an absolute threshold isn't.

```bash
pnpm perf:ab                       # vs origin/main: builds merge-base + head, compares
node e2e/perf-ab.mjs --base origin/main --runs 9 --json ab.json
PERF_ACCEPT="reason" pnpm perf:ab  # accept an intentional launch cost locally
```

`e2e/perf-ab.mjs` builds the merge-base (in a detached git worktree, with that commit's own deps) and the head into `dist-base/` and `dist-head/`, then calls `node e2e/perf.mjs --ab dist-base dist-head`, which:

- interleaves head/base measurements per pair so slow machine drift cancels;
- gates only the strong-signal fixtures (`GATED_FIXTURES` in `verdict.mjs`); the small ones are reported but never fail;
- double-confirms: a regression must reproduce on the same fixture across two full passes before the job fails, killing transient CI false reds.

Escape hatch for an intentional launch cost: add the `perf-accept` PR label or a `Perf-Regression-Accepted: <reason>` commit trailer; the gate reports the regression but doesn't block (CI passes it through as `PERF_ACCEPT`).

`dist-base/` and `dist-head/` are left in the working tree; the runner clears them before rebuilding, never after. They are gitignored, and `.vscodeignore` does not honour `.gitignore`, so both are listed there *and* in `scripts/check-vsix.mjs`'s banned set: without that, running an A/B locally and then packaging silently ships two extra copies of the bundle in the VSIX.

## Fixtures

Generated deterministically (no `Date`/`Math.random`) in `fixtures.mjs`, so a run is reproducible: `tiny`, `medium` (mixed prose/lists/tables/code), `large` (the same section shape repeated), `code-heavy` (many languages + mermaid), `math` (KaTeX), `link-heavy` (bare autolinks exercising the embed recognizer walk), `html-heavy` (raw HTML atoms, block and inline, exercising the html NodeView's per-atom mount path), `realistic` (the working-file construct mix: wide tables, diagrams, unwrapped paragraphs). Sizes are computed from `FIXTURES` rather than written down, so a table can't drift from what the fixture actually holds.

Injected by the runner as `window.__perfInit` before any script runs, so fixture I/O never pollutes the `roundtrip` measurement.

`large` and `xlarge` repeat a section that contains a table and a code block. Worth knowing before designing a probe: a caret walked blindly into one of those fixtures lands in a table cell or a code block about as often as in prose, and those have very different costs.

## Heavy fixtures (`HEAVY_FIXTURES`)

Two documents are exported separately as a by-name pool: either runner can be pointed at one explicitly, and neither is in `FIXTURES`, so neither is ever measured by `pnpm perf` or by the `launch-perf` gate. `xlarge` remains a member of `TYPING_FIXTURES` exactly as it was, so `pnpm perf:typing` still sweeps it; what is new is that the launch runner can open it at all.

```bash
node e2e/perf.mjs huge-outline          # launch spans on a working-file-sized outline; the run prints its size
node e2e/perf-typing.mjs huge-outline   # per-keystroke dispatch on the same
node e2e/perf.mjs xlarge                # the largest typing fixture, cold start
```

| fixture | shape |
| --- | --- |
| `xlarge` | about three times `large`, all `richSection`, the typing-lag tail |
| `huge-outline` | about eight times `large`: ~440 headings across three levels, ~3000 list items, unwrapped paragraphs, and no tables, code, images, raw HTML, math or diagrams |

Neither size is written here; `fixtures.test.mjs` holds each to a band, and the runner prints what it opened.

They exist because the harnesses could not open a document the size of the ones users complain about. `large`, at 96 KB, was the biggest cold start anything here could measure: `e2e/perf.mjs` resolved a fixture name against `FIXTURES` alone, so `xlarge` had sat in `TYPING_FIXTURES` for a long time with no way to launch it. Both of the defects fixed in #421 scale with document size, and neither was found by an instrument in this repository. They were found by hand, on a file eight times larger than anything the harnesses could reach.

`huge-outline` is a SHAPE and not only a size, and scaling an existing fixture would not have produced it. Every sized fixture here is built from `richSection`, which carries a table and a fenced code block per section, so the same byte count would hold ~800 of each and its cost would be dominated by two NodeViews and the highlighter. The motivating file contains none of those three constructs and was still seconds to open and seconds to answer a keystroke. `webview/__tests__/perfFixtureConstructs.test.ts` asserts the absence through the real parser, and the presence of the headings and list items alongside it, because a parse that produced nothing would satisfy every absence on its own.

Why a third set rather than an ungated eighth fixture: `launch-perf` is a required, blocking check that measures every entry of `FIXTURES` on both sides of the A/B, twice when a regression has to be confirmed, and `perf:typing` is the most expensive check in the repo and is dominated by its largest fixture. Report-only avoids the verdict and not the cost. A document that size in either default sweep would spend minutes of every PR's critical path.

### The nightly count gate (`pnpm perf:counts`, CI job `perf-nightly`)

What holds the heavy fixtures instead is `.github/workflows/perf-nightly.yml`: it builds `main` once a day, runs `node e2e/perf.mjs` on both heavy fixtures and `node e2e/perf-typing.mjs huge-outline`, and gates on the work counts the typing run collected.

```bash
node esbuild.mjs --production --metafile
node e2e/perf-typing.mjs huge-outline --json typing.json
node e2e/perf-counts.mjs --check typing.json        # the nightly's verdict
node e2e/perf-counts.mjs --set-budget typing.json   # re-record every ceiling from this run, plus headroom
```

Counts, never durations, and the reason is the one that keeps `block` ungated above: a nightly has no sibling build to interleave against, so a duration would be a bare absolute read on a shared runner, while a `countWork` total (`webview/perf.ts`) is the same number on a loaded runner and an idle laptop. The ceilings live in `heavy-budget.json` and are a contract the way `eagerBudget` is: `--set-budget` writes measured plus headroom and nothing else, `counts.test.mjs` fails if a measured figure creeps in. The headroom covers the burst's one non-determinism, a runner stall past the proofread debounce landing one extra rescan; a regression the gate exists for is a multiple of the ceiling.

Not every count can hold a ceiling. A counter a TIMER stamps, such as the sync pipeline's `merge` (one pass per max-wait window the burst spans), follows runner speed the way a duration does, and a ceiling on it would make a slow night red. The budget's `reported` list names those counters with the reason each cannot be gated; they are printed beside the gated ones and never fail on their value. `--set-budget` carries that list over untouched, because it is a judgement about what a counter measures and no run can re-derive it.

Three failures, each a different defect. `OVER` is a pass that became proportional to the document again. `unbudgeted` is a new counter on neither list, refused on purpose: a `countWork` call reaches this gate by existing, and the PR that adds one either records its ceiling or places it in `reported` with the reason. `missing` is a listed counter the run did not stamp, and it fails rather than abstains because a dash reads exactly like "cheap" (MAR-311). The durations go into the run summary for a person to read, alongside the counts.

Two properties of `huge-outline` are load-bearing and easy to lose in a rewrite. Its heading DENSITY, roughly one per 1.7 KB, is what mount-time id work scales with. And its heading text REPEATS, roughly two in three, because `headingIdAssigner`'s `-#N` dedup counter only runs when two headings slug the same, and every other fixture numbers its headings uniquely. `fixtures.test.mjs` asserts both, along with the size band, so an edited section that is never re-derived fails rather than quietly becoming a different document.

The prose fixtures deliberately trip the style check (`STYLE_SENTENCES`); the non-prose ones deliberately do not. `birta.proofreading.enabled` defaults to `true`, so every measured launch has always paid a proofread scan, but until MAR-310 no fixture contained a phrase the shipped word lists match, and `medium` produced 0 `.pf-style-hit` elements. The harness was measuring the matcher's traversal of prose that matches nothing, and never the decoration build, which is the half that scales with how much a document actually trips. A green gate over that fixture set was evidence of non-interference, not of coverage. `code-heavy`, `math`, `link-heavy` and `html-heavy` stay unseeded: they exist to isolate the highlighter, the KaTeX path, the embed recognizer and the html NodeView, and prose seeded into them would blur what they isolate. That set is derived from `FIXTURES` in `fixtures.test.mjs` rather than listed, so a fixture added later cannot skip the bar.

MAR-367 is the same shape one construct over, and it is why `html-heavy` exists: no fixture produced a single `html` node, so the gate could not see any cost in the html NodeView's mount path, which is per atom and runs a sibling walk, a sanitize and a focusable sweep for each one. A grep cannot answer whether a fixture carries the construct, because a raw tag inside a fenced code block is a code block and a tag inside a mermaid label is a diagram; `webview/__tests__/perfFixtureConstructs.test.ts` counts `html` nodes through the real parser instead, and enumerates every fixture so the blind spot is visible rather than inferred. `html-heavy` is deliberately NOT gated. The A/B already measures every fixture and reports the ungated ones, so gating costs no runner time on a green run (a gated regression does buy a second confirming pass); what it costs is a blocking verdict on a fixture built to isolate one NodeView, and whether that path should be able to fail a PR on its own is a call about what the gate is for rather than a detail to slip into an unrelated change. `realistic` carries a smaller seed of the same two branches, so the gate does see the path.

Seeding grew each section by ~215 characters, so the section counts were cut (`medium` 18→14, `large` 140→108, `xlarge` 440→343) to hold the documented byte sizes within 1%. A fixture's identity is its size, and the typing job, the most expensive check in the repo, is dominated by its largest fixture.

`index.html` reads two flags from the query string so a default-valued feature can be A/B'd against an otherwise identical bundle: `?lineNumbers=1` turns the (default-off) gutter on, `?proofreading=0` turns proofreading off. Without them a default-off feature is never measured and a default-on one can never be isolated.

# Typing-cost harness (`e2e/perf-typing.mjs`)

Measures the synchronous dispatch block of one edit. The bundle wraps transaction dispatch (`instrumentTransactions` in `webview/perf.ts`) so every transaction stamps a User-Timing measure: `mdw:tx-apply` for doc-changing ones, `mdw:tx-select` for selection-only ones. Each covers state apply + view DOM reconciliation + every plugin view's `update`.

The runner drives real Playwright keystrokes into each fixture and reports the distribution after a discarded warmup burst.

```bash
pnpm build && pnpm perf:typing            # all typing fixtures
node e2e/perf-typing.mjs xlarge           # one fixture
node e2e/perf-typing.mjs --keys 150 --json after.json
node e2e/perf-typing.mjs --compare before.json after.json
```

The same marks work in the webview devtools against any real document (Performance panel → User Timing), which is how to profile a user-reported slow file.

## The columns, and which of them decide

| column | span | gated? |
| --- | --- | --- |
| `median` / `p95` / `max` | `mdw:tx-apply`: a doc-changing edit | ✅ ≥10% AND ≥0.5 ms |
| `caret` | `mdw:tx-select`: a selection-only transaction | ✅ same floors |
| `rescan` | `mdw:proofread-rescan`: the burst's debounced proofread rescan | ❌ reported only |
| `block` | buffered longtasks summed over the burst | ❌ reported only |

`caret` exists because selection-only transactions were once dispatched unmeasured, on the reasoning that they were "not the cost being tracked". That left caret movement as the one class of transaction nothing in the repo measured (no harness, no CI gate, not `block`), and a plugin doing whole-document work on every arrow key sat there unnoticed as long as that held. A cost no instrument reports is a cost that regresses freely. It is a separate span so the headline typing median still means exactly what it did and is never diluted by caret moves.

`rescan` is reported and never gated (MAR-314). Typing schedules a whole-document proofread rescan on a 350 ms trailing debounce, so it fires exactly once, after the burst, outside `tx-apply` and previously visible only through `block`. Measure mode waits for it (which also keeps its meta dispatch out of the caret pool) and reports its `mdw:proofread-rescan` duration; one sample per capture is attribution, not stability evidence, so it never decides. A/B mode does not collect it at all: the merge-base bundle may predate the measure, and waiting would cost the full timeout on every base sample, the same ADR that keeps the launch A/B from waiting on post-paint marks.

`block` is reported and never gated. Its longtask threshold is a fixed 50 ms, so a slower or loaded machine pushes sub-threshold tasks over it and the number inflates super-linearly: a null A/B on identical bundles moves it while dispatch medians hold, and the same burst reads more than an order of magnitude higher on a CI runner than on a laptop. So it informs, including the "median improved but block regressed → work was *moved*, not removed" warning, and never decides. (`--compare` does fail on it; that runs on a machine you control, CI does not.)

A missing column on either side of an A/B, such as a merge-base predating the metric, is skipped, never read as a zero baseline, which would make every comparison against an older commit a 100% regression.

## Where the caret burst runs, and why it matters

It runs on the already-mounted page, after the typed burst. Both are deliberate:

- Already-mounted: mount is a large fraction of a big-fixture sample, so folding the caret burst into the existing sample costs burst time only rather than a second mount.
- After, never before: arrow keys walk the caret into whatever the fixture holds. Running the caret burst first parked the caret in a code block, and the headline typing median silently stopped measuring prose typing: it read several times higher and nothing failed. Ordering the two bursts wrongly changes what the benchmark means.

## Automated typing gate (`pnpm perf:typing:ab`, CI job `typing-perf`)

`--compare` diffs two JSONs you captured by hand. `--ab` is the stronger form and the one CI runs. It interleaves both bundles in one browser session, so machine drift cancels within each pair rather than across a stash-and-rebuild.

```bash
pnpm perf:typing:ab                          # vs origin/main: builds merge-base + head, compares
node e2e/perf-ab.mjs --typing --runs 5 --json typing-ab.json
PERF_ACCEPT="reason" pnpm perf:typing:ab     # accept an intentional typing cost locally
```

`e2e/perf-ab.mjs` is shared with the launch gate (same detached-worktree merge-base build), and `--typing` points it at `node e2e/perf-typing.mjs --ab`. That comparer:

- interleaves head/base bursts per pair; the first pair is discarded as warmup, and durations are pooled across pairs before taking the median;
- measures only the gated fixture (`TYPING_GATED_FIXTURES`). The smaller ones cannot inform the decision: a large percentage move on them is still a fraction of the absolute floor, and a regression that scales with document size shows on the largest fixture first and hardest. Use `pnpm perf:typing` for the full spread;
- double-confirms: a regression must reproduce across two full passes.

Escape hatch: the same `perf-accept` PR label / `Perf-Regression-Accepted: <reason>` commit trailer as the launch gate, deliberately not a second one.

### When it runs, and what it costs

It does not run on most PRs. It lives in its own workflow (`.github/workflows/typing-perf.yml`) behind a `paths` filter, so a PR touching only docs, `src/`, or CI config skips it. It fires on `webview/**`, `packages/**` and the perf harness itself, deliberately wider than "the files that could regress typing", because narrowing a gate to specific plugins is how it silently stops covering what it was built for.

It is also not in branch protection's required set, on purpose: a required check that a `paths` filter skips leaves a PR waiting forever on a status that never arrives.

Three rules about its cost, each learned by getting it wrong first:

- Size it from a completed CI job, never from a laptop. Successive estimates of this job's runtime were wrong until it was simply run and read. A CI runner is roughly twice as slow per keystroke as a dev laptop.
- Fixture count is a weak lever. The largest fixture dominates the job, so dropping a smaller one buys little. The real levers are its keystroke count and the pair count, and if it ever matters more, mounting the document once per side instead of once per sample.
- It shares nothing with `launch-perf` by design. The two harnesses must not share a runner (see *Run one harness at a time* in `AGENTS.md`); concurrent runs produce failures and inflated `block` values that are not real.

### What a green `typing-perf` does and does not prove

The gate is percentage-based with an absolute floor, which makes it less sensitive in absolute terms on the slower machine, and means a uniform per-keystroke regression below the floor passes silently. Adding a flat cost to every keystroke is a real regression this gate cannot see. It catches *scaling* regressions (work proportional to document size), not small constant ones. Don't read a green `typing-perf` as "no cost was added".

# Methodology rules

Each of these has produced a confident, wrong conclusion here at least once.

- A programmatic dispatch loop is not a proxy for real editing. Dispatching N transactions in one JS task skips the per-frame layout that real input always pays, which makes any editing gesture look substantially cheaper than it is. Measured that way, a keyboard gesture appeared far more expensive than the "same" programmatic one and the difference was attributed to our own plugins; the transactions were in fact byte-identical. Drive real keys, or force a layout flush and a frame between dispatches.
- Attribute a cost by removing the suspected work and re-measuring, never from a profile's self-time column. A profile is for generating the hypothesis.
- Instrument the right seam. ProseMirror binds `spec.state.apply` into a `FieldDesc` at `Configuration` construction, so patching the spec afterwards is a silent no-op; the live surface is `view.state.config.fields`. And `appendTransaction` runs in `applyTransaction`, *outside* the state-field loop, so per-field accounting misses it: it can be most of a span while reading as unattributed.
- Split `state.apply` from `updateState` before blaming either. Different edit shapes have opposite profiles: typing is dominated by plugin state, structural edits by view reconciliation. A conclusion drawn from one does not transfer to the other.
- Re-measure before quoting any recorded number, including from this repo's own JSON baselines. They record a measurement; they are not one.
- Give the machine to itself. A perf capture run alongside anything else is not evidence.
