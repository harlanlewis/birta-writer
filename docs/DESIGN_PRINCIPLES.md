# Design principles

The rules of thumb this editor is built on. They exist so a change can be checked against intent, not just against "does it work". When a new affordance fights one of these, that is a signal to rethink the affordance, not the principle. This is a living document: add to it when a decision turns out to govern more than the feature that prompted it.

Product intent and ordering live in `WHY_THIS_FORK.md`. Agent and build conventions live in `AGENTS.md`. This file is about how the UI communicates, and how much it is allowed to interrupt.

---

## Decorations mean one thing each

Every inline decoration carries a fixed meaning. A reader should be able to learn the vocabulary once and trust it everywhere.

### Strikethrough means "delete this"

Reserved for findings whose fix is removal: the style hits you can read the sentence without (fillers, redundancies, clichés, wordiness, AI vocabulary and boilerplate, repeated words). A dimmed strike says _try it gone_. Never strike text you are not suggesting be cut. (`pf-style-hit`, `webview/plugins/proofread.ts`.)

### A dotted underline means "reconsider this", not "remove it"

Used for judgment flags: passive voice, long sentences, rule-of-three, negative parallelism, em dash, non-ASCII punctuation. There is a decision to make, and the text may well be right. (`pf-style-hit--flag`.)

### Color encodes the source, not the severity

Spelling is the editor's warning color, grammar the info color, style the muted description color. Hue tells you which engine flagged a span. This is the one place color carries meaning, so nothing else in the proofreading layer competes for it.

### A warning-tinted background means "this computed number no longer matches the document"

Reserved for values the editor itself computed (the living-calc answers) whose premise elsewhere has changed. Never for prose. Adding a strikethrough escalates it to "it no longer computes at all, remove it", which composes the delete-this vocabulary above: removal is exactly what the offered fix does.

This is deliberately a background rather than an underline. Every dotted underline is spoken for, and a cue about a number's validity must not read as prose advice. (`calc-cue--stale` / `calc-cue--broken`, `webview/plugins/calcStale.ts`.)

### A find-match-tinted chip means "editorial scaffolding, resolve this before publish"

The markers a writer leaves for themselves (`[TK]`, `TODO:`, `FIXME:`, custom strings) get a quiet background where they sit, so a draft's unresolved bits are visible without opening the review sidebar. `--vscode-editor-findMatchHighlightBackground` is the token, because "here is a thing you were looking for" is exactly the meaning, and it keeps the warning tint above undiluted.

One hue for every kind. Color still encodes the source, here the Notes scanner, never severity: a FIXME does not shout louder than a TK, because triage belongs in the sidebar rather than in the prose. HTML comments are left alone, since they already render as their own distinct node. (`note-marker`, `webview/plugins/noteMarkers.ts`.)

### One treatment per meaning, and no more

Don't stack a second visual channel onto a decoration to say the same thing. iA Writer can lean on hue alone because its canvas is otherwise undecorated. Ours already spends color and underlines on links, highlights, and marks, so proofreading gets exactly one treatment per meaning.

## Annotation is advisory, reversible, and quiet

Proofreading, and anything like it, advises. It never acts on its own.

### Every finding earns its interruption

The popup copy must say why a span is flagged and what to do about it, with a concrete before and after where one fits. Never restate the label back at the reader. "Passive voice -> consider the active voice" is the anti-pattern: it adds nothing the chip already said. Compare the string the editor shows instead: `The doer is hidden or trailing - lead with who acts: "mistakes were made" -> "we made mistakes".` (`styleAdvice`, `styleHitTitle`.)

### Nothing changes the file without consent

A finding offers a fix, a dictionary add, or Ignore. Suggestions apply on click, never automatically.

### The user can always go quiet

All checks ship on. A single master Proofreading switch (the Checks menu's gate row, and the `birta.toggleProofreading` command) silences spelling, grammar, and style in one step. Defaulting loud is only acceptable because going quiet is one action away. Name the domain in the control, "Proofreading" rather than "all checks". The toolbar button is icon-only, so a bare "all" has no referent.

### A master gates its children; it never overwrites them

The Proofreading switch enables and disables the whole feature without touching the per-domain choices beneath it, so turning it back on restores exactly what was on before. That is the same contract "Check style" has with its sub-checks. A master that flips its children on and off instead destroys intent and is the anti-pattern. When a gate is off, hide what it governs rather than leaving dimmed dead controls.

### A gate silences the editor's opinions, never the writer's own content

Proofreading findings are volunteered by the editor. The in-text editor-note chips mark up text the writer typed on purpose. So the Highlight note markers switch is a sibling of the Proofreading gate: it leads the Checks menu, sits outside the body the gate detaches, and survives proofreading being turned off.

The layout has to carry that without a sentence of explanation. Same rank and emphasis (`tb-checks-master`), separated by a rule rather than a header, since a header would read as a section the gate opens. That rule is the whole argument, so it has to be there. A one-pixel divider is a flex item in a column menu and shrinks to nothing the moment the menu overflows its cap, which is exactly where the grouping it draws matters most, so `.ui-menu-divider` pins `flex: none`.

Before nesting any new toggle under a master, ask which side of that line it falls on.

### One switch, one announcement, however many surfaces wear it

The note highlight is flippable from four places: the Checks menu, the Notes tab, the palette and slash command, and the setting. Every one of them funnels through the plugin's re-gate, which fires a single event that each mirroring control repaints from. No polling, and no surface holding a private copy. A defensive second repaint, say on menu open, is the anti-pattern: it makes one surface look right while another goes quietly stale, which is the failure that is hardest to notice.

A surface outside the page is the exception, and it is narrow enough to state: a native menu cannot hear that event, so Birta Writer for Mac's View menu reads the host's stored answers when it opens. That is not the defensive second repaint above, which is a surface that has an announcement to listen to and repaints again anyway. It is the only pass such a surface has, the store is written by the same flip that fires the event, and a menu is looked at only at the moment it opens. What it does share with every control in this section is the rule about lying: nothing outside the page may hold a value the page can change without telling it, so a switch that reaches a native surface has to be one the page reports as the reader flips it.

### A silent absence needs a signal

When proofreading is gated off there are simply no underlines, which is indistinguishable from clean text, so the toolbar button dims to say "off". Any feature whose off state looks like a passing all-clear owes the user a visible cue.

### A disabled feature costs nothing

No scan, no decoration pass, no lazy dependency loaded. (See "Launch performance" in `AGENTS.md`.)

## Maintained dependencies

Some things the editor writes depend on other parts of the document: a calc answer on its definitions, a section link on its heading's slug. The contract, distilled from the living-calculations and anchor-sync engines, is one ladder.

### Auto-maintain only what the user created through the editor

An accepted calc answer, or a renamed heading's links, may be updated in place as the user edits. The consent was given when the artifact was accepted, and maintenance is not insertion. Text the editor didn't write is never maintained.

### When a premise provably vanishes, withdraw rather than leave a stale artifact

A deleted definition withdraws its dependent answers (`expr =>`). A stale number masquerading as live is the one lie a computed value must not tell. Withdrawal is quiet, and one undo restores everything.

### When a premise vanishes unprovably, cue rather than rewrite

A block move, or an edit made outside the editor, breaks the proof that the artifact was ever live. So the text stands untouched and a decoration says it no longer follows (the warning-tint vocabulary above), with the fix one click away.

### Never fight an external edit

Content that arrives from the raw editor or a git checkout is the author's text, whatever it says. External syncs are exactly when cues appear, and exactly when rewrites must not.

One exception, and it is the user's own edit by proxy: what an agent writes in answer to an `/ai` request made at the caret enters the undo history while that run is live, so Cmd+Z removes the insertion in one step and the ordinary sync writes the file back. Every other inbound change stays out of history. That is what a writer who asked for an insertion expects, and it is how the tools they know behave (Notion AI's inserted blocks, Copilot's inline edits undo like a paste).

A new dependent artifact (transcluded values, computed tables, cross-file links) should slot into this ladder rather than invent its own consent model.

## A display choice Markdown cannot spell stays a display choice

Some things a user wants are about how a block is DRAWN, not about what it says: this table full-width, this code block wrapped, this ordered list lettered rather than numbered. Markdown has nowhere to put any of them, and inventing a spelling is the trade to refuse. A file whose `a. alpha` renders as a paragraph everywhere else is a document the editor has damaged on the author's behalf, however good it looks here. So the bytes stay canonical (`1.`), the preference lives beside the document in the webview state bag, and the drawing is the only thing that changes.

Three consequences follow, and a new presentation preference should accept all three rather than negotiate them.

It never dirties the file. A width flip writes only to the store. A numbering choice is a node attr, so it is a real transaction and undoable, but it is absent from the serializer, so the document serializes byte-identically and the sync's equality check no-ops.

Its lifetime is the workspace, and that is stated plainly. It survives closing the file and does not travel with it. A reader who needs the distinction to be portable needs different content, not a different store.

It degrades to the default, never to a guess. These are keyed by content, so an anchor that stops matching reverts its block to the ordinary rendering. Reverting is legible; a preference silently applied to the wrong block is not (`blockWidth.ts`, "Block identity").

The counter-case is a choice Markdown CAN spell: a bullet character, an ordered delimiter, a callout's fold marker. Those belong in the file, recorded as the author typed them, and `sourceStyle.ts` exists for exactly that. The test is not whether a choice is cosmetic, it is whether the file can say it.

## A card is the link it draws

An embed card, a connector card and a link card all stand in for one link in the file, and they open the way a link does. Cmd/Ctrl+click on the card body opens the page, exactly the modifier-click that opens a plain link; a plain click selects the card (the ring, and the palette while editing), as a plain click pins a link's popup rather than leaving the document. The corner Open button stays for a pointer that does not know the modifier. Read-only removes the editing chrome and nothing else, and opening is reading, so the modifier-click still opens there. A plain click opens too, because in read-only selecting a card shows nothing (the ring and the palette are both editing chrome), which leaves the plain click only one useful meaning; a plain link's popup still has Open and Copy to offer, so it keeps its pin (`webview/plugins/embed.ts`, `webview/components/linkPopup`).

## Rendered HTML is output, not a surface

A document's inline HTML is preserved byte for byte, edited as source, and drawn as output. The drawing is where the scope of this feature could run away, because rendering costs the editor nothing per tag: the browser does it. So the rendered face of an html atom is inert by construction. It does not hold the caret, it does not become schema structure, and nothing inside it becomes a control. A click anywhere on it opens the source panel, which is the one way in. The single exception is the `<details>` toggle, because a disclosure that cannot disclose is worse than no disclosure.

Chrome is the other half of that sentence, and the distinction is the whole point rather than an exception to it. An atom that is the whole of its block is a set-piece, so it wears a box and the shared control column, exactly as a code block or an embed does. Those controls are the editor's, sitting outside the atom and acting on its source; the rule above governs what the document's own markup may become. A rendered `<button>` is refused precisely because it is the document's, and a copy-source button is offered precisely because it is not.

Focus follows the same rule, since a control the caret can reach is a surface whether or not it was meant to be one. Every focusable element in a rendered face leaves the tab order once sanitized (`components/htmlView`).

A document's CSS is filtered rather than trusted, which is the part with no fallback behind it. Scripts are refused twice, by the sanitizer and by the CSP; nothing rendered can reach the network, because `default-src 'none'` allows no origin an inline tag could name. CSS has neither guard: `style-src` must carry `'unsafe-inline'` for the editor's own styles, and the rendered face is `display: contents`, so it has no box for CSS containment to hold. That leaves the sanitizer as the only place the question can be answered, and it answers it in two parts. A `<style>` element never applies, because its selectors are global and reach the editor rather than the document. A `style` attribute keeps its presentational declarations and loses the ones that would leave the atom's box (`utils/sanitizeLoader.ts`).

The distinction worth carrying to the next feature here: preserving a construct, editing its source, and rendering it are three different scopes, and only the third is open-ended. A request to render more is a request to decide, again, what a document may do to the editor around it.

## Analysis never blocks interactivity

Decoration and analysis settle in after first paint, on idle. Never on the mount path, and never as a reaction to the user's first keystroke. The editor is interactive before the first proofread pass runs. (Enforced by the deferred first pass in `proofread.ts`; measured by `e2e/perf/`.)

## Chrome mirrors the block and stays out of the way

### Gutter marks show what the block is, dimmed

Every marker is the block's slash-menu icon: headings an `H1`-`H6` badge, list items their flavor's icon. They are drawn from the same icon set as the slash menu, so the two can never drift. Markers are quiet at rest and interactive by design: they are the block's primary control (see "The gutter is the handle" below).

One more mark lives in the gutter, one step further into the margin so it never covers the block's own: a small filled pill carrying a stop square beside a block means an agent is working on a request the user typed there (`/ai`); it is drawn in the theme's button ink so it reads at a glance, its tooltip names the harness, and clicking it stops the run. It is the only progress indicator the editor draws in the document's margin, it never enters the content area (a placeholder in the text is something you would type into and around), and it leaves nothing in the file. It sits beside the line the request was typed on, which for a request typed on a fresh empty line is that empty line, whose source position is the blank separator after the block above.

### Theme tokens only

All color comes from `--vscode-*` variables so light and dark themes both work, and accents use `var(--vscode-focusBorder)` with no literal fallback. No custom hex. (See `AGENTS.md`, Architecture constraints.)

### Everything that floats shares one ground, and every state carries its ink

A theme token is a promise about one surface, not a general-purpose color, and floating chrome reads four tokens that all mean roughly "a widget's ground". Nothing obliges a theme to make them agree, so a surface that picks its own is picking a color the surface beside it did not. Every menu, popup, picker and palette therefore paints `--ui-card-bg` (`ui/chrome.css`), which is where the choice of token lives and the only place it is made. Docked furniture is a different question and keeps its own grounds; the rule is about what floats.

Two of the row tokens are mixed from that ground rather than read from the theme, and the reason is the same in both cases: a theme tunes its value for where IT puts that surface, which is not where we put ours. `--ui-menu-hover-bg` is the row ink laid over the menu's own ground, because a theme picks `list.hoverBackground` to read against its sidebar. `--ui-menu-ink-dim` is `currentColor` at reduced alpha, so one declaration dims the resting ink on the resting ground and the hovered ink on the hover wash; a fixed muted token can only be right on one of them.

A state that sets a background sets its foreground in the same rule. A theme may wash its selection at 8% of an accent or paint it a solid saturated fill, and a row that took the fill and kept the resting ink is unreadable in the second case while looking fine in the first. For the same reason the keyboard row's outline is ours rather than the theme's: the wash answers "is this row special", and only the outline reliably answers "is this the row Enter hits". A row wearing a fill shows its icons and hints at full ink, never dimmed, since the theme chose that fill and its knockout as a pair.

Both rules are guarded (`webview/__tests__/menuGrounds.test.ts` for what the CSS says, `e2e/menuGround` for what a browser computes), because neither is visible to a type checker and jsdom has no cascade worth trusting.

### A floating surface fits the visible area, not the window

The window's top is not where the usable area begins. The toolbar and, under it, the sticky heading title are fixed and opaque, and nearly every floating surface paints beneath them. A popup placed in that band is not merely awkward. It is invisible and unclickable, and the code that placed it has no idea. `safeAreaTop()` (`webview/utils/headingUtils.ts`) is that edge, and `viewportSize()` carries it into the placement engine, so anything routed through `ui/anchoredPlacement.ts` inherits it.

Three rules follow, and the worked example of all three is `webview/components/blockMenu/menu.ts`:

- Clamp the start line before measuring the room, never after. Measuring from an anchor hidden under the chrome and clamping the result moves the surface without shrinking it, which just relocates the overflow to the opposite edge.
- When neither side fits, take the larger one and scroll inside it. `computeAnchoredPosition` returns the `maxHeight` that actually exists for exactly this, because clipping a surface can put its buttons out of reach.
- A surface anchored to something that moves must re-anchor. `trackEditorReflow()` (`webview/ui/editorReflow.ts`) is the primitive, giving capture-phase scroll plus a `ResizeObserver`, coalesced to one frame. Placing once and never revisiting strands the surface as soon as the document scrolls. Dismissing on scroll instead is equally valid, and cheaper. Doing neither is not.

Deciding to open below the anchor and overlap the text underneath is normal and correct. Opening into occluded space is not.

## Fullscreen is one surface with three grounds

Every "open this bigger" gesture over the document - a diagram, a code block, an image, an embedded player - is the same shell (`webview/ui/fullscreenSurface.ts`). Two questions about the content decide how it looks, and nothing else does.

One preview stands outside it, and stays outside until someone answers the question it raises: the image picker's enlarge opens from inside the image-insert modal rather than from the document, so it has to stack above that modal and its Escape has to return the user to the picker. A fullscreen surface opened from within another modal is a case this shell does not model.

Do we render its interior? We render diagrams and code. We do not render an embedded player: Figma and YouTube put their own controls in their own corners, so anything we float over one is a collision waiting for a viewport size. For content we do not own, add nothing but Close.

Is it a canvas, an object, or a sheet? Those are the three grounds:

- `canvas` - the backdrop IS the content's own paper, edge to edge. No card, no radius, no shadow. Diagrams. A card says "a page floating on a surface", which is untrue of a thing that extends past the viewport the moment you zoom; and a card whose fill is the canvas colour, sitting on a scrim mixed from the same theme, has no visible edges at all.
- `scrim` - a neutral dark wash, theme-independent, the way a photo viewer dims. Images and players. An object has its own edges and needs contrast behind them, never a colour match.
- `sheet` - an opaque working surface filling the viewport, with the chrome band reserved rather than floated, because text must not run under buttons. The code editor.

### One geography, whatever is open

Four corners, identical on every surface, and identical to the controls the same diagram carries in the page - so going fullscreen never moves a control out from under the pointer:

| Corner | Holds |
| --- | --- |
| top-left | identity: what am I looking at |
| top-right | actions: view controls, a hairline, mode toggles, and Close **last** |
| bottom-right | viewport navigation (the pan pad), only where the content pans |
| bottom-left | nothing, deliberately |

Close is always the final item of the top-right cluster. It is the one control a user should never have to look for.

The clusters are positioned against the viewport, not the content, and that is what makes the embed case work with no branch in the code. A diagram fills the viewport, so the cluster floats over it. A player is inset inside it, so the same coordinates put the cluster in the margin beside the player instead of over its controls. One rule, two right answers.

Anything floating over content carries the card ground (`--ui-card-*`), identity included. A diagram scaled to fill the viewport has ink under every corner, and bare text on it is unreadable exactly when the diagram is worth reading.

## The gutter is the handle

Every block, whether top-level, nested in a container, or an individual list item, gets exactly one control: its gutter marker. One affordance, two verbs. Click opens the block menu, drag moves the block. No anonymous `⠿` badge, and no `+` insert button: insertion belongs to the slash menu and to typing.

### Handles are revealed, not resident, and residency is the user's choice

By default only heading badges rest visible, where they double as the document's outline. Every other block's handle appears on hovering the block or its gutter at low contrast, and brightens on direct hover or focus. The `birta.blockHandles` setting moves that line by choosing what rests visible: `hover`, `headings` (the default), or `always`. Hovering reveals in every mode (`body.handles-rest-*`, `shared/blockHandles.ts`).

Any keystroke hides the hover-revealed handles until the mouse moves, so the gutter never flickers alongside the caret (`body.handles-quiet`, `webview/plugins/headingFold/`). At-rest handles are ambient chrome and exempt, whichever mode made them resident.

### "Selected" and "moving" are different states with different treatments

A block-range selection paints the tint: the editor's own selection color, whole-block, with the native text highlight suppressed so nothing double-paints (`.block-range-tint`). A drag dims its run with the veil: reduced opacity says "in transit", never "selected" (`.block-drag-veil`). Both come from one overlay module (`webview/editing/rangeIndicator.ts`). A new "these blocks" state must pick tint for a state or veil for motion, and never invent a third treatment.

### Covered markers are the secondary affordance

While a selection spans blocks, every covered block's marker surfaces (`.heading-fold-marker--covered`), and dragging any of them moves the run. A nested block's marker is exempt: the handle you grab is always the block you move.

### Drag chrome answers three questions and nothing more

What is moving (the pill, carrying the block name or count, `.block-drag-pill`), where it will land (the accent drop line, indented to the target depth), and where it landed (a brief landing flash, `.block-drop-flash`). Accents are `var(--vscode-focusBorder)`; the pill and tooltips are inverted chips built from the theme's own foreground and background. While a drag or marquee is live, every other hover surface (tooltips, popups, marker reveals) stays quiet.

All three answers are the truth, which for the drop line means the line and the drop are one decision, not two. A slot the move would refuse draws nothing, and no line ever snaps past a refusal to the next place that would work: a drop that travels somewhere the user did not aim is worse than one that does not happen. So the vocabulary is small enough to learn once, no line, no drop, and it covers both reasons for silence (aiming back at where the block came from, and aiming at something that cannot hold it). The one refusal too expensive to answer while the pointer moves, whether the result would survive a save and reopen, is the exception, and it says so on release rather than failing quietly.

### The marquee acquires; it never steals

Rubber-band block selection starts only outside text content, in the margins. Pointer-down inside text is always native text selection. The rectangle is accent-bordered with a faint fill (`.block-marquee`), and covered blocks tint live beneath it.

### The keyboard reaches everything the mouse can, with one grammar

Escape escalates caret to block, and collapses back. Shift+↑/↓ grow or shrink the range from its anchor. Cmd+A ladders text, then block, then document. Alt+↑/↓ and Cmd+Shift+↑/↓ move a block through the same machinery as a drag. (`webview/plugins/blockKeys.ts`, `blockRange.ts`.)

### Structure travels whole, where structure is what you are pointing at

A list item brings its subtree, and collapsed content always moves with its block: no operation may orphan invisible text. One gesture is one undo step.

A heading is the case where the surface decides. In the outline a row IS a section, so a drop there moves the section and relevels it. In the text a heading is a line among lines, so a move there is literal and the body stays put. The scope belongs to where the gesture lands rather than to where it was picked up, which is what lets one drag mean either (`webview/components/blockMenu/drag.ts`, `DropZoneProvider.scope`).

## When these collide

If a feature seems to need to break one of these, treat it as a design smell first: strikethrough for something you are not suggesting be deleted, a decoration that blocks paint, microcopy that only names the problem. Usually the feature wants a different treatment (a flag underline, an idle pass, a real explanation) rather than an exception to the rule.
