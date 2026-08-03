# Design principles

The rules of thumb this editor is built on. They exist so a change can be checked against intent, not just "does it work" — when a new affordance fights one of these, that's a signal to rethink the affordance, not the principle. This is a living document; add to it when a decision turns out to be load-bearing.

Product intent and ordering live in `WHY_THIS_FORK.md`; agent/build conventions live in `AGENTS.md`. This file is specifically about **how the UI communicates** and **how much it's allowed to interrupt**.

---

## Decorations mean one thing each

Every inline decoration carries a fixed meaning. A reader should be able to learn the vocabulary once and trust it everywhere.

- **Strikethrough means "delete this."** Reserved for findings whose fix is removal — style hits you can read the sentence without (fillers, redundancies, clichés, wordiness, AI vocabulary/boilerplate, repeated words). A dimmed strike says *try it gone*. Never strike text you aren't suggesting be cut. (Implementation: `pf-style-hit`, `webview/plugins/proofread.ts`.)
- **A dotted underline means "reconsider this," not "remove it."** Used for judgment flags — passive voice, long sentences, rule-of-three, negative parallelism, em dash, non-ASCII punctuation. There's a decision to make, and the text may well be right. (`pf-style-hit--flag`.)
- **Color encodes the source, not the severity.** Spelling is the editor's warning color, grammar the info color, style the muted description color. Hue tells you *which engine* flagged it. This is the one place color carries meaning, so nothing else in the proofreading layer competes for it.
- **A warning-tinted background means "this computed number no longer matches the document."** Reserved for values the editor itself computed (living-calc answers) whose premise elsewhere has changed — never for prose. Adding a strikethrough escalates it to "it no longer computes at all — remove it," composing the delete-this vocabulary above (removal is exactly what the offered fix does). Deliberately a background, not an underline: every dotted underline is spoken for, and a cue about a *number's validity* must not read as prose advice. (`calc-cue--stale` / `calc-cue--broken`, `webview/plugins/calcStale.ts`.)

- **A find-match-tinted chip means "editorial scaffolding — resolve this before publish."** The markers a writer leaves for themselves (`[TK]`, `TODO:`, `FIXME:`, custom strings) get a quiet background where they sit, so a draft's unresolved bits are visible without opening the review sidebar. `--vscode-editor-findMatchHighlightBackground` is the token because "here is a thing you were looking for" is exactly the meaning, and it keeps the warning tint above undiluted. One hue for every kind: colour still encodes the *source* (the Notes scanner), never severity — a FIXME does not shout louder than a TK, because triage belongs in the sidebar, not in the prose. HTML comments are left alone; they already render as their own distinct node. (`note-marker`, `webview/plugins/noteMarkers.ts`.)

The corollary: **don't stack a second visual channel onto a decoration to say the same thing.** iA Writer can lean on hue alone because its canvas is otherwise undecorated; ours already spends color and underlines on links, highlights, and marks, so proofreading gets exactly one treatment per meaning and no more.

## Annotation is advisory, reversible, and quiet

Proofreading (and anything like it) advises; it never acts on its own.

- **Every finding earns its interruption.** The popup copy must say *why* it's flagged and *what to do* — with a concrete before→after where one fits. Never restate the label back at the reader. "Passive voice → consider the active voice" is the anti-pattern: it added nothing the chip didn't already say. Compare "The doer is hidden or trailing — lead with who acts: 'mistakes were made' → 'we made mistakes'." (`styleAdvice`, `styleHitTitle`.)
- **Nothing changes the file without consent.** A finding offers a fix, a dictionary add, or Ignore. Suggestions apply on click, never automatically.
- **The user can always go quiet.** All checks ship on, but a single master **Proofreading** switch (the Checks menu's gate row, and the `toggleProofreading` command) silences spelling, grammar, and style in one step. Defaulting loud is only acceptable because going quiet is one action away. Name the domain in the control ("Proofreading", not "all checks") — the toolbar button is icon-only, so a bare "all" has no referent.
- **A master gates its children; it never overwrites them.** The Proofreading switch enables/disables the whole feature *without touching* the per-domain choices beneath it, so turning it back on restores exactly what was on before — the same contract "Check style" has with its sub-checks. A master that flips its children on/off instead (the first, wrong version of this switch) destroys intent and is the anti-pattern. When a gate is off, hide what it governs rather than leaving dimmed dead controls.
- **A gate silences the editor's opinions, never the writer's own content.** Proofreading findings are volunteered by the editor; the in-text editor-note chips mark up text the writer typed on purpose. So the **Highlight note markers** switch is a *sibling* of the Proofreading gate — it leads the Checks menu, sits outside the body the gate detaches, and survives proofreading being turned off. The layout has to carry that without a sentence of explanation: same rank and emphasis (`tb-checks-master`), separated by a rule rather than a header, since a header would read as a section the gate opens. That rule is the whole argument, so it has to be *there*: a 1px divider is a flex item in a column menu and shrinks to nothing the moment the menu overflows its cap, which is why `.ui-menu-divider` pins `flex: none` — the separator vanished only on long menus, exactly where the grouping it draws matters most. Before nesting any new toggle under a master, ask which side of that line it falls on.
- **One switch, one announcement, however many surfaces wear it.** The note highlight is flippable from four places (Checks menu, Notes tab, palette/slash command, the setting) and every one of them funnels through the plugin's re-gate, which fires a single event that each mirroring control repaints from — no polling, and no surface holding a private copy. A defensive second repaint (say, on menu open) is the anti-pattern: it makes one surface look right while another goes quietly stale, which is the failure that is hardest to notice.
- **A silent absence needs a signal.** When proofreading is gated off there are simply no underlines — indistinguishable from clean text — so the toolbar button dims to say "off". Any feature whose "off" state looks like a passing "all clear" owes the user a visible cue.
- **A disabled feature costs nothing.** No scan, no decoration pass, no lazy dependency loaded. (See "Launch performance" in `AGENTS.md`.)

## Maintained dependencies

Some things the editor writes depend on other parts of the document — a calc answer on its definitions, a section link on its heading's slug. The contract, distilled from the living-calculations and anchor-sync engines, is one ladder:

- **Auto-maintain only what the user created through the editor.** An accepted calc answer or a renamed heading's links may be updated in place as the user edits — the consent was given when the artifact was accepted, and maintenance is not insertion. Text the editor didn't write is never "maintained."
- **When a premise provably vanishes, withdraw — don't leave a stale artifact.** A deleted definition withdraws its dependent answers (`expr =>`); a stale number masquerading as live is the one lie a computed value must not tell. Withdrawal is quiet and one undo restores everything.
- **When it vanishes *unprovably*, cue — don't rewrite.** A block move or an edit made outside the editor breaks the proof that the artifact was ever live, so the text stands untouched and a decoration says it no longer follows (see the warning-tint vocabulary above), with the fix one click away.
- **Never fight an external edit.** Content that arrives from the raw editor or a git checkout is the author's text, whatever it says — external syncs are exactly when cues appear and exactly when rewrites must not.

A new dependent artifact (transcluded values, computed tables, cross-file links) should slot into this ladder rather than invent its own consent model.

## Analysis never blocks interactivity

Decoration and analysis settle in *after* first paint, on idle — never on the mount path and never as a reaction to the user's first keystroke. The editor is interactive before the first proofread pass runs. (Enforced by the deferred first pass in `proofread.ts`; measured by `e2e/perf/`.)

## Chrome mirrors the block and stays out of the way

- **Gutter marks show what the block is, dimmed.** Every marker is the block's slash-menu icon (headings an `H1`–`H6` badge, list items their flavor's icon), drawn from the same icon set as the slash menu so the two can never drift. Markers are quiet at rest and interactive by design — they are the block's primary control (see "The gutter is the handle" below).
- **Theme tokens only.** All color comes from `--vscode-*` variables so light and dark themes both work; accents use `var(--vscode-focusBorder)` with no literal fallback. No custom hex. (See `AGENTS.md` → Architecture constraints.)

## The gutter is the handle

Every block — top-level, nested in a container, or an individual list item — gets exactly one control: its gutter marker. **One affordance, two verbs: click opens the block menu, drag moves the block.** No anonymous `⠿` badge, no `+` insert button — insertion belongs to the slash menu and typing.

- **Handles are revealed, not resident — residency is the user's choice.** By default only heading badges rest visible (they double as the document's outline); every other block's handle appears on hovering the block or its gutter at low contrast and brightens on direct hover/focus. The `birta.blockHandles` setting moves that line (`hover` / `headings` / `always` at rest — hover always reveals; `body.handles-rest-*`, `shared/blockHandles.ts`). **Any keystroke hides the hover-revealed handles until the mouse moves** — the gutter never flickers alongside the caret (`body.handles-quiet`, `webview/plugins/headingFold/`); at-rest handles are ambient chrome and exempt, whichever mode made them resident.
- **"Selected" and "moving" are different states with different treatments.** A block-range selection paints the **tint** — the editor's own selection color, whole-block, with the native text highlight suppressed so nothing double-paints (`.block-range-tint`). A drag dims its run with the **veil** — reduced opacity says "in transit", never "selected" (`.block-drag-veil`). Both come from one overlay module (`blockMenu/rangeIndicator.ts`); a new "these blocks" state must pick tint (state) or veil (motion), never invent a third treatment.
- **Covered markers are the secondary affordance.** While a selection spans blocks, every covered block's marker surfaces (`.heading-fold-marker--covered`) — dragging any of them moves the run. A nested block's marker is exempt: the handle you grab is always the block you move.
- **Drag chrome answers three questions and nothing more**: what's moving (the pill — block name or count, `.block-drag-pill`), where it will land (the accent drop line, indented to the target depth), and where it landed (a brief landing flash, `.block-drop-flash`). Accents are `var(--vscode-focusBorder)`; the pill and tooltips are inverted chips built from the theme's own foreground/background. While a drag or marquee is live, every other hover surface (tooltips, popups, marker reveals) stays quiet.
- **The marquee acquires; it never steals.** Rubber-band block selection starts only outside text content (the margins); pointer-down inside text is always native text selection. The rectangle is accent-bordered with a faint fill (`.block-marquee`) and covered blocks tint live beneath it.
- **The keyboard reaches everything the mouse can, with one grammar.** Escape escalates caret → block (and collapses back); Shift+↑/↓ grow or shrink the range from its anchor; Cmd+A ladders text → block → document; Alt+↑/↓ and Cmd+Shift+↑/↓ move through the same machinery as drag. (`webview/plugins/blockKeys.ts`, `blockRange.ts`.)
- **Structure travels whole.** A heading brings its section, a list item its subtree, and collapsed content always moves with its block — no operation may orphan invisible text. One gesture is one undo step.

## When these collide

If a feature seems to need to break one of these — strikethrough for something you're *not* suggesting be deleted, a decoration that blocks paint, microcopy that only names the problem — treat it as a design smell first. Usually the feature wants a different treatment (a flag underline, an idle pass, a real explanation), not an exception to the rule.
