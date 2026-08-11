# Releasing

One rule: the version is the release date. Nothing else stores or maintains a version number, so nothing can drift out of alignment.

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

- It is valid semver. VS Code requires `major.minor.patch` and forbids leading zeros, so `2026.07.14` and the 2-part `20260714.105030` are both rejected. The integer form is not.
- It increases strictly. A later build always sorts higher, across same-day re-cuts, days, months, and years, so the Marketplace and update ordering is always right. The counter resets to `0` only when the day changes, which also changes the minor field. Semver compares minor before patch, so a reset can never order a new release below an old one.
- It needs no bookkeeping. There is no "next version" to decide. The date decides, and the job counts.

The same string is the git tag (`v2026.714.0`), the GitHub Release title, and the version stamped into the `.vsix`. `package.json` stays pinned at `0.0.0` on purpose. It is not a source of truth: the release job overwrites it at build time and never commits the change back.

When the newest tag is from today, the job resumes from that tag's patch field rather than starting at `0`, which is what makes a same-day re-cut land on `.1`. A per-day counter is enough because the cron fires once a night and `concurrency: release` serializes it against a manual dispatch. Tags cut before 2026-07-31 carry a time-of-day patch field instead (`v2026.730.54523`). That changeover was one-way and needed no special case: the resume rule treats an old patch value like any other.

## How a release happens

The `Release` workflow (`.github/workflows/release.yml`) runs nightly at 04:00 PT. It can also be run by hand: Actions → Release → *Run workflow*.

1. If nothing has landed since the last tag, it stops. No empty releases.
2. It runs `pnpm typecheck && pnpm test`. `vsce package` only runs a build, and the release cron fires on its own schedule whether or not CI for the newest commit has finished, or finished green. The job proves the commit for itself rather than trusting a status lookup that may be pending or absent.
3. It runs the integration suite (`pnpm test:integration`, under xvfb) twice: once against the `engines.vscode` floor read from `package.json`, once against stable. This is the only place the floor is ever launched (the claim is otherwise unverifiable), and the suite includes opening a real-shaped document (invalid mermaid diagram included) in the real custom editor and failing if the webview stops answering after paint. The first run of this step found two floor-only bugs that had shipped in every prior release.
4. It rolls `CHANGELOG.md` (see below), writes end-user highlights, packages the `.vsix`, tags the commit, and publishes a GitHub Release with the `.vsix` attached.
5. Two further jobs, `publish` and `publish-openvsx`, push that same `.vsix` to the VS Code Marketplace and to Open VSX. They run in parallel and fail independently.
6. Finally it commits the rolled `CHANGELOG.md` back to `main`.

That is the whole loop, and it is fully automatic. The one thing it writes to `main` is that changelog commit. It is the last step, so it can never fail a release that has already shipped.

### Re-running after a failed publish

Re-run the failed publish job alone. Re-running the whole workflow derives a new version from the clock, so it cuts a new release rather than retrying the failed one. `--skip-duplicate` makes both jobs idempotent, so re-running one after its registry already accepted the version is a no-op rather than a hard failure.

### Why publishing is a separate job, and why there are two of them

Publishing is the only part that needs the `marketplace-publish` environment, and an environment is a policy surface: a required reviewer or a deployment branch rule added to it would stall every job that declares it. Splitting keeps the tag, the GitHub Release, and the downloadable `.vsix` out of reach of a policy only publishing cares about, and means a broken credential costs one skipped job rather than the whole release.

The two registries are then split from each other for the same reason at the next level down. They share nothing but the `.vsix`, and their credentials fail in unrelated ways: an Entra login that stops working must not hold Open VSX back, and a revoked Open VSX token must not hold the Marketplace back. Each is dormant until its own secret exists, so the registries can be turned on one at a time.

Neither job packages anything. Both download the release job's artifact, so all three destinations carry identical bytes and the single build-provenance attestation covers every channel. `shared/__tests__/releaseWorkflow.test.ts` fails if a publish job grows a `package` step, because packaging locally would produce a different archive (see [Verifying a release](#verifying-a-release)) while looking, in a diff, like a harmless simplification.

> DST note: GitHub cron is UTC-only. `0 11 * * *` is 04:00 during PDT and 03:00 during PST. Change it to `0 12 * * *` to anchor 04:00 to standard time.

## The changelog

Entries are written under `## [Unreleased]` as work lands. The release job runs `scripts/stamp-changelog.mjs`, which renames that heading to the version being cut and opens a fresh empty one, then commits the result to `main`. A stamped heading reads `## [2026.805.0] - 2026, August 5`. No version heading is ever written by hand, and `[Unreleased]` holds only what has not shipped yet.

The heading's date is derived from the CalVer version rather than read from a clock, so the two cannot disagree. A second clock read could land on the other side of midnight from the one that produced the version.

The empty `## [Unreleased]` that the stamp leaves behind is removed from the copy that goes into the VSIX (`scripts/strip-empty-unreleased.mjs`), so the Marketplace Changelog tab opens on the version the reader installed. The repository copy keeps the heading, because the next stamp finds that section by name.

### A release with no user-visible changes still gets a heading

Its body reads `_No user-visible changes; internal work only._`. Commits land that a user cannot observe, and `2026.802.0` was one. Giving it a heading keeps the version sequence gap-free instead of implying the release never happened.

### The tag points at the pre-stamp commit

A tagged tree's `CHANGELOG.md` is therefore one heading behind the artifact built from it. This is the same relationship `package.json` has always had, stamped at build time and never committed back. It is also why the release guard filters its own stamp commits out by subject (`release: stamp ...`) rather than depending on where the tag sits. Change that subject without changing the guard in `release.yml` and the nightly will cut an empty release every night, each one stamping another heading. `shared/__tests__/releaseWorkflow.test.ts` checks the two against each other.

### The pre-Marketplace history lives in its own file

The semver releases up to `0.2.3` were never publicly installable. They live in [`CHANGELOG-PRE-MARKETPLACE.md`](CHANGELOG-PRE-MARKETPLACE.md), which `.vscodeignore` keeps out of the VSIX.

## Release notes

`scripts/gen-release-notes.mjs` reads the commit range and this version's section of `CHANGELOG.md`, then asks Claude to write [cursor.com/changelog](https://cursor.com/changelog)-style notes. Run by hand against an unstamped tree, it falls back to `[Unreleased]`.

It reads the stamped section for a reason. Reading `[Unreleased]` unconditionally is what made four consecutive nightly releases re-announce the entire product, because nothing ever rolled that section and it had accumulated every entry ever written.

Without an `ANTHROPIC_API_KEY`, or when the API call fails, it re-sections those same changelog entries into the notes taxonomy itself, mechanically, and only drops to a categorized commit list when there is no changelog section to read at all. So a release never blocks on the model, and never publishes less than the changelog already said.

That order matters more than it looks. The commit list used to be the only fallback, and it did not read `CHANGELOG.md` at all: a `Security` entry did not merely land in the wrong section, it never reached the notes, and the commit subject appeared in its place under `Fixes`. It also published what the observability rule excludes (`refactor: internal cleanup` went out under `Other`), and it contradicted the `_No user-visible changes_` marker by listing the commits that marker exists to suppress.

The two paths differ in kind, and it is worth knowing which one produced a set of notes. The no-key path is mechanical: sections are renamed by table, nothing is dropped, and a heading the taxonomy does not know is passed through under its own name rather than discarded. The AI path is instructed, not constrained: the prompt names every section and states the mapping, and the tests pin the prompt, but the placement is the model's. Read a `Security` section in the published notes against `CHANGELOG.md` the first time one ships.

### What goes in

Two questions decide where a change lands. They apply to both the `CHANGELOG.md` file and the generated notes.

1. Can a user observe it? If not, it goes in neither; it lives in git history. A refactor, an invisible performance or maintainability change, tooling, tests and dependency bumps are all out. A performance win a user can *feel*, like a faster launch, is observable and goes in.
2. What kind of observable change is it? The minimal, general set is New (a capability that didn't exist), Improved (an existing one behaves differently or better), and Fixed (a user-visible bug resolved), plus Removed, Deprecated and Security when they occur.

Magnitude and urgency are not extra categories. They are placement. Breaking changes lead and Security follows, because both are read to decide whether to act. The one to four headline new features are lifted into Highlights. Everything else is ordered by significance within its section.

Above all of it, every release body opens with one line linking the [Marketplace](https://marketplace.visualstudio.com/items?itemName=BirtaLabs.birta-writer) and [Open VSX](https://open-vsx.org/extension/BirtaLabs/birta-writer) listings. A GitHub release page leads with the `.vsix` asset, which is the worst of the three ways to install and the only one visible: it does not update itself, so a reader who takes it has silently opted out of every later release. Naming the registries first puts the maintained paths in front of the download. The line is prepended outside the three body paths, so a failed API call cannot lose it, and `shared/__tests__/releaseNotes.test.ts` checks both links land ahead of the first section.

The two surfaces express the same taxonomy in their own vocabulary:

| Surface | Sections |
|---|---|
| `CHANGELOG.md` (the record) | Keep a Changelog: `Added` / `Changed` / `Fixed` / `Removed` / `Deprecated` / `Security`. Flag breaking changes inline; don't add a Highlights section, because the generator lifts those. |
| Generated release notes | `Breaking changes` → `Security` → `Highlights` → `New` → `Improved` → `Fixed` → `Deprecated` → `Removed`, and nothing else. |

Every changelog section maps onto one of those, and the mapping is stated in two places that are checked against each other: the `NOTES_SECTIONS` table `scripts/gen-release-notes.mjs` applies without a key, and the prose rule in the same file's prompt.

| `CHANGELOG.md` | Release notes |
|---|---|
| `Security` | `Security` |
| `Added` | `New`, with the 1-4 headline items promoted to `Highlights` |
| `Changed` | `Improved` |
| `Fixed` | `Fixed` |
| `Deprecated` | `Deprecated` |
| `Removed` | `Removed`, unless the user must act, which makes it a `Breaking change` |

`Security` leads because the reader is scanning it to decide whether to act, which is the same reason `Breaking changes` lead. This taxonomy has no separate axis for urgency; placement is the axis. `Highlights` is a promotion out of `New`, not a source section, which is why you should never write one in `CHANGELOG.md` by hand.

`shared/__tests__/releaseNotes.test.ts` holds this to the code. It fails if a Keep a Changelog section loses its route, if the prompt and the table disagree, if an entry is dropped on the way through, or if a heading appears in our own `CHANGELOG.md` that the notes cannot place.

A first release is the special case. With no prior public version, every observable change is *New*: there is nothing to Improve or Fix against yet, which is why the initial `[Unreleased]` reads as one consolidated feature list.

## Secrets

Set these in the repo, under Settings → Secrets and variables → Actions.

| Secret              | Effect when set                                   | Today            |
| ------------------- | ------------------------------------------------- | ---------------- |
| `ANTHROPIC_API_KEY` | AI-written highlights instead of a commit list    | recommended      |
| `AZURE_CLIENT_ID`   | Also publishes to the VS Code Marketplace         | set to publish   |
| `AZURE_TENANT_ID`   | Required alongside `AZURE_CLIENT_ID`              | set to publish   |
| `OVSX_PAT`          | Also publishes to Open VSX                        | set to publish   |
| `RELEASE_TOKEN`     | Commits the rolled `CHANGELOG.md` back to `main`  | needed to stamp  |

With neither `AZURE_CLIENT_ID` nor `OVSX_PAT`, a release builds the downloadable `.vsix` and stops. That is the "build it, don't publish yet" phase. The two registry secrets are independent, so either can be added on its own.

`AZURE_CLIENT_ID` and `AZURE_TENANT_ID` are not secrets in the usual sense. They are identifiers, not credentials, and nothing about them expires. They are stored as secrets only to keep the tenant out of public logs.

### `RELEASE_TOKEN` is a real credential

It is a fine-grained personal access token scoped to this repository alone, `Contents: read and write`, set to No expiration. It exists because `main` requires a pull request from anyone but an admin, and `GITHUB_TOKEN` is not one. Branch protection has `enforce_admins` off, so an admin-owned token pushes directly and no bypass rule is involved. CI cannot open a PR instead: pull requests created with `GITHUB_TOKEN` do not trigger workflows, so the required checks would never run and it could never merge. Without the token the release still stamps the packaged changelog and writes correct notes. Only the commit back to `main` is skipped, and the next night's heading simply spans two days.

Check the first run after adding it. The push step is `continue-on-error`, so a rejected push shows up as a green release with no stamp commit rather than as a failure. Read that step's log the first morning rather than inferring from the release having succeeded. Two things are only proven by that run: that an admin-owned token does bypass both the pull-request requirement and the required status checks (documented behaviour of `enforce_admins: false`, not verified here), and that the rebase-before-push handles a PR landing mid-run. Note also that the stamp commit is a push to `main`, so it triggers a CI run of its own each night. `launch-perf` short-circuits on it, and the rest is the ordinary cost of a docs-only commit.

## Marketplace authentication (one-time setup)

Publishing uses Microsoft Entra ID workload identity federation, so no token is stored anywhere. GitHub mints a short-lived OIDC token for the release job, Azure trades it for an Entra credential, and `vsce publish --azure-credential` presents that. There is nothing to rotate and nothing to leak.

### Why not the flow VS Code's own docs describe

Those docs instruct you to create an Azure DevOps PAT scoped to All accessible organizations, which is exactly what Azure DevOps calls a *global* PAT. Global PATs are decommissioned on 2026-12-01: creation is unblocked until then, and existing tokens stop working after ([Azure DevOps blog](https://devblogs.microsoft.com/devops/retirement-of-global-personal-access-tokens-in-azure-devops/)). Whether an org-scoped PAT can publish instead is unresolved upstream ([microsoft/vscode#322741](https://github.com/microsoft/vscode/issues/322741), open, zero comments, no milestone as of 2026-08-04). So the documented path leads to a credential with a known death date, and the docs still instruct you to pick that scope while carrying the retirement banner on the same page.

### This setup should be temporary

The exit from Azure is being built. `vsce publish --oidc` is trusted publishing in the sense npm and PyPI mean it: the GitHub Actions OIDC token is exchanged directly at the Marketplace's `POST /_apis/gallery/token` for a short-lived credential, with no Azure resource anywhere in the picture and no fallback to a PAT. It merged 2026-07-23 ([microsoft/vscode-vsce#1291](https://github.com/microsoft/vscode-vsce/pull/1291)) but ships only on the `next` channel (`3.9.3-3`; `latest` is `3.9.2`), and nothing confirms the Marketplace exposes the trusted-publishing policy it requires. The question asked on that PR on 2026-07-30 is unanswered, and [microsoft/vsmarketplace#1422](https://github.com/microsoft/vsmarketplace/issues/1422) is still open.

When both land the migration is small: drop the `azure/login` step, swap `--azure-credential` for `--oidc`, register the policy once, delete the subscription. `id-token: write` and the `marketplace-publish` environment are already there.

### The setup, once

1. A user-assigned managed identity in the Azure portal, not an App Registration. An App Registration is free and needs no subscription, so it looks like the obvious choice; it reportedly authenticates successfully and then fails the publish itself with `InvalidAccessException: The requested operation is not allowed`. That failure was reported by others and not reproduced here. Microsoft documents this flow for Azure Pipelines only, so the GitHub Actions shape of it is community knowledge, and the one upstream report, [microsoft/vscode-vsce#1023](https://github.com/microsoft/vscode-vsce/issues/1023), was closed as not planned with no technical answer, so "unverified" is where it stays.
2. A federated credential on that identity. Scenario *GitHub Actions deploying Azure resources*, entity type Environment, environment name `marketplace-publish`. Branch or Tag bindings match one literal ref and break on the next release, which is why the release job declares this environment.
3. `AZURE_CLIENT_ID` and `AZURE_TENANT_ID` copied from the identity's *Properties* into repo secrets.
4. The identity added to the Marketplace publisher as a Contributor. Its Azure object ID will not be found by the publisher's member search. The only id that search accepts comes from querying `https://app.vssps.visualstudio.com/_apis/profile/profiles/me` *as the identity*. A throwaway `workflow_dispatch` workflow did this once, on 2026-07-30, and has since been deleted. If the identity is ever replaced, re-create one to print the new `id`.

This setup is verified by use: the first publish succeeded on 2026-07-31, and every nightly since has published on the same path.

### What the subscription costs, and how it can still lapse

Because the identity lives inside an Azure subscription, the subscription has to stay active or publishing breaks. Everything below was checked against Microsoft's own documentation on 2026-08-04.

#### It is free, and the identity cannot make it otherwise

[Managed identities](https://learn.microsoft.com/en-us/entra/identity/managed-identities-azure-resources/overview) "can be used at no extra cost". Cost comes only from services that *use* one. This identity holds no role on any subscription, hence `allow-no-subscriptions: true` in the publish job, so it cannot generate usage even by accident.

The free trial was upgraded to pay-as-you-go on 2026-08-04 with the Basic support plan, which is included at $0. The adjacent option on that screen, Developer, is $29/month and is the only way the upgrade itself costs money. A $1 monthly budget alert in Cost Management is the tripwire for the $0 expectation being wrong; Azure requires a budget above zero, and budgets alert rather than block.

#### Do not verify the upgrade by looking for an offer id

This is a Microsoft Customer Agreement subscription, so its Overview reads `Plan: Azure plan`, the MCA form of pay-as-you-go (MS-AZR-0017G). The legacy `Offer: Pay-As-You-Go (MS-AZR-0003P)` that most write-ups tell you to look for belongs to older MOSA accounts and is not available under MCA at all, so hunting for it reads as a failed upgrade when nothing is wrong. The tell that the upgrade landed is that Upgrade subscription disappears from the subscription's command bar.

#### Disabling is not deletion

A trial that runs out of credit is disabled, not emptied: "if you use resources that aren't free and your subscription gets disabled because you run out of credit, and then you upgrade your subscription, the resources get enabled after upgrade" ([reactivating a disabled subscription](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/subscription-disabled)). A lapse therefore costs downtime, not a repeat of the one-time setup above. The client id stays valid and the publisher's Contributor entry stays good.

#### The clock that remains is inactivity, not billing

A subscription with no usage, activity, or open support requests for 12 months is notified, blocked 30 days later, and deleted 90 days after that, and "any resources in the subscription are also deleted" ([avoiding unused subscriptions](https://learn.microsoft.com/en-us/azure/cost-management-billing/manage/avoid-unused-subscriptions)). This setup is close to the worst case for that test, since the nightly publish produces Entra sign-ins but no ARM usage whatsoever, and whether "activity" covers a sign-in is undocumented. Earliest possible trouble is around 2027-08.

The mechanical defence is to grant the identity Tag Contributor on its resource group and have the nightly write a tag. It is deliberately not implemented: it widens a publish-only identity into a write credential to guard against a hazard the `--oidc` migration above should remove first.

#### A dead identity is loud, not silent

`HAS_AZURE` keys on the secret existing, and the secrets outlive the subscription, so a broken credential *fails* the publish job rather than skipping it, and a failing scheduled workflow notifies. The tag, the GitHub Release, and the downloadable VSIX are unaffected. Only the Marketplace listing stops moving.

#### None of this touches the listing itself

A Marketplace publisher is a Microsoft account plus an Azure DevOps organization, and no subscription appears anywhere in that path. If all of the above were deleted tomorrow, `BirtaLabs.birta-writer` would stay live and installable at its last published version.

## Open VSX (the second registry)

The VS Code Marketplace's terms of use restrict it to Microsoft's own products, so every fork reads a different registry: VSCodium, Cursor, Windsurf, Gitpod and Eclipse Theia all default to [Open VSX](https://open-vsx.org/), run by the Eclipse Foundation. Publishing there is the only way Birta Writer is installable in any of them, and it is a plain token upload with none of the Azure apparatus above.

The license is not an obstacle. Open VSX requires that an extension declare one, and explicitly permits licenses the OSI does not recognize as open source ([Open VSX FAQ](https://www.eclipse.org/legal/open-vsx-registry-faq/)), so FSL-1.1-ALv2 publishes without a waiver. `LICENSE` ships inside the `.vsix` already.

### The setup, once

1. Sign the Eclipse Foundation Open VSX Publisher Agreement. Log in to [open-vsx.org](https://open-vsx.org/) with GitHub and accept it on your profile page.
2. Generate an access token at [open-vsx.org/user-settings/tokens](https://open-vsx.org/user-settings/tokens). The value is shown once and never again.
3. Create the namespace. It must equal `package.json`'s `publisher` field exactly, which is `BirtaLabs`:

   ```bash
   npx ovsx create-namespace BirtaLabs -p <token>
   ```

4. Store the token as the `OVSX_PAT` repository secret, under Settings → Secrets and variables → Actions. From the next release on, `publish-openvsx` runs.

All four steps were completed on 2026-08-11 and the [listing](https://open-vsx.org/extension/BirtaLabs/birta-writer) is live, so this section matters again only for a token rotation (below) or a new namespace.

Creating the namespace makes you a contributor of it, which is already exclusive: since 2020-12-17 only members of a namespace may publish into it, so nobody else can push a `BirtaLabs.*` extension ([Namespace Access](https://github.com/eclipse/openvsx/wiki/Namespace-Access)). Note that `ovsx`'s own README still describes the pre-2020 behavior, where a new namespace was open to everyone; the wiki is the authority.

What a contributor does not have is an owner. A namespace with no owner is unverified, and every extension in it renders with a warning icon and a banner instead of the verified shield, however trustworthy the publisher. Claiming ownership fixes that and lets you manage members. Open an issue at [EclipseFdn/open-vsx.org](https://github.com/EclipseFdn/open-vsx.org/issues/new/choose) while logged in to open-vsx.org. Granting is deliberately public, so a claim can be disputed in the thread. Worth doing, and not a prerequisite for publishing.

### The first minutes after a publish are meant to look wrong

A version appears as `Deactivated`, and absent from search and the extension page, immediately after upload. Processing is asynchronous; the version activates when it completes, usually within seconds. Something that stays deactivated for minutes is a failed processing run rather than a slow one, and is worth chasing. Its icon is extracted during the same pass, so a placeholder tile before activation means nothing either way. This is observed behavior from this extension's first publish, not something the registry documents, so if a later publish behaves differently, trust what you see over this paragraph.

### The first publish

Nothing has to wait for a nightly. Publish the artifact from the newest GitHub Release, which is the same file the Marketplace holds and the one the attestation covers:

```bash
gh release download --repo harlanlewis/birta-writer --pattern '*.vsix'
npx ovsx publish --packagePath birta-writer-*.vsix -p <token>
```

Publishing by hand and letting the nightly publish cannot collide: the version is derived from the release date, so a hand-published version is one the nightly will never re-cut, and `--skip-duplicate` covers a re-run of the same one anyway.

### `OVSX_PAT` is a real credential, and it is the only signal

Unlike `AZURE_CLIENT_ID` and `AZURE_TENANT_ID`, which are identifiers that never expire, this is a bearer token that can be revoked or deleted from the account page. There is nothing else to notice that: the job authenticates and uploads in one step, so a dead token surfaces as a failed `publish-openvsx`, which is a failing scheduled workflow and does notify. The Marketplace, the tag, the GitHub Release and the downloadable `.vsix` are all unaffected. Only the Open VSX listing stops moving.

Rotating is generating a new token, replacing the secret, and revoking the old one. The namespace and the published versions are unaffected either way.

## Verifying a release

A source audit tells you what the *source* does. It cannot tell you that the published binary was built from that source. Every release closes that gap with a [Sigstore](https://www.sigstore.dev/)-backed build-provenance attestation, binding the VSIX's digest to this repository, the exact commit, and the workflow run that produced it:

```
gh attestation verify birta-writer-<version>.vsix --repo harlanlewis/birta-writer
```

The Marketplace upload, the Open VSX upload and the GitHub Release asset are the same file. The release job packages once and both publish jobs upload that artifact rather than rebuilding, so one attestation covers all three channels. A `SHA256SUMS.txt` is attached alongside for anyone who just wants to compare two files.

### What is not yet true: byte-reproducibility

You cannot currently rebuild a tag and get a byte-identical VSIX. The published hash is therefore an identifier for that artifact, not something a third party can independently derive.

Measured 2026-07-30: two `pnpm run package` runs from an identical tree produced different archive hashes, with identical extracted contents and identical entry order. The only difference was the zip entry mtimes: `...173236` in one, `...173240` in the other.

That locates the problem precisely. The *build* is already deterministic; the *container* is not, because `vsce package` stamps each zip entry with the wall clock and exposes no `SOURCE_DATE_EPOCH`-style override. Closing it means normalizing timestamps in the archive after `vsce` writes it, which is real work and is tracked in MAR-130. Don't claim reproducibility until that lands. Until then, provenance answers "did this pipeline build it from that commit", which is the question most people actually have, but not "can I derive these bytes myself".

## Channels, later

There is one channel today. If a pre-release ("insiders") stream is ever wanted, it is a flag, not a number: add `--pre-release` to the Marketplace publish step for those builds. The CalVer scheme is unchanged, because the date and counter keep stable and pre-release builds correctly ordered on their own, and VS Code routes users by the flag. Do not encode the channel into the version.
