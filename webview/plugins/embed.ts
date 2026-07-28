/**
 * URL embeds (MAR-56) — render a bare provider link as an inline facade card,
 * WITHOUT touching the document.
 *
 * The card is a view-only DECORATION, never a schema node: the on-disk markdown
 * stays the plain bare link, so the file round-trips byte-identically whether or
 * not the card rendered (a node would force a toMarkdown handler and reopen
 * byte-drift risk). This mirrors proofread.ts — the precedent for "view-only,
 * never reaches serialized markdown" — and the block widget + node-decoration
 * pattern in headingFold/foldDecorations.ts.
 *
 * Per embedded paragraph, two decorations:
 *   - Decoration.node(..., { class: "embed-host" }) hides the raw link text via
 *     CSS so only the card shows.
 *   - Decoration.widget(pos + 1, cardHost, { side: -1, key }) mounts the card
 *     DOM. A stable key keeps the widget across redraws.
 *
 * Trigger (unambiguous, round-trip-safe): a top-level paragraph whose ENTIRE
 * content is one text node carrying exactly one `link` mark whose href equals the
 * text (a bare autolink), AND recognizeProvider(href) matches. That excludes
 * `[label](url)` (text != href) and URLs mixed into prose.
 *
 * Reveal-on-caret: the link stays a live mark in the doc, so when the selection
 * enters an embedded paragraph the card is dropped and the raw link shows,
 * editable; it re-renders when the caret leaves. "Get back to the raw URL" is
 * guaranteed because the link was never mutated.
 *
 * Perf: the card DOM builder is a cached dynamic import (never in the launch
 * graph), and the first decoration pass is armed on idle after first paint — a
 * doc full of embeds must not block interactivity. With the feature off the
 * decoration function returns DecorationSet.empty on the first read: no scan,
 * no import, no idle pass. (The plugin itself is composed unconditionally in
 * editor.ts — see the comment there — and is inert when gated off.)
 */
import type { Command, EditorState, EditorView, Node as ProseNode } from "../pm";
import { Decoration, DecorationSet, keymap, NodeSelection, Plugin, PluginKey, Selection, TextSelection } from "../pm";
import { $prose } from "@milkdown/utils";
import { requestIdle } from "../utils/idle";
import { providerFor, recognizeProvider, type EmbedMatch } from "../utils/embedProviders";
// messaging is in the eager bundle already; referencing it here adds nothing.
import { notifyOpenUrl } from "../messaging";
// The metadata store is eager (messageHandlers routes replies through it);
// importing it here adds nothing to the launch bundle.
import { queueEmbedMetaResolution } from "../embedMeta";
// The component-owned delete primitive (deleteRange + fold meta), via the
// blockMenu facade — deep imports are guarded by blockMenuFacade.test.ts.
import { deleteBlockRange } from "../components/blockMenu";
// Per-embed width preference (presentation-only, never in the markdown):
// the widget host carries the bw-full class so the card can span the pane.
import { embedWidthAnchor, getBlockWidth } from "../blockWidth";

/** Upper bound on how long after first paint the first embed pass may wait. */
const FIRST_PASS_IDLE_TIMEOUT_MS = 1000;

/**
 * The two gates (MAR-179 / MAR-186), read separately because they mean
 * different things. The FEATURE key governs whether embed cards exist at all.
 * The master NETWORK switch (offline by default) governs *requests*, not
 * rendering — so it gates only the providers whose card fetches something
 * (needsNetwork). A no-network provider like GitHub builds its card from the
 * URL alone and renders even offline; that is the render ladder's Rung 0. The
 * flags are baked into __i18n at panel load (like calc); regateEmbeds() below
 * covers live flips.
 */
function embedsFeatureOn(): boolean {
    return window.__i18n?.embedsEnabled ?? true;
}
function networkOn(): boolean {
    return window.__i18n?.network ?? false;
}

/**
 * The card DOM builder is loaded lazily and cached — one dynamic import shared
 * by every card in the document, and nothing pulled into the launch bundle. The
 * import fires only when ProseMirror renders a widget (post-idle, off the mount
 * path), mirroring katexLoader / mermaidLoader.
 */
let _cardModule: Promise<typeof import("../utils/embedCard")> | null = null;
function loadEmbedCard(): Promise<typeof import("../utils/embedCard")> {
    return (_cardModule ??= import("../utils/embedCard"));
}

/**
 * The href of a bare-autolink paragraph, or null when the paragraph isn't one:
 * a single text child carrying exactly one `link` mark whose href equals the
 * text. This is the whole trigger condition (a titled `[label](url)` has
 * text != href and fails here; prose with a URL mid-sentence has childCount > 1).
 */
function bareLinkHref(node: ProseNode): string | null {
    if (node.type.name !== "paragraph" || node.childCount !== 1) {
        return null;
    }
    const child = node.firstChild;
    if (!child || !child.isText || !child.text) {
        return null;
    }
    const links = child.marks.filter((m) => m.type.name === "link");
    if (links.length !== 1) {
        return null;
    }
    return links[0].attrs["href"] === child.text ? child.text : null;
}

/**
 * The widget DOM: a host div that fills asynchronously once the card module
 * loads. Returning synchronously (PM calls this at render) keeps the lazy import
 * off the render frame; a failed import degrades to the inline URL fallback
 * below — never an empty host.
 */
function embedWidget(match: EmbedMatch, sourceUrl: string): (view: EditorView, getPos: () => number | undefined) => HTMLElement {
    return (view, getPos) => {
        const host = document.createElement("div");
        // bc-host on the full-width host (not just the centered card): the
        // whole column-width band right of the card reveals the controls.
        host.className = "embed-card-host bc-host";
        host.setAttribute("contenteditable", "false");
        // Stored width preference (the card's own toggle keeps this in sync
        // on later flips; a rebuilt host re-reads the store here).
        if (getBlockWidth(embedWidthAnchor(sourceUrl)) === "full") {
            host.classList.add("bw-full");
        }
        // Click-to-select (the image model, via horizontalRule.ts's hand-rolled
        // variant): a mousedown on the card body selects the embed paragraph as
        // a NodeSelection — ring + palette — instead of being swallowed. The
        // caret still never lands INSIDE the hidden paragraph (preventDefault),
        // and clicks on the card's own buttons stop propagation before reaching
        // here, so play/external/stop keep their clicks.
        host.addEventListener("mousedown", (event) => {
            event.preventDefault();
            event.stopPropagation();
            // The widget rides at from + 1 (side -1); the paragraph is one
            // position up. getPos() is undefined during teardown races.
            const pos = getPos();
            if (pos === undefined || view.isDestroyed) {
                return;
            }
            const from = pos - 1;
            const node = view.state.doc.nodeAt(from);
            if (!node || bareLinkHref(node) === null) {
                return;
            }
            const sel = view.state.selection;
            const alreadySelected = sel instanceof NodeSelection && sel.from === from;
            view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, from)));
            view.focus();
            if (alreadySelected) {
                // Re-clicking a selected card: an Escape-dismissed palette
                // comes back (the dispatch above changes nothing, so no update
                // fires — resync explicitly).
                withPalette((m) => m.clearEmbedPaletteDismissal(), true);
                syncPalette(view);
            }
        });
        // The paragraph's live position, re-derived per use (edits move it;
        // the widget key is position-independent so the DOM survives them).
        const liveFrom = (): number | undefined => {
            const pos = getPos();
            if (pos === undefined || view.isDestroyed) { return undefined; }
            const from = pos - 1;
            const node = view.state.doc.nodeAt(from);
            return node && bareLinkHref(node) !== null ? from : undefined;
        };
        // The card's document-touching verbs (it has no view of its own):
        // edit = select + palette on the URL field; removePreview = convert to
        // the labeled, never-carded text-link form.
        const actions = {
            edit: () => {
                const from = liveFrom();
                if (from === undefined) { return; }
                // A TOGGLE: the second press closes what the first opened —
                // an open-only button left no way back but Escape.
                withPalette((m) => {
                    if (m.isEmbedPaletteOpenFor(from)) {
                        m.hideEmbedPalette(true);
                        view.focus();
                        return;
                    }
                    view.dispatch(view.state.tr.setSelection(NodeSelection.create(view.state.doc, from)));
                    view.focus();
                    m.clearEmbedPaletteDismissal();
                    syncPalette(view, true);
                }, true);
            },
            removePreview: () => {
                const from = liveFrom();
                if (from === undefined) { return; }
                withPalette((m) => m.convertEmbedToTextLink(view, from), true);
            },
        };
        loadEmbedCard()
            .then((mod) => host.replaceChildren(mod.renderEmbedCard(match, sourceUrl, actions)))
            .catch(() => {
                // The card chunk failed to load. An empty host reads as "all
                // clear" while hiding the link (a silent absence) — degrade to
                // a minimal dependency-free row instead: the URL, clickable
                // through the extension's external-open flow.
                const fallback = document.createElement("div");
                fallback.className = "embed-card-fallback";
                fallback.textContent = sourceUrl;
                fallback.title = sourceUrl;
                fallback.setAttribute("role", "link");
                fallback.addEventListener("click", () => notifyOpenUrl(sourceUrl));
                host.replaceChildren(fallback);
            });
        return host;
    };
}

/**
 * `recognizeProvider` memoized on the URL (MAR-215). The walk below runs on
 * every doc-changing transaction, and provider recognition — a URL parse plus
 * a regex per provider, per bare link — was the expensive half: on the
 * link-heavy typing fixture (360 bare autolinks) it dominated the plugin's
 * per-keystroke cost, re-deriving the identical answer for every link the
 * keystroke did not touch.
 *
 * A memo rather than a changed-range walk because `recognizeProvider` is a
 * pure function of its URL: same string, same answer, no document coordinates
 * involved — so there is nothing to forward-map and no old-vs-new side to get
 * wrong. Results are treated as immutable (frozen) since callers now share one
 * object per URL.
 *
 * Bounded so a long session that types many distinct URLs can't grow it
 * without limit; overflowing simply starts a fresh generation (the next walk
 * repopulates what the document still needs).
 */
const RECOGNIZE_CACHE_LIMIT = 512;
let recognizeCache = new Map<string, EmbedMatch | null>();

function recognizeProviderCached(url: string): EmbedMatch | null {
    const hit = recognizeCache.get(url);
    if (hit !== undefined) {
        return hit;
    }
    const match = recognizeProvider(url);
    if (recognizeCache.size >= RECOGNIZE_CACHE_LIMIT) {
        recognizeCache = new Map();
    }
    recognizeCache.set(url, match ? Object.freeze(match) : null);
    return match;
}

/** One recognized bare-link paragraph, cached between doc changes. */
interface CachedEmbed {
    from: number;
    to: number;
    match: EmbedMatch;
    href: string;
    /**
     * Occurrence index among embeds sharing this `kind:id`, in doc order. Part
     * of the widget key INSTEAD of the position: a position-carrying key meant
     * every edit above an embed re-keyed (and so rebuilt) every card below it —
     * destroying a playing iframe because someone typed a character two
     * paragraphs up. The ordinal keeps duplicate links distinct while staying
     * stable under edits elsewhere; only inserting/removing an EARLIER copy of
     * the same link shifts it (one rebuild, and a correct one).
     */
    ordinal: number;
}

/**
 * Walk the doc for recognized bare-link paragraphs. Returns [] immediately
 * when the feature is off (no provider scan, no widget, no import). This is
 * the expensive half — URL recognition per bare link — and the plugin runs it
 * only on doc changes (and the arm/regate), NEVER on selection-only
 * transactions: reveal-on-caret needs the selection, but re-walking the doc
 * per caret move re-parsed every bare URL on every arrow key (perf review,
 * 2026-07-24 — the sibling proofread/calcStale plugins never recompute on
 * selection either).
 */
export function collectEmbeds(state: EditorState): CachedEmbed[] {
    if (!embedsFeatureOn()) {
        return [];
    }
    const network = networkOn();
    const embeds: CachedEmbed[] = [];
    const occurrences = new Map<string, number>();
    state.doc.forEach((node, pos) => {
        const href = bareLinkHref(node);
        if (!href) {
            return;
        }
        const match = recognizeProviderCached(href);
        if (!match) {
            return;
        }
        // The network switch gates requests: providers whose card would fetch
        // (thumbnail/player) wait for it; no-network cards render regardless.
        if (!network && providerFor(match.kind).needsNetwork) {
            return;
        }
        const identity = `${match.kind}:${match.id}`;
        const ordinal = occurrences.get(identity) ?? 0;
        occurrences.set(identity, ordinal + 1);
        embeds.push({ from: pos, to: pos + node.nodeSize, match, href, ordinal });
    });
    return embeds;
}

/**
 * A NodeSelection covering exactly this embed's paragraph — the card's
 * SELECTED state (ring + palette), the third mode between "card at rest" and
 * "raw link revealed". Without the carve-out, selecting a card would count as
 * an overlapping selection and make the card vanish under its own ring.
 */
function isEmbedSelection(selection: EditorState["selection"], embed: CachedEmbed): boolean {
    return selection instanceof NodeSelection &&
        selection.from === embed.from && selection.to === embed.to;
}

/**
 * The cheap half: build decorations from cached matches + the current
 * selection. O(#embeds), no walk, no URL parsing — safe to run per caret move.
 */
function decorationsFor(
    embeds: readonly CachedEmbed[],
    selection: EditorState["selection"],
    doc: ProseNode,
): DecorationSet {
    const decorations: Decoration[] = [];
    for (const embed of embeds) {
        const selected = isEmbedSelection(selection, embed);
        // Reveal-on-caret: any OTHER selection touching this paragraph → show
        // the raw link (a caret placed by shift-selection, a cross-paragraph
        // range). The exact-cover NodeSelection is the selected card instead.
        if (!selected && selection.to > embed.from && selection.from < embed.to) {
            continue;
        }
        decorations.push(
            Decoration.node(embed.from, embed.to, {
                class: selected ? "embed-host embed-host--selected" : "embed-host",
            }),
        );
        decorations.push(
            Decoration.widget(embed.from + 1, embedWidget(embed.match, embed.href), {
                side: -1,
                // The ordinal (not the position) disambiguates two bare links
                // to the SAME video: same-key widgets would make ProseMirror
                // treat them as one during redraw reconciliation, while a
                // position in the key re-keyed every card below any edit —
                // tearing down a playing iframe on an unrelated keystroke.
                key: `embed:${embed.match.kind}:${embed.match.id}:${embed.ordinal}`,
            }),
        );
    }
    return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

/**
 * Full recompute: walk + filter. Exported for unit testing; the plugin itself
 * only takes this path on doc changes and the arm — see apply() below.
 */
export function computeEmbedDecorations(state: EditorState): DecorationSet {
    return decorationsFor(collectEmbeds(state), state.selection, state.doc);
}

type EmbedState = { armed: boolean; embeds: readonly CachedEmbed[]; deco: DecorationSet };

type EmbedMeta = { type: "arm" };

const embedPluginKey = new PluginKey<EmbedState>("embed");

export const embedPlugin = $prose(() =>
    new Plugin<EmbedState>({
        key: embedPluginKey,
        state: {
            init: () => ({ armed: false, embeds: [], deco: DecorationSet.empty }),
            apply(tr, value, _oldState, newState) {
                let { armed, embeds, deco } = value;
                const meta = tr.getMeta(embedPluginKey) as EmbedMeta | undefined;
                if (meta?.type === "arm") {
                    armed = true;
                }
                if (!armed) {
                    // Nothing renders until the idle arm opens the gate — the
                    // first pass never runs synchronously during mount.
                    return { armed, embeds: [], deco: DecorationSet.empty };
                }
                if (tr.docChanged || meta?.type === "arm") {
                    // The doc (or a gate, via regate's arm) changed: re-walk,
                    // then filter against the new selection.
                    embeds = collectEmbeds(newState);
                    deco = decorationsFor(embeds, newState.selection, newState.doc);
                } else if (tr.selectionSet) {
                    // Selection-only: the doc is unchanged (no steps → cached
                    // positions still hold), so reveal-on-caret needs only the
                    // cheap filter over the cached matches — no walk, no URL
                    // parsing per caret move.
                    deco = decorationsFor(embeds, newState.selection, newState.doc);
                } else {
                    deco = deco.map(tr.mapping, tr.doc);
                }
                return { armed, embeds, deco };
            },
        },
        props: {
            decorations(state) {
                return embedPluginKey.getState(state)?.deco ?? DecorationSet.empty;
            },
        },
        view(view) {
            // Arm the first pass on idle, after paint — decoration work must
            // never block interactivity. A disabled feature schedules nothing.
            // The arm keys off the FEATURE flag alone: with network off, the
            // pass still runs for the no-network cards (one idle top-level
            // scan; network providers are skipped inside the compute).
            let idle: { cancel: () => void } | null = null;
            if (embedsFeatureOn()) {
                idle = requestIdle(() => {
                    if (!view.isDestroyed) {
                        view.dispatch(view.state.tr.setMeta(embedPluginKey, { type: "arm" } satisfies EmbedMeta));
                    }
                }, FIRST_PASS_IDLE_TIMEOUT_MS);
            }
            // Metadata resolution rides the cached embeds array BY REFERENCE:
            // apply() only replaces it on doc-change/arm recomputes (selection
            // transactions reuse it), so this comparison is free per caret
            // move, and the queue itself runs on idle — never on a keystroke.
            // Network-off states never reach the queue: collectEmbeds already
            // dropped needsNetwork providers, and the store filters the rest
            // by hasMetadata. Disabled feature → embeds stays [] → nothing.
            let lastEmbeds: readonly CachedEmbed[] = [];
            let metaIdle: { cancel: () => void } | null = null;
            return {
                update(v) {
                    // Selection tracked here (not in apply): the palette is a
                    // DOM singleton anchored to the card, exactly the image
                    // toolbar's show-on-select contract.
                    syncPalette(v);
                    const embeds = embedsIn(v.state);
                    if (embeds !== lastEmbeds && embeds.length > 0 && networkOn()) {
                        lastEmbeds = embeds;
                        metaIdle?.cancel();
                        metaIdle = requestIdle(() => {
                            metaIdle = null;
                            queueEmbedMetaResolution(embeds);
                        }, FIRST_PASS_IDLE_TIMEOUT_MS);
                    } else if (embeds !== lastEmbeds) {
                        lastEmbeds = embeds;
                    }
                },
                destroy() {
                    idle?.cancel();
                    metaIdle?.cancel();
                    withPalette((m) => m.hideEmbedPalette(), false);
                },
            };
        },
    }),
);

/**
 * Recompute the embed decorations right now, for a gate that just changed.
 *
 * The gates live in `window.__i18n`, which no transaction observes: flipping
 * one leaves the decoration set exactly as it was. Without this, enabling did
 * nothing until the file was reopened, and disabling lingered until the user's
 * next click — one switch behaving two different ways, neither predictable.
 * The existing "arm" meta both opens the gate and forces a rebuild, so a single
 * dispatch covers turning embeds on AND off.
 *
 * Safe to call when the plugin isn't composed (failed chunk load): the meta is
 * simply ignored by every other plugin.
 */
export function regateEmbeds(view: EditorView): void {
    if (view.isDestroyed) { return; }
    view.dispatch(view.state.tr.setMeta(embedPluginKey, { type: "arm" } satisfies EmbedMeta));
}

// ─── Selection + keyboard model (MAR-187) ───────────────────────────────────
//
// The card paragraph's text is hidden, so the browser's native caret motion
// has nothing to land on and skipped the whole paragraph — sequential embeds
// were unreachable by keyboard entirely (verified 2026-07-27). The keymap
// below makes the card a first-class stop: arrows select it (a NodeSelection
// on the paragraph, the codeBlockBackspace precedent), Backspace selects
// before it deletes, Enter opens the palette.

/** The cached embeds of a state, [] before the arm or with the feature off. */
function embedsIn(state: EditorState): readonly CachedEmbed[] {
    return embedPluginKey.getState(state)?.embeds ?? [];
}

/** The embed whose paragraph is exactly node-selected, or null. */
function selectedEmbedIn(state: EditorState): CachedEmbed | null {
    return embedsIn(state).find((e) => isEmbedSelection(state.selection, e)) ?? null;
}

/**
 * Is the caret's innermost textblock the LAST (dir=forward) / FIRST leaf of
 * its top-level block? Guards the arrow handoff: from the middle of a list a
 * vertical arrow must move within the list, not jump to the embed after it.
 * Boundary arithmetic: each enclosing depth adds exactly one closing (opening)
 * token between the textblock's end (start) and the top-level block's.
 */
function atTopLevelEdge($pos: { depth: number; start: (d: number) => number; end: (d: number) => number }, forward: boolean): boolean {
    const d = $pos.depth;
    if (d === 0) { return false; }
    return forward
        ? $pos.end(1) === $pos.end(d) + (d - 1)
        : $pos.start(1) === $pos.start(d) - (d - 1);
}

/** Select an embed's paragraph (ring + palette), scrolled into view. */
function selectEmbedTr(state: EditorState, embed: CachedEmbed): ReturnType<EditorState["tr"]["setSelection"]> {
    return state.tr.setSelection(NodeSelection.create(state.doc, embed.from)).scrollIntoView();
}

/**
 * Arrow handling around embeds, one direction per binding. Two cases:
 *  - a selected card hands off: to the adjacent embed (sequential cards are
 *    each their own stop) or to a caret in the neighboring block;
 *  - a caret at the top-level edge of the block adjacent to an embed enters it
 *    by selecting the card — never by skipping it.
 * Plain arrows only: modifiers (incl. shift) keep their native meaning.
 */
function embedArrow(dir: "up" | "down" | "left" | "right"): Command {
    const forward = dir === "down" || dir === "right";
    return (state, dispatch, view) => {
        const embeds = embedsIn(state);
        if (!embeds.length) { return false; }

        const current = selectedEmbedIn(state);
        if (current) {
            const boundary = forward ? current.to : current.from;
            const next = embeds.find((e) => (forward ? e.from === boundary : e.to === boundary));
            if (next) {
                if (dispatch) { dispatch(selectEmbedTr(state, next)); }
                return true;
            }
            const $boundary = state.doc.resolve(boundary);
            const target = Selection.near($boundary, forward ? 1 : -1);
            // No block on that side: consume the key (the card stays selected)
            // rather than let the browser guess.
            if (dispatch && target.from !== state.selection.from) {
                dispatch(state.tr.setSelection(target).scrollIntoView());
            }
            return true;
        }

        const sel = state.selection;
        if (!(sel instanceof TextSelection) || !sel.empty) { return false; }
        const $head = sel.$head;
        if (!atTopLevelEdge($head, forward)) { return false; }
        if (dir === "down" || dir === "up") {
            // Vertical entry only from the last/first visual line — mid-block
            // vertical motion stays native.
            if (!view || !view.endOfTextblock(dir)) { return false; }
        } else if (forward ? $head.parentOffset !== $head.parent.content.size : $head.parentOffset !== 0) {
            return false;
        }
        const boundary = forward ? $head.after(1) : $head.before(1);
        const target = embeds.find((e) => (forward ? e.from === boundary : e.to === boundary));
        if (!target) { return false; }
        if (dispatch) { dispatch(selectEmbedTr(state, target)); }
        return true;
    };
}

/**
 * Backspace/Delete: a selected card deletes its paragraph (deleteBlockRange —
 * fold state stays coherent, the schema-required trailing paragraph is
 * restored). A caret about to eat INTO a card from the adjacent block selects
 * it first — the codeBlockBackspace select-before-delete contract; the second
 * press deletes. Without this, Backspace after a card silently merged the
 * hidden URL into the next paragraph as glued autolink text.
 */
function embedDeleteKey(forward: boolean): Command {
    return (state, dispatch, view) => {
        const embeds = embedsIn(state);
        if (!embeds.length) { return false; }

        const current = selectedEmbedIn(state);
        if (current) {
            if (dispatch && view) { deleteBlockRange(view, { from: current.from, to: current.to }); }
            return true;
        }

        const sel = state.selection;
        if (!(sel instanceof TextSelection) || !sel.empty) { return false; }
        const $head = sel.$head;
        if (!atTopLevelEdge($head, forward)) { return false; }
        if (forward ? $head.parentOffset !== $head.parent.content.size : $head.parentOffset !== 0) {
            return false;
        }
        const boundary = forward ? $head.after(1) : $head.before(1);
        const target = embeds.find((e) => (forward ? e.from === boundary : e.to === boundary));
        if (!target) { return false; }
        if (dispatch) { dispatch(selectEmbedTr(state, target)); }
        return true;
    };
}

/**
 * The palette module is lazy (like the card builder) and managed through one
 * cached import so show/hide calls resolve in dispatch order.
 */
let _paletteModule: Promise<typeof import("../components/embedPalette")> | null = null;
function withPalette(fn: (mod: typeof import("../components/embedPalette")) => void, loadIfNeeded: boolean): void {
    if (!_paletteModule && !loadIfNeeded) { return; }
    _paletteModule ??= import("../components/embedPalette");
    _paletteModule.then(fn).catch(() => { /* palette unavailable; selection still works */ });
}

/** Show/hide the palette to match the selected embed (idempotent per update). */
function syncPalette(view: EditorView, focusUrl = false): void {
    const selected = selectedEmbedIn(view.state);
    if (selected) {
        withPalette((m) => m.showEmbedPalette(view, {
            from: selected.from,
            to: selected.to,
            href: selected.href,
            kind: selected.match.kind,
            id: selected.match.id,
        }, focusUrl), true);
    } else {
        withPalette((m) => m.hideEmbedPalette(), false);
    }
}

export const embedKeymapPlugin = $prose(() =>
    keymap({
        ArrowDown: embedArrow("down"),
        ArrowUp: embedArrow("up"),
        ArrowRight: embedArrow("right"),
        ArrowLeft: embedArrow("left"),
        Backspace: embedDeleteKey(false),
        Delete: embedDeleteKey(true),
        Enter: (state, _dispatch, view) => {
            if (!selectedEmbedIn(state)) { return false; }
            if (view) { syncPalette(view, true); }
            return true;
        },
        // Keyboard parity for the media verb: Space on a selected card toggles
        // play/stop by activating the card's own buttons — the DOM closures
        // own the player lifecycle, so the keymap drives them rather than
        // duplicating it. Info cards (no player) fall through to typing.
        " ": (state, _dispatch, view) => {
            const current = selectedEmbedIn(state);
            if (!current || !view) { return false; }
            const host = view.nodeDOM(current.from) as HTMLElement | null;
            const play = host?.querySelector<HTMLButtonElement>(".embed-card__play");
            const stop = host?.querySelector<HTMLButtonElement>(".embed-card__stop");
            if (play) { play.click(); return true; }
            if (stop && !stop.hidden) { stop.click(); return true; }
            return false;
        },
    }),
);
