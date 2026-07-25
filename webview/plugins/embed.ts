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
import type { EditorState, EditorView, Node as ProseNode } from "../pm";
import { Decoration, DecorationSet, Plugin, PluginKey } from "../pm";
import { $prose } from "@milkdown/utils";
import { requestIdle } from "../utils/idle";
import { providerFor, recognizeProvider, type EmbedMatch } from "../utils/embedProviders";

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
 * off the render frame; a failed import or offline thumbnail simply leaves the
 * host empty — the raw link is still reachable by clicking into the paragraph.
 */
function embedWidget(match: EmbedMatch, sourceUrl: string): () => HTMLElement {
    return () => {
        const host = document.createElement("div");
        host.className = "embed-card-host";
        host.setAttribute("contenteditable", "false");
        // Hardening, not a bug fix: keep the editor caret where it is so a
        // click on the card is the card's alone. Measured 2026-07-18 (e2e,
        // headless Chromium): WITHOUT this the card already survives a click
        // and play still works, because the browser will not put a caret inside
        // a contenteditable="false" widget, so reveal-on-caret never fires. The
        // guard makes that independent of the host's caret placement rather
        // than reliant on it, and matches every other clickable widget in the
        // tree (ui/foldEllipsis.ts, headingFold/foldGutter.ts, imageView).
        host.addEventListener("mousedown", (event) => {
            event.preventDefault();
            event.stopPropagation();
        });
        loadEmbedCard()
            .then((mod) => host.replaceChildren(mod.renderEmbedCard(match, sourceUrl)))
            .catch(() => { /* card unavailable; raw link stays reachable */ });
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
        embeds.push({ from: pos, to: pos + node.nodeSize, match, href });
    });
    return embeds;
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
        // Reveal-on-caret: selection inside this paragraph → show the raw link.
        if (selection.to > embed.from && selection.from < embed.to) {
            continue;
        }
        decorations.push(
            Decoration.node(embed.from, embed.to, { class: "embed-host" }),
        );
        decorations.push(
            Decoration.widget(embed.from + 1, embedWidget(embed.match, embed.href), {
                side: -1,
                // The position is part of the key: two bare links to the SAME
                // video are two distinct widgets, and same-key widgets would
                // make ProseMirror treat them as one during redraw
                // reconciliation (skipped/misplaced DOM).
                key: `embed:${embed.match.kind}:${embed.match.id}:${embed.from}`,
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
            return {
                destroy() {
                    idle?.cancel();
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
