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
 * doc full of embeds must not block interactivity. When disabled the decoration
 * function returns DecorationSet.empty on the first read: no scan, no import, no
 * idle pass (the plugin is also composed conditionally in editor.ts).
 */
import type { EditorState, Node as ProseNode } from "../pm";
import { Decoration, DecorationSet, Plugin, PluginKey } from "../pm";
import { $prose } from "@milkdown/utils";
import { requestIdle } from "../utils/idle";
import { recognizeProvider, type EmbedMatch } from "../utils/embedProviders";

/** Upper bound on how long after first paint the first embed pass may wait. */
const FIRST_PASS_IDLE_TIMEOUT_MS = 1000;

/**
 * Whether embeds are ACTIVE: the master network switch (MAR-179, offline by
 * default) AND the per-feature key must both be on. The flags are baked into
 * __i18n at panel load (like calc). When the master is off — the default — this
 * is false, so computeEmbedDecorations returns empty and the idle arm never
 * schedules: no card, no thumbnail, no CSP hosts (webviewHtml.ts gates those on
 * the same pair). The FEATURE key defaults on, so the master is the single
 * off-by-default gate.
 */
function embedsEnabled(): boolean {
    return (window.__i18n?.network ?? false) && (window.__i18n?.embedsEnabled ?? true);
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
        loadEmbedCard()
            .then((mod) => host.replaceChildren(mod.renderEmbedCard(match, sourceUrl)))
            .catch(() => { /* card unavailable; raw link stays reachable */ });
        return host;
    };
}

/**
 * Build the embed decoration set for the current doc + selection. Returns
 * DecorationSet.empty immediately when the feature is off (no provider scan, no
 * widget, no import). Top-level bare-link paragraphs get a host node decoration
 * (hides the link text) and a card widget — EXCEPT the paragraph the selection
 * is in, which is left bare so the raw link is editable (reveal-on-caret).
 * Exported for unit testing.
 */
export function computeEmbedDecorations(state: EditorState): DecorationSet {
    if (!embedsEnabled()) {
        return DecorationSet.empty;
    }
    const { doc, selection } = state;
    const decorations: Decoration[] = [];
    doc.forEach((node, pos) => {
        const href = bareLinkHref(node);
        if (!href) {
            return;
        }
        const match = recognizeProvider(href);
        if (!match) {
            return;
        }
        const from = pos;
        const to = pos + node.nodeSize;
        // Reveal-on-caret: selection inside this paragraph → show the raw link.
        if (selection.to > from && selection.from < to) {
            return;
        }
        decorations.push(
            Decoration.node(from, to, { class: "embed-host" }),
        );
        decorations.push(
            Decoration.widget(from + 1, embedWidget(match, href), {
                side: -1,
                // The position is part of the key: two bare links to the SAME
                // video are two distinct widgets, and same-key widgets would
                // make ProseMirror treat them as one during redraw
                // reconciliation (skipped/misplaced DOM).
                key: `embed:${match.kind}:${match.id}:${from}`,
            }),
        );
    });
    return decorations.length > 0 ? DecorationSet.create(doc, decorations) : DecorationSet.empty;
}

type EmbedState = { armed: boolean; deco: DecorationSet };

type EmbedMeta = { type: "arm" };

const embedPluginKey = new PluginKey<EmbedState>("embed");

export const embedPlugin = $prose(() =>
    new Plugin<EmbedState>({
        key: embedPluginKey,
        state: {
            init: () => ({ armed: false, deco: DecorationSet.empty }),
            apply(tr, value, _oldState, newState) {
                let { armed, deco } = value;
                const meta = tr.getMeta(embedPluginKey) as EmbedMeta | undefined;
                if (meta?.type === "arm") {
                    armed = true;
                }
                if (!armed) {
                    // Nothing renders until the idle arm opens the gate — the
                    // first pass never runs synchronously during mount.
                    return { armed, deco: DecorationSet.empty };
                }
                if (tr.docChanged || tr.selectionSet || meta?.type === "arm") {
                    // Selection changes drive reveal-on-caret; doc changes and the
                    // initial arm rebuild from scratch.
                    deco = computeEmbedDecorations(newState);
                } else {
                    deco = deco.map(tr.mapping, tr.doc);
                }
                return { armed, deco };
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
            let idle: { cancel: () => void } | null = null;
            if (embedsEnabled()) {
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
