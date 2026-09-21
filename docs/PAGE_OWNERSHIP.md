# What the editor does to its page

Every host so far has handed the editor a whole page: VS Code's webview, Birta Writer for Mac's WKWebView, and every harness page under `e2e/`. The editor is built accordingly, and correctly so. This document is the audit of what that assumption costs if a host does not hand over a page, which is the case of mounting the editor inline, in a page the host also draws in.

It is analysis, not a plan and not a promise. Nothing here is support for inline mounting, and no code changed to produce it. [`HOSTING.md`](HOSTING.md) is the shipped contract and covers the frame case, where the editor gets a page of its own inside an `iframe` and everything below holds unchanged inside that frame. `e2e/frameHost/` is the existence proof for that shape. There is no existence proof for this one.

## Where the numbers are

`node scripts/audit-page-ownership.mjs` is the enumeration, and it is the only place a count of any of this is written down. Nothing in this document prints one, because a measured count starts going stale the moment it is typed and the first version of the ticket behind this audit (MAR-450) published one that was wrong by a wide margin within a day of being written.

Five modes, all browser-free and all fast:

| Mode | What it prints |
| --- | --- |
| no flag | the totals by verdict and by family |
| `--by-kind` | the same, with every occurrence grouped under its family |
| `--list` | every occurrence with its file, line, verdict and refinement |
| `--json` | the whole enumeration as data |
| `--check` | nothing, unless the audit has stopped being true |

The argument for each verdict lives in the rule table inside that script, next to the rule, and `--by-kind` is how to read one against the occurrences it covers. This document carries the shape of the answer and the decisions; it does not restate the rules.

### Why it is a script and not a list

The script is two halves that are kept apart on purpose. The scan finds candidate sites by shape alone and knows nothing about the verdicts: any reference to `document`, `window`, `globalThis` or `CSS.highlights` in product TypeScript under `webview/`, any selector at the top level of a stylesheet, and any fixed or viewport-unit declaration. The rule table then has to recognise each one. Whatever no rule recognises is residue, and residue is printed by name and fails `--check`.

That separation is what keeps "every occurrence has a verdict" from being true by construction. Because the scan is broader than the table, a new shape arriving inside a family the scan already matches shows up as an unclassified occurrence rather than being sorted into a bucket that was never asked about it. It has already earned this twice: the first run raised five listener registrations in `webview/editor.ts` that no rule covered, and reading them is where the sharpest finding below came from, and a later run raised every `globalThis` site the same way.

The qualifier in that sentence is the important part, and it is where this script's first version was wrong. Residue can only be produced by a match, so a shape the scan's patterns do not match at all yields no occurrence and therefore cannot become residue: it is invisible rather than raised, which is the failure that looks like a clean audit. The window and `globalThis` patterns were originally closed lists of property names, and a closed list cannot raise what its author did not think of. It missed the page's scroll position and the calls that scroll it, the editor's use of the window as an event bus, and every `globalThis` cast. Both patterns are open now and take whatever property name follows, and neither family has a catch-all rule, so an unfamiliar property lands in residue. What is left un-raisable is a shape with no pattern at all, and the way to find one of those is to go looking rather than to wait for a red.

`--check` holds three things beyond the residue: a floor on how many files the scan reached, so a scanner that had quietly stopped matching anything cannot report a clean audit; the presence of every family that is known to exist, so a pattern that stops matching fails rather than going silent; and three probes that the classifier can actually decline to classify, because a residue check is worth nothing against a classifier that returns a verdict for anything at all. `shared/__tests__/pageOwnershipAudit.test.ts` runs all of it with the suite.

## The three buckets

A verdict is a claim about what an occurrence does when the editor is mounted inline. It is not a judgement of the code, which is right for the hosts that exist.

| Bucket | What it means |
| --- | --- |
| `portable` | It behaves the same inline and imposes nothing on the host. A global read, or a global listener that cancels nothing and changes nothing outside the editor's own DOM, is portable however alarming it looks in a grep |
| `scope` | Inline it works but reaches further than it should, and the fix is mechanical: re-root a selector, name a token, take a container from the host instead of assuming the page. No design decision is reopened by fixing one |
| `owns-page` | The behaviour is itself a claim on the page, so scoping it changes what it does. Running inline means deciding to give the claim up or to keep asking the host for it |

The shape of the answer, in magnitudes rather than figures. Most occurrences are portable, and most of that majority is CSS: the great bulk of the tree's top-level selectors are already rooted at a class the editor chose, and cannot match anything the editor did not make. The scope bucket is a few hundred and is dominated by a handful of things, named below. The owns-page bucket is small enough to list in full, and is listed in full. Run the script for the figures.

Two families were in that third bucket on the first pass and came out of it on the second, which is worth recording because both look like page ownership and neither is. Fixed positioning is the first: an anchored popup is placed from its anchor's rectangle, and both the rectangle and the coordinates are in viewport space wherever the anchor sits, so a fixed popup travels to an inline mount unchanged. What it depends on is the portal underneath it, which is a scope change and is counted as one. The second is viewport lengths, which are two different things sharing a spelling. A viewport length that caps a size says a popup may not grow past the screen, and that is right for portalled chrome anywhere. A viewport length that sets a size says the editor's box is the viewport, and that one stays.

## The biggest obstacle: the editor has no root

Everything cheap in the scope bucket needs one node that is an ancestor of everything the editor draws, and there is no such node.

The editor's DOM is in three places. `.editor-topbar` holds the bar and `#editor` holds the document; they are siblings, each found by its own query against the document (`webview/index.ts`), and the height of the first reaches the second as a custom property on the document root, `--editor-topbar-height`, because the root is the nearest thing they share. The third place is the body itself: menus, tooltips, toasts and lightboxes are appended there so they escape the clipping and the stacking contexts of whatever they are anchored to.

So the three families that look like the cheapest fixes in the audit, the body-class state channel, the custom properties on the document root, and the hardcoded `getElementById("editor")`, all resolve to the same prerequisite, and it is not a rename. Introducing a root means the portals stop going to the body, and the portals go to the body precisely because no ancestor is safe: a portal target inside an element with `overflow`, `transform`, `filter` or `contain` clips or re-anchors a fixed-position popup. An inline host would have to provide a container that satisfies that constraint, which is a requirement on the host's own layout rather than on the editor's code.

This is the answer MAR-447 wanted from this audit. Inline is not a long tail of small edits; it is one structural change with a long tail of small edits behind it, and the structural change constrains the host.

## What the scope bucket is mostly made of

The boot blob. `window.__i18n` is read straight off the window wherever a setting is wanted, and it is the single largest family in the scope bucket. It is one decision and many edits, and the two are worth keeping apart when the number is read: the host gives up one global name, and the port touches every read site, because there is no seam between the two today. [`HOSTING.md`](HOSTING.md) already names this key as what a page declares; a mount API would take the same object as an argument.

The portals. Appending to the body is how transient chrome escapes its anchor's clipping. Inline it makes the editor's chrome a sibling of the host's, subject to the host's stacking order while escaping any clipping the host meant to apply to the editor's box.

The body-class channel and its selectors. A module writes a class on the body, a stylesheet in another module reads it, and a third module reads it back with `contains`. Inline it works unchanged, because the editor's DOM is under the body either way; what it costs is that the state lives in the host's class list under names as generic as `read-only`, `toolbar-hidden` and `files-open`. The write half and the read half have to move together, or the channel breaks silently, with the class still written and nothing reading it.

The viewport reads. `window.innerHeight` and `window.innerWidth` stand in for the editor's available size at far more sites than the `documentElement` metrics do, and `window.scrollY` stands in for how far the document has been scrolled. Inline none of those three numbers is about the editor's box. They move with the scroller, so they are the cheap read half of the page-scrolling row in the table below.

The window as an event bus. Several modules talk to each other by dispatching a `CustomEvent` on the window and listening for it there, under names held in shared constants: the safe-area change, the note highlight, the proofread findings, the theme change. Inline that bus runs through the host's window, so the host hears every message the editor sends itself and two editors on one page hear each other's. The fix is an element of the editor's own to dispatch on, which is the same prerequisite as everything else here.

The document queries. `getElementById("editor")` is the mount, and it is a global id: inline it is a name in the host's namespace, and a second editor on the page has nowhere to go. Three of the rest are worth naming, because they say more than the family does. `webview/readOnly.ts` locks by sweeping the whole document for two data attributes, so an inline read-only mode would reach into the host's elements if the host used the same attribute names, and read-only is a promise a host makes to a reader rather than a piece of chrome. `webview/components/shortcutsHelp/index.ts` returns focus by querying for the first `.ProseMirror` on the page, which is the wrong one as soon as there are two. And `webview/utils/katexLoader.ts` finds the bundle's siblings by querying for the script element whose URL ends in `dist/webview.js`, which is already a rule in `HOSTING.md` for frame pages and becomes a constraint on the host's own script tags inline.

## Everything that genuinely requires the page

The whole of the third bucket, by what it is rather than by where it sits, since a line number drifts out from under a document that is read a year later.

| Occurrence | Why scoping it would change what it does |
| --- | --- |
| The editor's own layout is sized to the viewport | The document's scroller takes a full viewport as its minimum height and half a viewport of overscroll past the last block, and the docked side panel takes the viewport height less the toolbar (`webview/style.css`, `webview/components/sidePanel/sidePanel.css`). Inline, a host that gives the editor a card gets a document at least a screen tall inside it and a panel taller than its container. Container query units ask the same question about the mount, which makes this a change to the editor's layout model rather than a re-rooting. The overscroll band is a deliberate reading affordance with its argument written beside it |
| The breakout column's pane fallback | The full-width breakout math resolves against `--bw-pane`, whose measured value is published by script and whose fallback is the viewport width (`webview/style.css`). The fallback is the ownership assumption written down |
| The editor scrolls the page | Restoring a remembered position, following the caret, bringing a heading to the top and auto-scrolling during a drag all command the window, because the window is the editor's scroller. That is the same claim the row above makes from the CSS side, arriving from script. Inline it scrolls the host's page out from under whatever else is on it, and scoping it means the editor stops being what scrolls |
| The synthesized resize | `webview/components/toolbar/layout.ts` fires a real `resize` Event at the window so that everything geometry-bound re-measures after the toolbar is shown or hidden. Inline that runs the host's resize handlers too, and scoping it would not do what it is for, since what it wants is exactly for everything to re-measure |
| The frame-tree sender check | `isHostMessage` walks the window's direct child frames to tell a message from an embed inside the editor's own page from one sent by its host (`webview/messaging.ts`). That reasoning is about a frame tree the editor is the top of, and inline there is no such tree |
| The scroll lock | `lockBodyScroll` in `webview/utils.ts` freezes the page while a fullscreen surface is up. Scoping it to the editor's box would not do what it is for, because the surface covers the viewport, so what must not scroll is the viewport |
| The universal box-sizing reset | `* { box-sizing: border-box }` at the top of `webview/style.css` is load-bearing for the editor's own layout and cannot simply be dropped. Confining it to the editor's subtree changes which elements it reaches, which is both the point and a change to the editor's box model that would have to be measured rather than assumed |
| The one global `[hidden]` rule | `webview/ui/chrome.css` honours the attribute once for the whole document, and AGENTS.md bans restating it per element. Narrowing it reopens the decision the rule was made to settle |
| Focus on open | `init` ends in `window.focus()` (`webview/messageHandlers.ts`). Inline that pulls the caret out of whatever field the reader was in. There is no scoped form of it that means the same thing, since focusing the editor's own node is a different act with a different outcome |
| The message transport | The host protocol arrives as a message event on the editor's own window and is applied as it arrives (`webview/messaging.ts`). That is safe exactly because the window is the editor's. Inline the window is the host's and any script on the page can post the editor a document, a read-only flip or an external update. There is nothing narrower than the window to listen on, so the transport has to change, to a port handed over at boot |

`HOSTING.md` already says the frame page sits inside the host's trust boundary rather than acting as a sandbox. Inline there is no boundary left to be inside, which is the last row's whole content.

## The sharpest single finding

`setupInteractionTracking` in `webview/editor.ts` registers seven listeners on the document, and they are the sole gate between a doc-changing transaction and a dirty document. Until one of them fires, no sync is requested, which is what keeps merely opening a file from serializing and posting a save.

The question the gate means to ask is whether the reader has touched the editor. At the document, inline, it is answered by the reader touching anything on the page. A keystroke in the host's own form field lifts the gate, and the next normalization a plugin performs on the freshly opened document is then posted as the reader's edit.

It is a scope change, and the fix is to register the seven on the editor's own root, but it is the one occurrence in the audit where the inline behaviour is a fidelity problem rather than a tidiness problem, and it is the reason the rule table can key a verdict on a file as well as on an event name. That rule is load-bearing for exactly one of the seven. The five input events (`paste`, `drop`, `cut`, `compositionstart`, `beforeinput`) are registered nowhere else in the tree, so no family verdict competes for them. `keydown` is a scope change wherever it appears, so the file rule changes nothing for it. `mousedown` is the one: it is portable at every other site that registers it, and without a verdict keyed on this file it would be portable here too, which is the wrong answer for the gate the editor's save safety hangs on. Run `--list` for the sites.

Nothing here is a defect today. Every shipped host gives the editor the page, so the gate answers correctly in all of them.

## Rules that assume page ownership by design

The ticket behind this audit expected two. The table below has those two and three more, and each is a deliberate architectural decision recorded in AGENTS.md rather than an accident to be cleaned up. Three of them are also rows in the bucket above; they are here as well because what matters there is the occurrence and what matters here is the rule that put it there.

| Rule | Where it is written | What it assumes |
| --- | --- | --- |
| Body classes as a state channel | AGENTS.md, "Launch performance"; `bodyClassRestyle.test.ts` | That the body is the editor's. The test governs the performance half, which properties a gesture's body class may carry, and says nothing about the scoping half |
| The global `--vscode-*` palette | AGENTS.md, "Color and theming"; `noColorLiterals.test.ts`, `hostPalette.test.ts` | That `:root` is the editor's. Every colour in the tree must be a `--vscode-*` variable with no literal fallback, so the variables have to be defined somewhere every editor stylesheet can see them, and `webview/ui/hostPalette.css` defines them on `:root` |
| The one global `[hidden]` rule | AGENTS.md, "Chrome skin"; `webview/ui/chrome.css` | That an author-level `display: none` for `[hidden]` may be declared once for the whole document. Restating it per element is banned, and the failure it prevents is silent: an element set hidden that goes on taking its width |
| The universal box-sizing reset | `webview/style.css` | That a `*` rule at the top of a stylesheet reaches the editor's elements and no others |
| Highlight rules injected on first use | AGENTS.md, "Keeping it fast"; `webview/components/findBar/highlightStyles.ts` | That the document's highlight registry is the editor's. `CSS.highlights` is per document and the names in it are global |

The first two are what the ticket named. The third and the fifth are the interesting additions, because both are rules adopted for reasons that have nothing to do with hosting: `[hidden]` to stop ten elements restating a rule, and the highlight injection to keep a style recalculation off the launch path. Neither would be reopened lightly, and inline reopens both.

## Shadow DOM is worse than neutral

The audit was asked to price shadow DOM in the same pass, on the hypothesis that it is not the escape it looks like. It is not, and the finding is stronger than that: it pays for the cheap half of the port and makes the expensive half more expensive.

What it fixes is the CSS reach, which is the large and cheap part. Inside a shadow root the universal reset, the element rules and every class name stop being able to match the host's elements or be matched by the host's rules, and `:host` replaces `:root` for the token declarations. That is real, and it is the part the port would otherwise do by hand.

What it breaks is the part that already works.

The body-class channel stops working, silently. The class is still written on the host's body, and `body.toc-open .tb-dock` can no longer match, because a selector cannot cross the shadow boundary. The write half keeps succeeding and the read half stops, which is the same silent shape as the failure the `[hidden]` rule exists to prevent.

The portalled chrome loses its styling. A menu appended to `document.body` is outside the shadow root, so none of the shadow root's stylesheets apply to it. Every body portal would have to move inside, which is the structural change above, made mandatory rather than merely advisable.

The containment checks degrade. `document.activeElement` returns the shadow host rather than the focused node inside it, and `Element.contains` does not cross the boundary, so the focus reads that this audit classes as portable stop answering the question their callers ask. Those reads are how nearly every surface in the tree decides whether focus is inside it.

And the things it was hoped to fix, it does not. Document-level listeners are still on the host's document. Custom properties written on `document.documentElement` still inherit into the shadow tree, so they go on working while going on polluting the host's root, which means nothing reports the problem. The highlight registry is on the document whatever tree the ranges are in, so the names stay global and a `::highlight()` rule has to exist inside the shadow root as well.

These are read from the specifications rather than measured in this tree. No shadow-root mount exists here to measure, and building one is outside this audit.

## Residue

What the audit could not reach, stated so it is not mistaken for absence.

Class-name collision is not judged per occurrence. A top-level selector rooted at the editor's own class is classed portable because it can only match an element carrying a name the editor chose. A class name is still a global name, so a host with its own `.toolbar` or `.card` is reached by the editor's rule and reaches the editor's element with its own. Judging that per class name would be a guess about hosts that do not exist. It is named here instead, and it is a real cost that the portable count does not include.

Whether a handler cancels its event is not read. The verdict for a document listener is taken at the registration, not from the handler body, and a handler that calls `preventDefault` or `stopPropagation` claims more of the page than one that does not. One case is known and is worth recording because it is counterintuitive: `stopPropagation` called on a listener attached to the document stops almost nothing, since the only node above the document is the window, so what it actually prevents is a window-level listener seeing the chord. Inside VS Code that listener is the workbench key forwarder, which is why several of these exist. Inline it would be the host's.

A shape with no pattern is invisible, not residue. The section above says why, and the two open patterns close most of it; what remains is that the scan looks for `document`, `window`, `globalThis` and `CSS.highlights` by name, so a page global reached some other way (a destructured binding, a value passed in from a module that read it) is not seen at all. Nothing in the tree does that today, and looking for one is a deliberate pass rather than something a red run will prompt.

The TypeScript scan reads one line at a time. A chain broken across lines, `document` on one and `.body.classList` on the next, would be missed. Nothing in the tree is written that way today, and a run that found such a site would report it as a different family or not at all rather than as residue, which is the one place the residue mechanism cannot help.

Third-party CSS is out of the scan. The KaTeX stylesheet is injected into the head at first use and its rules are the library's, not this tree's, so no verdict here covers them.

The Mac app's own page is out of scope. This audit reads `webview/` only. What the app does to its own WKWebView is `mac/`'s business and is not an inline case, since the app owns that page outright.

Nothing in the scan is measured in a browser. Every verdict is read from the code and from the platform's specified behaviour. The frame case has `e2e/frameHost` to check it; the inline case has nothing to run, and this document should be read with that in mind.
