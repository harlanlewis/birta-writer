# Releasing

One rule: **the version is the release time.** Nothing else stores or maintains a version number, so nothing can drift out of alignment.

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

- **Valid semver.** VS Code requires `major.minor.patch` and forbids leading zeros, so `2026.07.14` and the 2-part `20260714.105030` are both rejected — the integer form is not.
- **Strictly increasing.** A later build always sorts higher — across seconds, days, months, and years — so the Marketplace/update ordering is always right.
- **No bookkeeping.** There is no "next version" to decide. The clock decides.

The same string is the git tag (`v2026.714.40000`), the GitHub Release title, and the version stamped into the `.vsix`. `package.json` stays pinned at `0.0.0` on purpose — it is not a source of truth; the release job overwrites it at build time and never commits the change back.

## How a release happens

The `Release` workflow (`.github/workflows/release.yml`) runs **nightly at 04:00 PT** and can also be run by hand (Actions → Release → *Run workflow*).

1. If nothing has landed since the last tag, it stops — no empty releases.
2. It writes end-user highlights (see below), packages the `.vsix`, tags the commit, and publishes a GitHub Release with the `.vsix` attached.
3. A second job, `publish`, then pushes that same `.vsix` to the Marketplace.

That's the whole loop. It is fully automatic; nothing is pushed to `main`.

Publishing is a separate job because it is the only part that needs the `marketplace-publish` environment, and an environment is a policy surface — a required reviewer or a deployment branch rule added to it would stall every job that declares it. Splitting keeps the tag, the GitHub Release, and the downloadable `.vsix` out of reach of a policy only publishing cares about, and means a broken credential costs one skipped job rather than the whole release.

> **DST note:** GitHub cron is UTC-only. `0 11 * * *` is 04:00 during PDT and 03:00 during PST. Change it to `0 12 * * *` to anchor 04:00 to standard time.

## Release notes

`scripts/gen-release-notes.mjs` reads the commit range and the `[Unreleased]` section of `CHANGELOG.md`, then asks Claude to write [cursor.com/changelog](https://cursor.com/changelog)-style notes. Without an `ANTHROPIC_API_KEY` it falls back to a plain categorized commit list, so a release never blocks on the model.

### What goes in — the taxonomy

Two questions decide where a change lands, and they apply to **both** the `CHANGELOG.md` file and the generated notes:

1. **Can a user observe it?** If not — a refactor, an invisible performance or maintainability change, tooling, tests, a dependency bump — it does **not** go in the changelog or the notes; it lives in git history. (A performance win a user can *feel*, like a faster launch, is observable and does go in.)
2. **What kind of observable change is it?** The minimal, general set: **New** (a capability that didn't exist) · **Improved** (an existing one behaves differently or better) · **Fixed** (a user-visible bug resolved), plus **Removed**, **Deprecated**, and **Security** when they occur.

Magnitude and urgency are not extra categories — they're placement: **breaking** changes lead (they force the user to act), the 1–4 headline new features are lifted into **Highlights**, and everything else is ordered by significance within its section.

The two surfaces express the same taxonomy in their own vocabulary:

| Surface | Sections |
|---|---|
| `CHANGELOG.md` (the record) | Keep a Changelog — `Added` / `Changed` / `Fixed` / `Removed` / `Deprecated` / `Security`. Flag breaking changes inline; don't add a Highlights section (the generator lifts those). |
| Generated release notes | `Breaking changes` → `Highlights` → `New` → `Improved` → `Fixed` (→ `Removed` / `Security`). The generator maps `Added`→`New`, `Changed`→`Improved`, and promotes the tentpoles. |

A **first release** is the special case: with no prior public version, every observable change is *New* — there's nothing to Improve or Fix against yet, which is why the initial `[Unreleased]` reads as one consolidated feature list.

## Secrets (repo → Settings → Secrets and variables → Actions)

| Secret              | Effect when set                                   | Today            |
| ------------------- | ------------------------------------------------- | ---------------- |
| `ANTHROPIC_API_KEY` | AI-written highlights instead of a commit list    | recommended      |
| `AZURE_CLIENT_ID`   | Also publishes to the VS Code Marketplace         | set to publish   |
| `AZURE_TENANT_ID`   | Required alongside `AZURE_CLIENT_ID`              | set to publish   |

Until `AZURE_CLIENT_ID` exists, a release builds the downloadable `.vsix` and stops — the "build it, don't publish yet" phase.

Neither value is a secret in the usual sense: they are identifiers, not credentials, and nothing here expires. They are stored as secrets only to keep the tenant out of public logs.

## Marketplace authentication (one-time setup)

Publishing uses **Microsoft Entra ID workload identity federation**, so no token is stored anywhere. GitHub mints a short-lived OIDC token for the release job, Azure trades it for an Entra credential, and `vsce publish --azure-credential` presents that. There is nothing to rotate and nothing to leak.

This is deliberately *not* the flow VS Code's own docs describe. Those instruct you to create an Azure DevOps PAT scoped to **All accessible organizations** — which is exactly what Azure DevOps calls a *global* PAT, and **global PATs are decommissioned on 2026-12-01**. Whether an org-scoped PAT can publish instead is unresolved upstream ([microsoft/vscode#322741](https://github.com/microsoft/vscode/issues/322741)), so the documented path leads to a credential with a known death date.

The setup, once:

1. **A user-assigned managed identity** in the Azure portal — **not an App Registration**. An App Registration is free and needs no subscription, so it looks like the obvious choice; it reportedly authenticates successfully and then fails the publish itself with `InvalidAccessException: The requested operation is not allowed`. (Reported by others, not reproduced here — Microsoft documents this flow only for Azure Pipelines, so the GitHub Actions shape of it is community knowledge. Treat the whole section as verified-by-use once the first publish succeeds, not before.)
2. **A federated credential** on that identity, scenario *GitHub Actions deploying Azure resources*, **entity type Environment**, environment name `marketplace-publish`. Branch or Tag bindings match one literal ref and break on the next release; the release job declares this environment for exactly this reason.
3. **`AZURE_CLIENT_ID` and `AZURE_TENANT_ID`** copied from the identity's *Properties* into repo secrets.
4. **The identity added to the Marketplace publisher as a Contributor.** Its Azure object ID will not be found by the publisher's member search — the only id that search accepts comes from querying `https://app.vssps.visualstudio.com/_apis/profile/profiles/me` *as the identity*, which is what `.github/workflows/entra-identity-probe.yml` exists to do. Run it once by hand, take the `id`, then delete the workflow.

Because the identity lives inside an Azure subscription, **the subscription has to stay active** or it disappears and publishing breaks. The identity itself is free; a pay-as-you-go subscription holding nothing else should bill nothing, but confirm that against current Azure terms rather than trusting this sentence — a lapsed free trial is the one way this otherwise non-expiring setup can still expire.

## Verifying a release

A source audit tells you what the *source* does. It cannot tell you that the published binary was built from that source. Every release closes that gap with a [Sigstore](https://www.sigstore.dev/)-backed **build-provenance attestation** binding the VSIX's digest to this repository, the exact commit, and the workflow run that produced it:

```
gh attestation verify birta-writer-<version>.vsix --repo harlanlewis/birta-writer
```

The Marketplace upload and the GitHub Release asset are the *same file* — the release job packages once and the publish job uploads that artifact rather than rebuilding — so one attestation covers both channels. A `SHA256SUMS.txt` is attached alongside for anyone who just wants to compare two files.

### What is not yet true: byte-reproducibility

**You cannot currently rebuild a tag and get a byte-identical VSIX**, and the published hash is therefore an identifier for that artifact rather than something a third party can independently derive. Measured 2026-07-30: two `pnpm run package` runs from an identical tree produced different archive hashes, with **identical extracted contents and identical entry order** — the only difference was the zip entry mtimes (`…173236` vs `…173240`).

That locates the problem precisely. The *build* is already deterministic; the *container* is not, because `vsce package` stamps each zip entry with the wall clock and exposes no `SOURCE_DATE_EPOCH`-style override. Closing it means normalizing timestamps in the archive after `vsce` writes it, which is real work and is tracked in MAR-130 — don't claim reproducibility until that lands. Until then, provenance answers "did this pipeline build it from that commit", which is the question most people actually have, but not "can I derive these bytes myself".

## Channels, later

There is one channel today. If a pre-release ("insiders") stream is ever wanted, it is a **flag, not a number**: add `--pre-release` to the marketplace publish step for those builds. The CalVer scheme is unchanged — the timestamp keeps stable and pre-release builds correctly ordered on their own, and VS Code routes users by the flag. Do not encode the channel into the version.
