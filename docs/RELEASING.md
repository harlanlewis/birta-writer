# Releasing

One rule: **the version is the release time.** Nothing else stores or maintains a
version number, so nothing can drift out of alignment.

## The version scheme (CalVer)

Every release is stamped from the clock, in `America/Los_Angeles`:

```
YYYY . (month*100 + day) . (hour*10000 + minute*100 + second)
```

| Released at (PT)      | Version          |
| --------------------- | ---------------- |
| 2026-07-14 04:00:00   | `2026.714.40000` |
| 2026-08-09 08:07:06   | `2026.809.80706` |
| 2026-12-31 23:59:59   | `2026.1231.235959` |

Each field is a plain integer, which buys three properties at once:

- **Valid semver.** VS Code requires `major.minor.patch` and forbids leading
  zeros, so `2026.07.14` and the 2-part `20260714.105030` are both rejected —
  the integer form is not.
- **Strictly increasing.** A later build always sorts higher — across seconds,
  days, months, and years — so the Marketplace/update ordering is always right.
- **No bookkeeping.** There is no "next version" to decide. The clock decides.

The same string is the git tag (`v2026.714.40000`), the GitHub Release title,
and the version stamped into the `.vsix`. `package.json` stays pinned at `0.0.0`
on purpose — it is not a source of truth; the release job overwrites it at build
time and never commits the change back.

## How a release happens

The `Release` workflow (`.github/workflows/release.yml`) runs **nightly at 04:00
PT** and can also be run by hand (Actions → Release → *Run workflow*).

1. If nothing has landed since the last tag, it stops — no empty releases.
2. It writes end-user highlights (see below), packages the `.vsix`, tags the
   commit, and publishes a GitHub Release with the `.vsix` attached.

That's the whole loop. It is fully automatic; nothing is pushed to `main`.

> **DST note:** GitHub cron is UTC-only. `0 11 * * *` is 04:00 during PDT and
> 03:00 during PST. Change it to `0 12 * * *` to anchor 04:00 to standard time.

## Release notes

`scripts/gen-release-notes.mjs` reads the commit range and the `[Unreleased]`
section of `CHANGELOG.md`, then asks Claude to write
[cursor.com/changelog](https://cursor.com/changelog)-style notes. Without an
`ANTHROPIC_API_KEY` it falls back to a plain categorized commit list, so a
release never blocks on the model.

### What goes in — the taxonomy

Two questions decide where a change lands, and they apply to **both** the
`CHANGELOG.md` file and the generated notes:

1. **Can a user observe it?** If not — a refactor, an invisible performance or
   maintainability change, tooling, tests, a dependency bump — it does **not**
   go in the changelog or the notes; it lives in git history. (A performance win
   a user can *feel*, like a faster launch, is observable and does go in.)
2. **What kind of observable change is it?** The minimal, general set:
   **New** (a capability that didn't exist) · **Improved** (an existing one
   behaves differently or better) · **Fixed** (a user-visible bug resolved),
   plus **Removed**, **Deprecated**, and **Security** when they occur.

Magnitude and urgency are not extra categories — they're placement: **breaking**
changes lead (they force the user to act), the 1–4 headline new features are
lifted into **Highlights**, and everything else is ordered by significance
within its section.

The two surfaces express the same taxonomy in their own vocabulary:

| Surface | Sections |
|---|---|
| `CHANGELOG.md` (the record) | Keep a Changelog — `Added` / `Changed` / `Fixed` / `Removed` / `Deprecated` / `Security`. Flag breaking changes inline; don't add a Highlights section (the generator lifts those). |
| Generated release notes | `Breaking changes` → `Highlights` → `New` → `Improved` → `Fixed` (→ `Removed` / `Security`). The generator maps `Added`→`New`, `Changed`→`Improved`, and promotes the tentpoles. |

A **first release** is the special case: with no prior public version, every
observable change is *New* — there's nothing to Improve or Fix against yet, which
is why the initial `[Unreleased]` reads as one consolidated feature list.

## Secrets (repo → Settings → Secrets and variables → Actions)

| Secret              | Effect when set                                   | Today            |
| ------------------- | ------------------------------------------------- | ---------------- |
| `ANTHROPIC_API_KEY` | AI-written highlights instead of a commit list    | recommended      |
| `VSCE_PAT`          | Also publishes to the VS Code Marketplace         | leave unset      |

Until `VSCE_PAT` exists, a release builds the downloadable `.vsix` and stops —
the "build it, don't publish yet" phase.

## Channels, later

There is one channel today. If a pre-release ("insiders") stream is ever wanted,
it is a **flag, not a number**: add `--pre-release` to the marketplace publish
step for those builds. The CalVer scheme is unchanged — the timestamp keeps
stable and pre-release builds correctly ordered on their own, and VS Code routes
users by the flag. Do not encode the channel into the version.
