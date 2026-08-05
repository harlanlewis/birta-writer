# Releasing

One rule: **the version is the release date.** Nothing else stores or maintains a version number, so nothing can drift out of alignment.

## The version scheme (CalVer)

Every release is stamped from the date, in `America/Los_Angeles`:

```
YYYY . (month*100 + day) . (releases already cut that day)
```

| Released on (PT)          | Version           |
| ------------------------- | ----------------- |
| 2026-07-14, nightly       | `2026.714.0`      |
| 2026-07-14, re-cut by hand| `2026.714.1`      |
| 2026-08-09, nightly       | `2026.809.0`      |
| 2026-12-31, nightly       | `2026.1231.0`     |

Each field is a plain integer, which buys three properties at once:

- **Valid semver.** VS Code requires `major.minor.patch` and forbids leading zeros, so `2026.07.14` and the 2-part `20260714.105030` are both rejected — the integer form is not.
- **Strictly increasing.** A later build always sorts higher — across same-day re-cuts, days, months, and years — so the Marketplace/update ordering is always right. The counter resets to `0` only when the day changes, which also changes the minor field; semver compares minor before patch, so a reset can never order a new release below an old one.
- **No bookkeeping.** There is no "next version" to decide. The date decides, and the job counts.

The same string is the git tag (`v2026.714.0`), the GitHub Release title, and the version stamped into the `.vsix`. `package.json` stays pinned at `0.0.0` on purpose — it is not a source of truth; the release job overwrites it at build time and never commits the change back.

**The patch field used to be a time-of-day stamp** (`hour*10000 + minute*100 + second`, e.g. `2026.730.54523`) — changed 2026-07-31. Sub-day uniqueness was never needed: the cron fires once a night and `concurrency: release` serializes it against a manual dispatch. It cost readability for nothing. The changeover was one-way, and the job handles it without special-casing: when the newest tag is from today it resumes from that tag's patch rather than starting at `0`, so the final timestamped version was followed by `2026.730.54524` and then `2026.731.0`.

## How a release happens

The `Release` workflow (`.github/workflows/release.yml`) runs **nightly at 04:00 PT** and can also be run by hand (Actions → Release → *Run workflow*).

1. If nothing has landed since the last tag, it stops — no empty releases.
2. It runs `pnpm typecheck && pnpm test`. `vsce package` only runs a build, and the release cron fires on its own schedule regardless of whether CI for the newest commit has finished, or finished green — so the job proves the commit for itself rather than trusting a status lookup that may be pending or absent.
3. It rolls `CHANGELOG.md` (see below), writes end-user highlights, packages the `.vsix`, tags the commit, and publishes a GitHub Release with the `.vsix` attached.
4. A second job, `publish`, then pushes that same `.vsix` to the Marketplace.
5. Finally it commits the rolled `CHANGELOG.md` back to `main`.

That's the whole loop. It is fully automatic; the one thing it writes to `main` is that changelog commit, and it is the last step, so it can never fail a release that has already shipped.

Publishing is a separate job because it is the only part that needs the `marketplace-publish` environment, and an environment is a policy surface — a required reviewer or a deployment branch rule added to it would stall every job that declares it. Splitting keeps the tag, the GitHub Release, and the downloadable `.vsix` out of reach of a policy only publishing cares about, and means a broken credential costs one skipped job rather than the whole release.

> **DST note:** GitHub cron is UTC-only. `0 11 * * *` is 04:00 during PDT and 03:00 during PST. Change it to `0 12 * * *` to anchor 04:00 to standard time.

## The changelog

Entries are written under `## [Unreleased]` as work lands. The release job runs `scripts/stamp-changelog.mjs`, which renames that heading to the version being cut and opens a fresh empty one, then commits the result to `main`. **No version heading is ever written by hand**, and `[Unreleased]` holds only what has not shipped yet.

The heading's date is derived from the CalVer version rather than read from a clock, so the two cannot disagree — a second clock read could land on the other side of midnight from the one that produced the version.

Two consequences worth knowing:

- **A release with no user-visible changes still gets a heading**, reading `_No user-visible changes; internal work only._`. Commits land that a user cannot observe; `2026.802.0` was one. Giving it a heading keeps the version sequence gap-free instead of implying the release never happened.
- **The tag points at the pre-stamp commit**, so a tagged tree's `CHANGELOG.md` is one heading behind the artifact built from it. This is the same relationship `package.json` has always had — stamped at build time, never committed back — and it is why the release guard filters its own stamp commits out by subject (`release: stamp …`) rather than depending on where the tag sits. Change that subject without changing the guard in `release.yml` and the nightly will cut an empty release every night, each one stamping another heading; `shared/__tests__/releaseWorkflow.test.ts` checks the two against each other.

Until 2026-08-05 none of this happened: no release had ever rolled `[Unreleased]`, so the changelog shipped inside the VSIX — which is what the Marketplace renders on its **Changelog** tab — led with a section titled "Unreleased" above a version history that stopped at `0.2.3`. Those pre-Marketplace semver releases were never publicly installable and now live in [`CHANGELOG-PRE-MARKETPLACE.md`](CHANGELOG-PRE-MARKETPLACE.md), which `.vscodeignore` keeps out of the VSIX.

## Release notes

`scripts/gen-release-notes.mjs` reads the commit range and **this version's** section of `CHANGELOG.md` (falling back to `[Unreleased]` when run by hand against an unstamped tree), then asks Claude to write [cursor.com/changelog](https://cursor.com/changelog)-style notes. Without an `ANTHROPIC_API_KEY` it falls back to a plain categorized commit list, so a release never blocks on the model.

It reads the stamped section for a reason: reading `[Unreleased]` unconditionally is what made four consecutive nightly releases re-announce the entire product, because nothing ever rolled that section and it had accumulated every entry ever written. The `2026.804.0` notes ran to 112 lines of features that had shipped weeks earlier.

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
| `RELEASE_TOKEN`     | Commits the rolled `CHANGELOG.md` back to `main`  | needed to stamp  |

Until `AZURE_CLIENT_ID` exists, a release builds the downloadable `.vsix` and stops — the "build it, don't publish yet" phase.

`AZURE_CLIENT_ID` and `AZURE_TENANT_ID` are not secrets in the usual sense: they are identifiers, not credentials, and nothing about them expires. They are stored as secrets only to keep the tenant out of public logs.

`RELEASE_TOKEN` **is** a credential — a fine-grained personal access token scoped to this repository alone, `Contents: read and write`, set to **No expiration**. It exists because `main` requires a pull request from anyone but an admin, and `GITHUB_TOKEN` is not one; branch protection has `enforce_admins` off, so an admin-owned token pushes directly and no bypass rule is involved. (CI cannot open a PR instead: pull requests created with `GITHUB_TOKEN` do not trigger workflows, so the required checks would never run and it could never merge.) Without it the release still stamps the packaged changelog and writes correct notes — only the commit back to `main` is skipped, and the next night's heading simply spans two days.

**Check the first run after adding it.** The push step is `continue-on-error`, so a rejected push shows up as a green release with no stamp commit rather than as a failure — read the step's log the first morning rather than inferring from the release having succeeded. Two things are only proven by that run: that an admin-owned token does bypass both the pull-request requirement and the required status checks (documented behaviour of `enforce_admins: false`, not verified here), and that the rebase-before-push handles a PR landing mid-run. Note also that the stamp commit is a push to `main`, so it triggers a CI run of its own each night; `launch-perf` short-circuits on it, and the rest is the ordinary cost of a docs-only commit.

## Marketplace authentication (one-time setup)

Publishing uses **Microsoft Entra ID workload identity federation**, so no token is stored anywhere. GitHub mints a short-lived OIDC token for the release job, Azure trades it for an Entra credential, and `vsce publish --azure-credential` presents that. There is nothing to rotate and nothing to leak.

This is deliberately *not* the flow VS Code's own docs describe. Those instruct you to create an Azure DevOps PAT scoped to **All accessible organizations** — which is exactly what Azure DevOps calls a *global* PAT, and **global PATs are decommissioned on 2026-12-01** ([Azure DevOps blog](https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/): creation is unblocked until then, existing tokens stop working after). Whether an org-scoped PAT can publish instead is unresolved upstream ([microsoft/vscode#322741](https://github.com/microsoft/vscode/issues/322741) — open, zero comments, no milestone as of 2026-08-04), so the documented path leads to a credential with a known death date. The docs still instruct you to pick that scope while carrying the retirement banner on the same page.

**This setup should be temporary — the exit from Azure is being built.** `vsce publish --oidc` is trusted publishing in the sense npm and PyPI mean it: the GitHub Actions OIDC token is exchanged directly at the Marketplace's `POST /_apis/gallery/token` for a short-lived credential, with no Azure resource anywhere in the picture, and no fallback to a PAT. It merged 2026-07-23 ([microsoft/vscode-vsce#1291](https://github.com/microsoft/vscode-vsce/pull/1291)) but ships only on the `next` channel (`3.9.3-3`; `latest` is `3.9.2`), and nothing confirms the Marketplace exposes the trusted-publishing policy it requires — the question asked on that PR on 2026-07-30 is unanswered and [microsoft/vsmarketplace#1422](https://github.com/microsoft/vsmarketplace/issues/1422) is still open. When both land the migration is small: drop the `azure/login` step, swap `--azure-credential` for `--oidc`, register the policy once, delete the subscription. `id-token: write` and the `marketplace-publish` environment are already there.

The setup, once:

1. **A user-assigned managed identity** in the Azure portal — **not an App Registration**. An App Registration is free and needs no subscription, so it looks like the obvious choice; it reportedly authenticates successfully and then fails the publish itself with `InvalidAccessException: The requested operation is not allowed`. (Reported by others, not reproduced here — Microsoft documents this flow only for Azure Pipelines, so the GitHub Actions shape of it is community knowledge. The one upstream report, [microsoft/vscode-vsce#1023](https://github.com/microsoft/vscode-vsce/issues/1023), was closed as not planned with no technical answer, so "unverified" is where it stays. **This section is now verified by use**: the first publish succeeded on 2026-07-31 and every nightly since has published on the same path.)
2. **A federated credential** on that identity, scenario *GitHub Actions deploying Azure resources*, **entity type Environment**, environment name `marketplace-publish`. Branch or Tag bindings match one literal ref and break on the next release; the release job declares this environment for exactly this reason.
3. **`AZURE_CLIENT_ID` and `AZURE_TENANT_ID`** copied from the identity's *Properties* into repo secrets.
4. **The identity added to the Marketplace publisher as a Contributor.** Its Azure object ID will not be found by the publisher's member search — the only id that search accepts comes from querying `https://app.vssps.visualstudio.com/_apis/profile/profiles/me` *as the identity*. A throwaway `workflow_dispatch` workflow did this once, on 2026-07-30, and has since been deleted; if the identity is ever replaced, re-create one to print the new `id`.

### What the subscription costs, and how it can still lapse

Because the identity lives inside an Azure subscription, **the subscription has to stay active** or publishing breaks. Everything below was checked against Microsoft's own documentation on 2026-08-04; the earlier version of this section asked for exactly that check rather than making the claims.

**It is free, and the identity cannot make it otherwise.** [Managed identities](https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/overview) "can be used at no extra cost" — cost comes only from services that *use* one. This identity holds no role on any subscription (hence `allow-no-subscriptions: true` in the publish job), so it cannot generate usage even by accident. The free trial was upgraded to pay-as-you-go on 2026-08-04 with the **Basic** support plan, which is included at $0 — the adjacent option on that screen, Developer, is $29/month and is the only way the upgrade itself costs money. A $1 monthly budget alert in Cost Management is the tripwire for the $0 expectation being wrong; Azure requires a budget above zero, and budgets alert rather than block.

**Do not verify the upgrade by looking for an offer id.** This is a Microsoft Customer Agreement subscription, so its Overview reads `Plan: Azure plan` — the MCA form of pay-as-you-go (MS-AZR-0017G). The legacy `Offer: Pay-As-You-Go (MS-AZR-0003P)` that most write-ups tell you to look for belongs to older MOSA accounts and is not available under MCA at all, so hunting for it reads as a failed upgrade when nothing is wrong. The tell that the upgrade landed is that **Upgrade subscription** disappears from the subscription's command bar.

**Disabling is not deletion.** A trial that runs out of credit is disabled, not emptied: "if you use resources that aren't free and your subscription gets disabled because you run out of credit, and then you upgrade your subscription, the resources get enabled after upgrade" ([reactivating a disabled subscription](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/subscription-disabled)). So a lapse costs downtime, not a repeat of the one-time setup above — the client id stays valid and the publisher's Contributor entry stays good.

**The clock that remains is inactivity, not billing.** A subscription with no usage, activity, or open support requests for 12 months is notified, blocked 30 days later, and deleted 90 days after that — "any resources in the subscription are also deleted" ([avoiding unused subscriptions](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/avoid-unused-subscriptions)). This setup is close to the worst case for that test, since the nightly publish produces Entra sign-ins but no ARM usage whatsoever, and whether "activity" covers a sign-in is undocumented. Earliest possible trouble is around 2027-08. The mechanical defence — grant the identity Tag Contributor on its resource group and have the nightly write a tag — is deliberately **not** implemented: it widens a publish-only identity into a write credential to guard against a hazard the `--oidc` migration above should remove first.

**A dead identity is loud, not silent.** `HAS_AZURE` keys on the secret existing and the secrets outlive the subscription, so a broken credential *fails* the publish job rather than skipping it, and a failing scheduled workflow notifies. The tag, the GitHub Release, and the downloadable VSIX are unaffected; only the Marketplace listing stops moving.

**None of this touches the listing itself.** A Marketplace publisher is a Microsoft account plus an Azure DevOps organization — no subscription appears anywhere in that path. If all of the above were deleted tomorrow, `BirtaLabs.birta-writer` would stay live and installable at its last published version.

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

There is one channel today. If a pre-release ("insiders") stream is ever wanted, it is a **flag, not a number**: add `--pre-release` to the marketplace publish step for those builds. The CalVer scheme is unchanged — the date and counter keep stable and pre-release builds correctly ordered on their own, and VS Code routes users by the flag. Do not encode the channel into the version.
