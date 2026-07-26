# The writing-app landscape beyond VS Code — a competitive survey

*Research compiled 2026-07-26. This document surveys the **standalone writing-app market** — the
premium prose editors and block/PKM apps people use on desktop, mobile, and the web — to locate the
**negative space** a Birta Writer mobile and/or web app could fill.*

> **Scope & relationship to the other research.** `docs/research/markdown-editor-landscape.md`
> already surveys **Markdown editing *inside VS Code*** (why the fork exists). This is its companion
> on the **other axis**: the apps a writer would reach for *instead of* an IDE — Craft, Obsidian, iA
> Writer, Bear, Ulysses, Typora, Notion, and the rest. It is the evidence base; the strategic
> reading of it (should Birta build a mobile/web app, for whom, in what order) lives in
> [`docs/SURFACE_STRATEGY.md`](../SURFACE_STRATEGY.md), and the AI-posture reading in
> [`docs/AI_ASSISTANCE.md`](../AI_ASSISTANCE.md). Where the canon (`README.md`, `docs/BENEFITS.md`)
> and this survey disagree about what Birta *is*, the canon wins.

> **On confidence.** Findings were gathered by a fan-out of research agents across live web sources
> in July 2026. Vendor sites frequently block automated fetches (403), so some pricing and
> just-shipped-AI details are second-hand. Every load-bearing uncertainty is **flagged inline**;
> treat anything unflagged-but-specific (exact prices, "just shipped" AI) as "verify on the vendor's
> own store before quoting externally." GitHub facts and platform availability are high-confidence.

---

## TL;DR — the five-legged stool

Sort the whole field by the five properties that define Birta's thesis, and a clean pattern appears:
**every competitor gives up at least one leg.**

1. **True never-leave-WYSIWYG** (formatted text you edit in place, not syntax-revealing "live preview")
2. **Byte-faithful plain `.md` on disk** (the file *is* the document; editing one part never rewrites another; no proprietary store, no export step)
3. **Cross-platform reach including a real mobile and/or web app**
4. **Local-first privacy** (offline by default, no telemetry, content never egresses without consent)
5. **A document editor, not a PKM** (no graph/database/plugin ceremony to wade through to just write)

| App | 1 WYSIWYG | 2 Plain-`.md` byte-fidelity | 3 Mobile/web | 4 Local-privacy | 5 Not-a-PKM | Leg it drops |
|---|---|---|---|---|---|---|
| **Typora** | 🟢 (reformats on save) | 🟡 normalizes on save | 🔴 **no mobile, no web** | 🟢 | 🟢 | **reach** |
| **iA Writer** | 🔴 syntax stays visible | 🟢 | 🟡 great iOS, **no Android/web** | 🟢 | 🟢 | **WYSIWYG** |
| **Obsidian** | 🟡 "current-line" live preview | 🟢 (degrades under plugins) | 🟡 mobile OK, **no web** | 🟢 (BYO/local-AI) | 🔴 PKM by design | **WYSIWYG + focus** |
| **Ulysses** | 🟢 | 🔴 proprietary library / Markdown XL | 🔴 **Apple-only** | 🟡 iCloud | 🟢 long-form | **fidelity + reach** |
| **Bear** | 🟢 | 🔴 SQLite store | 🟡 Apple + web beta | 🟡 CloudKit + E2EE | 🟡 tag-PKM | **fidelity + reach** |
| **Craft** | 🟢 | 🔴 proprietary block model | 🟡 superb Apple, weak Win/web/Android | 🟡 offline-cloud | 🟡 docs-PKM | **fidelity** |
| **Notion** | 🟢 blocks | 🔴 cloud block DB, lossy export | 🟢 everywhere (mobile weak) | 🔴 cloud-only | 🔴 database platform | **fidelity + privacy + focus** |
| **Logseq** | 🟡 | 🔴 rewrites files; moving to a DB store | 🟡 laggy mobile | 🟢 | 🔴 outliner | **fidelity + WYSIWYG** |
| **Anytype** | 🟢 | 🔴 proprietary encrypted object DB | 🟢 | 🟢 E2EE/local-first | 🔴 object graph | **fidelity + focus** |
| **SiYuan** | 🟢 | 🟡 `.sy` JSON blocks, not plain `.md` | 🟢 | 🟢 local-first | 🟡 block-PKM | **plain-`.md`** |
| **Lex** | 🟢 | 🔴 cloud DB | 🟢 web-first | 🔴 cloud AI-first | 🟢 | **fidelity + privacy** |

**The central finding: the intersection of all five legs is empty.** The closest single competitor is
**SiYuan** (local-first + WYSIWYG + mobile + open-source) — but it stores `.sy` JSON-block files, not
byte-faithful plain Markdown, so it fails leg 2. **Typora** is the closest on *feel* (WYSIWYG over
real `.md`) but has categorically refused mobile. **A polished WYSIWYG editor over the user's own
byte-faithful `.md`, on a phone and in a browser, that stays a calm single-document editor rather than
a PKM, and keeps everything local — does not exist.** That is the opening.

---

## Tier A — plain-file / prose editors (Birta's closest adjacency)

### iA Writer — the principled-restraint benchmark
- **Surfaces:** macOS, iOS/iPadOS (genuinely first-class), Windows. **No Android, no web.**
- **Storage/fidelity:** plain `.md`/`.txt` on disk, wherever you point it (local, iCloud Drive, Dropbox). Clean round-trip, minimal lock-in — its philosophical kin to Birta.
- **AI (2026):** **Authorship** — colour-codes which characters *you* typed vs. pasted from an AI, as in-document provenance. It generates nothing and sends nothing; it's a transparency tool. The most principled "advisory/quiet, your-file-stays-yours" AI stance in the category — but offers *no* generative help at all. (Red Dot 2025, iF Gold 2026.)
- **Pricing:** one-time — ~$49.99 Mac, ~$49.99 iOS, ~$29.99 Windows (per-platform; v7 raised iOS pricing — *verify*).
- **Exceptional at:** typographic craft (bespoke typefaces, tuned measure/line-height), focus mode, parts-of-speech highlighting, restraint. The clearest "calm, opinionated defaults, get out of the way" execution shipping.
- **Weak/complained about:** not WYSIWYG (syntax stays visible — the leg Birta beats); no Android/web; pay 2–3× to cover platforms; deliberately feature-thin (weak tables).

### Typora — the closest direct competitor on *feel*
- **Surfaces:** macOS, Windows, Linux. **No iOS, no web** — and [explicitly no plans for mobile](https://github.com/typora/typora-issues/issues/525). (Aggregator claims of "Android support" appear to be error — treat as unverified/wrong.)
- **Storage/fidelity:** edits plain `.md` directly — its whole identity. **But it normalizes/reformats on save** (list markers, emphasis style, spacing) — precisely the "edit one part, rewrite another" gap Birta's minimal-diff engine closes.
- **AI:** essentially none.
- **Pricing:** **one-time $14.99**, ~3 devices, lifetime updates — best value in the category.
- **Exceptional at:** seamless live-preview WYSIWYG over raw `.md` (the "never leave WYSIWYG" experience Birta also chases), speed, plain-file simplicity, math/mermaid, Pandoc export.
- **Weak/complained about:** no mobile/web/sync/collaboration; closed-source single-developer bus factor; occasional reformat-on-save fidelity gripes; lingering telemetry-history privacy suspicion (current posture is local-only + opt-out anonymous stats — *verify if privacy is a headline*).

### Ulysses — long-form manuscript management, Apple-locked
- **Surfaces:** **Apple-only** (macOS/iPad/iPhone; Setapp). No Windows/Android/web, no plans.
- **Storage/fidelity:** defaults to a **proprietary managed library** (iCloud-synced sheets), not files; "external folders" mode edits plain `.md`/TextBundle but is opt-in and **loses Markdown XL constructs** (comments, annotations, highlight, redact). Markdown XL uses non-standard notation (`(fn)`, `(img)`, `{annotations}`) that doesn't round-trip to CommonMark. A third-party `export-ulysses` script exists precisely because bulk extraction isn't trivial — the lock-in tell.
- **AI (2026):** **no confirmed first-party generative assistant** — leans on Apple Intelligence Writing Tools + system ChatGPT compose; reviews say it's "missing the boat." *(Highest-value thing to re-verify — vendor release notes 403'd; a "Muse" feature could not be confirmed and is likely a confusion with Meta's unrelated tool.)*
- **Pricing:** subscription-only, ~$5.99/mo or ~$49.99/yr (+ education/legacy tiers).
- **Exceptional at:** the library + groups + sheets model, drag-to-restructure, per-project goals, revision mode, and **best-in-class publishing/export** (Ghost/WordPress/Medium, ePub/PDF/DOCX with style sheets). The reference product for books and blogs.
- **Weak/complained about:** the 2017 **subscription switch remains its most-hated trait**; Apple-only; library/Markdown-XL lock-in for default users; behind on AI. Privacy posture itself is clean (EU hosting, opt-in crash reports, no access to iCloud content) — a strength to match, not attack.

### Bear — the "beautiful place to think," proprietary underneath
- **Surfaces:** Apple-only by design; **web app in public beta** (since 2025, not a replacement — no export, encryption WIP). Polished mobile (widgets, Shortcuts, share-sheet, Pencil).
- **Storage/fidelity:** notes in a **proprietary local SQLite DB, not plain `.md`** — the core lock-in. Markup is Markdown-*compatible* (with `[[links]]`), not strict CommonMark, so round-trip isn't lossless. Broad export exists but PDF/HTML/DOCX/JPG are Pro-gated, and it's an action, not files-on-disk (third-party SQLite-scraping export scripts exist — the tell).
- **AI (2026):** **no built-in model** — Bear 2.8 shipped **BearCLI + a Claude Connector + an MCP server**, opening notes to agents you choose to connect (content then egresses to that cloud). Conservative "interoperate, don't bolt on" stance.
- **Pricing:** freemium + Pro ~$2.99/mo or ~$29.99/yr (sync + key exports are Pro-gated).
- **Exceptional at:** aesthetics/typography/themes (often called the most beautiful note app), nested `#tags`, `[[wiki]]` links, deep Apple integration, per-note E2E encryption (keys in Secure Enclave).
- **Weak/complained about:** proprietary DB lock-in anxiety; Apple-only; CloudKit sync lag with no status UI (exposed to Apple outages); "Markdown-ish" fidelity; sync/export paywall.

### Drafts — capture upstream of composing (Apple-only)
- Apple-only, mobile-first, extremely fast; plain text in **Drafts' own iCloud store, not `.md` files**. No native AI model (scripted calls + a Mac MCP server). Free base; Pro ~$19.99/yr. **A capture-and-process tool, not a long-form writer** — "writers draft here then move to iA Writer." Sits *upstream* of Birta's job; relevant only as evidence that the **capture↔compose seam is unserved cross-platform**.

---

## Tier B — block editors & PKM apps

### Craft — the design-polish bar
- **Surfaces:** iOS/iPadOS/macOS native (among the best-crafted in the category), plus weaker Windows/web, limited Android.
- **Storage/fidelity:** **proprietary document/block model**, not plain `.md`. Markdown is an import/export lane; Craft **owns the source of truth**, so formatting can shift on export — no byte-fidelity.
- **AI (2026):** mature Craft Assistant; notably supports **BYO OpenAI/Anthropic API key** (a privacy-friendlier touch worth stealing). Still cloud inference.
- **Pricing:** free tier + paid from ~$5/user/mo.
- **Exceptional at:** **best-in-class visual design and document polish** — the bar Birta must match on *feel* (typography, cards, page aesthetics).
- **Weak/complained about:** proprietary format = lock-in despite export; Apple-centric; markets a "your content" story its storage model doesn't actually deliver.

### Obsidian — the local-files leader with a mobile/WYSIWYG gap
- **Surfaces:** desktop (Electron) + mobile (**Capacitor**). **No web app.** Mobile is functional but a documented weak spot: ~30% of desktop plugins have no mobile build; image handling, sync conflicts, and plugin gaps recur unresolved across 2022–2025; the app must fully load before you can act.
- **Storage/fidelity:** plain `.md` on disk — the strongest file-ownership story in this set. **But not true WYSIWYG** — Live Preview reveals raw syntax on the current line ("~99% WYSIWYG"); a fully visual mode is an oft-requested, unshipped feature. Fidelity **degrades once plugins touch a file** (reformatting, YAML edge cases), so "byte-faithful" isn't guaranteed. `[[wikilinks]]`, `%%comments%%`, callouts, and 2026 **Bases** blocks are nonstandard Markdown other tools won't render.
- **Sync/AI:** genuinely local-first; Obsidian Sync ~$4/mo (or DIY iCloud/Dropbox/**git via Working Copy on iOS** — the standard free path). **No first-party AI** by design; community plugins, several supporting **local models via Ollama, nothing leaving the device**.
- **Bases/Canvas:** **Bases** (a no-code DB over YAML properties, v1.9 mid-2025) is a credible Notion-database answer on local files; Canvas is a spatial board.
- **Pricing:** free personal (commercial free since Feb 2025); Sync/Publish paid.
- **Exceptional at:** plugin ecosystem (1,400+), plain-file ownership, local-AI options, Bases/Canvas.
- **Weak/complained about:** mobile friction; **no true WYSIWYG**; **PKM-shaped** — reviews repeatedly say it's *too much for someone who just wants to "write something, make it look good, send it"* (exactly what Birta is *not*). This is the single most important adjacency: **Obsidian/Logseq users want a better mobile WYSIWYG editor for the same files** — and those are the two apps whose own mobile/WYSIWYG is weakest.

### Notion — the cloud-lock-in antithesis (and the sharpest foil)
- **Surfaces:** everywhere (Electron desktop; React-Native+webview mobile; web). **Mobile is a chronic weak spot** in 2026 — lag, typing glitches, multi-second loads, worst on Android.
- **Storage/fidelity:** **proprietary block database in Notion's cloud** — not files, not Markdown. **Export is lossy** (databases → CSV; Markdown import flattens nesting, collapses to 3 heading levels, breaks code blocks; images via CDN; links carry 32-char IDs). **Severe lock-in.**
- **Sync/local-first:** cloud-first. Native offline shipped Aug 2025 but is a **capped cache over a cloud source of truth** (databases sync only first 50 rows offline; AI dead offline; web app no offline). **Not local-first.**
- **AI/agents (2026 — its most-developed area):** Notion 3.0 **Agents** (multi-step autonomous work up to ~20 min); **Custom Agents** on triggers with MCP connectors; Enterprise Search; AI Meeting Notes. Cloud-only over GPT-5.2/Claude, metered (~$10/1,000 credits). Notable: a **Sept 2025 prompt-injection/data-exfiltration flaw** in 3.0 agents (the "lethal trifecta," well-corroborated by Simon Willison / Schneier).
- **Pricing:** free; Plus ~$10; Business ~$20 (AI now bundled into Business, forcing an upgrade); Enterprise custom; agent credits on top.
- **Exceptional at:** flexibility ("build anything" relational DBs), all-in-one workspace, real-time collaboration, templates, breadth of integrated cloud AI.
- **Weak/complained about:** offline/performance/mobile sluggishness; proprietary lossy lock-in; complexity; AI-pricing fatigue; a real agent-security incident; every AI request traverses OpenAI/Anthropic despite the no-training policy.

### The rest, briefly *(medium confidence — 2026 specifics need a verification pass)*
- **Logseq:** outliner; historically plain `.md`/org files **but rewrites them structurally** (block IDs, `logbook::`, bullet-everything). **Moving to a SQLite "DB version"** with Markdown as import/export — a retreat from the plain-file promise that caused community concern, amid perceived slowed development. *(DB-version GA status unverified — flag.)*
- **Anytype:** genuine local-first + **E2E encryption + CRDT sync**, open-source — **but a proprietary encrypted object DB, not plain files**. "Own your data" is true for privacy, false for portability/plain-`.md`.
- **Capacities / Reflect / Tana:** object/graph tools, all **cloud DBs, not plain files** (Reflect & Tana cloud-only; Tana the most AI-forward with agents/voice-capture). Strong for power-users; heavy lock-in.
- **SiYuan:** the nearest counterexample to the whole thesis — local-first + WYSIWYG + mobile + open-source — **but stores `.sy` JSON blocks, not byte-faithful plain `.md`.** Birta's defensible edge over it is exactly plain-`.md`-as-source-of-truth plus design polish. **Worth watching.**
- **Lex:** web-based, **AI-first** word processor; cloud DB, not local, not plain-file. The clearest "**what Birta refuses to be**" on every storage/privacy/AI axis — and useful precisely as that mirror.

---

## Negative space for Birta (consolidated)

The openings where this whole field falls short of Birta's principles. Ranked by how cleanly they map
to what Birta already is.

> **Read this list as "gaps," not "opportunities."** This survey was framed to *find* where competitors
> fall short, so it reliably found shortfalls — but an empty slot in the market is not proof the slot is
> valuable. Two of these openings (especially #1, mobile WYSIWYG) may be empty partly because they are
> *hard* (see [`SURFACE_STRATEGY.md`](../SURFACE_STRATEGY.md) §3) or because *demand is thinner than a
> gap implies* (nobody may want to compose long-form on a phone). Treat the list as hypotheses to test,
> not a to-do list. The strategy doc's §0 red-teams this framing bias directly.

1. **True WYSIWYG over byte-faithful plain `.md`, on mobile and web, is uncontested.** The fidelity
   camp (Typora, iA) has no mobile/web or isn't WYSIWYG; the WYSIWYG camp (Craft, Bear, Notion) isn't
   plain-file. **This is the biggest single opening**, and it is *mobile/web-shaped*, not desktop-shaped.

2. **Byte-faithful round-trip is a differentiator nobody markets — because none can deliver it.**
   Typora reformats on save; Ulysses/Bear use non-round-tripping flavors; Obsidian degrades under
   plugins; Notion mangles both ways. "Edit one part, never rewrite another; open any tool's `.md` and
   hand it back byte-identical" is Birta-only, and it's *demonstrable* (the fidelity corpus), not a slogan.

3. **"Local-first" is systematically overclaimed — Birta can be the honest one.** Notion's offline is
   a capped cache; Anytype/Logseq are local-first but *proprietary*; Craft/Reflect/Tana are cloud with
   offline at best. **Local-first *and* plain-file *and* no proprietary DB** is a combination essentially
   no polished app offers.

4. **A trustworthy mobile companion for the vault a user already has.** Obsidian and Logseq users want a
   better mobile WYSIWYG editor for the *same files* — and those apps' mobile/WYSIWYG are their weakest
   points. Birta as "opens your Obsidian vault or Logseq folder on your phone without corrupting it" is a
   wedge into installed bases, not a from-scratch land grab. (Birta already opens these vaults safely on
   desktop.)

5. **"A document editor, not a PKM" is a validated, underserved position.** The category is racing toward
   databases/graphs/agents (Notion Agents, Obsidian Bases, Tana Supertags) and users repeatedly report
   being *overwhelmed*. Owning "calm single-document editor, cross-platform" is white space.

6. **No proprietary store, no export step, no lock-in — as the headline promise.** Every proprietary-store
   competitor's "export" button is lossy. Birta's file *is* the document: "there is nothing to export
   because it was always your file" is a claim no incumbent can copy without rebuilding their core.

7. **Advisory, reversible, opt-in, local-by-default AI** — a clean third path between ambient cloud
   AI-on-your-data (Notion, Lex) and no-help-at-all (Typora, iA). Nobody offers suggests-not-acts AI that
   keeps the file local by default. (Full treatment: [`docs/AI_ASSISTANCE.md`](../AI_ASSISTANCE.md).)

8. **Health-tech-grade privacy — checkable, not promised.** "No telemetry, content never leaves the device"
   is a claim almost no competitor can make honestly. Pairs with #7 as a trust story, and lands hardest
   with Birta's stated security/health-tech bar.

9. **Sync reliability *as a felt property*.** Bear (CloudKit lag, no status UI) and Ulysses (iCloud gripes)
   frustrate users; Typora/iA punt sync entirely. A *visible, conflict-safe, file-based* sync where a failed
   sync degrades to "your local file is intact, never data loss" beats the anxiety the incumbents create —
   and it reuses Birta's existing collision-surfacing philosophy rather than CRDTs.

10. **Fair pricing against subscription fatigue.** Ulysses' subscription is its most-hated trait; Bear gates
    sync/export; Reflect has no free tier. Typora ($14.99 once) and iA (one-time) prove the appetite. Not
    rent-seeking on core editing/fidelity is aligned with the loudest pricing complaint in the category.

11. **Speed a user can feel.** Notion (Electron + RN webviews) and most Electron/Capacitor PKM apps are
    heavy and load-gated on mobile. Lean, instant-launch editing is exactly the axis incumbents are worst
    on — and Birta already treats launch performance as first-class (CI-gated).

**The single biggest opening, stated once:** a cross-platform (mobile + web, alongside desktop) **WYSIWYG
editor over the user's own byte-faithful plain-Markdown files** — calm and single-document (not a PKM),
local-first and private, with quiet opt-in AI. Every competitor surrenders at least one of the five legs;
Birta's whole thesis is holding all five at once.

---

## Verification gaps (be honest before quoting)

- **Ulysses AI** — no first-party generative assistant *confirmed*; the most likely fact to have moved.
- **Logseq DB-version** GA status and current file model — unverified this pass.
- **2026 pricing** for Anytype/Capacities/Reflect/Tana and **first-party AI** shipped by Craft/Anytype — medium confidence.
- **Typora "Android"** aggregator claims — appear to be error; no official mobile app exists.
- **Lex pricing** and **Drafts storage internals** — vendor pages blocked automated fetch.
- Exact per-app pricing generally drifts and varies by region — verify on the vendor's own store before external use.
