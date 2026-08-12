/**
 * Live inline HTML pairs (MAR-14): `<u>text</u>` styled as underlined text.
 *
 * A paired inline tag parses as THREE inlines — an `html` atom, text, an
 * `html` atom — so each atom sanitizes to an EMPTY element and the pair
 * renders as nothing, while the text between stays plain. This plugin makes
 * the pair legible without touching the document: an inline DECORATION
 * styles the span between a matched open/close pair, and node decorations
 * dim the tag atoms to quiet monospace chips. Decoration-only, so the
 * serialized bytes cannot change (annotation is advisory and reversible).
 *
 * Scope, deliberately narrow: bare tags only (`<u>`, no attributes), the
 * MAR-14 list (u, sub, sup, kbd, mark — br and img are void and already
 * render through the sanitizer), matched within one textblock, innermost
 * pair wins via a per-tag stack. An attributed or unclosed tag keeps
 * today's behavior. Case-insensitive, as HTML is.
 *
 * Cost: recompute is bounded to the textblocks a transaction touched; every
 * other decoration is mapped. A selection-only transaction never rescans
 * (the anchorSync lesson: per-keystroke whole-document walks become tickets).
 *
 * Also here: the Mod+Enter keymap opening the source panel of a
 * NodeSelection'd html atom (components/htmlView owns the panel itself).
 */
import "./htmlLivePairs.css";
import { $prose } from "@milkdown/utils";
import type { EditorState, Node as PMNode } from "../pm";
import { Decoration, DecorationSet, Plugin, PluginKey, keymap } from "../pm";
import { openSelectedHtmlEditor } from "../components/htmlView";

export const LIVE_PAIR_TAGS = ["u", "sub", "sup", "kbd", "mark"] as const;

const OPEN_RE = new RegExp(`^<(${LIVE_PAIR_TAGS.join("|")})>$`, "i");
const CLOSE_RE = new RegExp(`^</(${LIVE_PAIR_TAGS.join("|")})>$`, "i");

/** One matched pair, in absolute positions. */
export interface LivePair {
    tag: string;
    openFrom: number;
    closeFrom: number;
}

/** Match open/close html atoms inside one textblock (per-tag stacks). */
export function pairsInBlock(block: PMNode, blockStart: number): LivePair[] {
    const open = new Map<string, number[]>();
    const pairs: LivePair[] = [];
    block.forEach((child, offset) => {
        if (child.type.name !== "html") {
            return;
        }
        const raw = ((child.attrs["value"] as string | undefined) ?? "").trim();
        const opens = OPEN_RE.exec(raw);
        if (opens) {
            const tag = opens[1]!.toLowerCase();
            (open.get(tag) ?? open.set(tag, []).get(tag)!).push(blockStart + offset);
            return;
        }
        const closes = CLOSE_RE.exec(raw);
        if (closes) {
            const tag = closes[1]!.toLowerCase();
            const openFrom = open.get(tag)?.pop();
            if (openFrom !== undefined) {
                pairs.push({ tag, openFrom, closeFrom: blockStart + offset });
            }
        }
    });
    return pairs;
}

/** Decorations for one textblock's pairs. */
function blockDecorations(block: PMNode, blockStart: number): Decoration[] {
    const decos: Decoration[] = [];
    for (const { tag, openFrom, closeFrom } of pairsInBlock(block, blockStart)) {
        decos.push(
            Decoration.node(openFrom, openFrom + 1, { class: "html-tag--paired" }),
            Decoration.node(closeFrom, closeFrom + 1, { class: "html-tag--paired" }),
        );
        if (closeFrom > openFrom + 1) {
            decos.push(
                Decoration.inline(openFrom + 1, closeFrom, {
                    class: `html-live html-live-${tag}`,
                }),
            );
        }
    }
    return decos;
}

/** Build the full set for a document (init, and the test seam). */
export function livePairDecorations(doc: PMNode): DecorationSet {
    const decos: Decoration[] = [];
    doc.descendants((node, pos) => {
        if (node.isTextblock) {
            decos.push(...blockDecorations(node, pos + 1));
            return false;
        }
        return true;
    });
    return decos.length ? DecorationSet.create(doc, decos) : DecorationSet.empty;
}

const key = new PluginKey<DecorationSet>("MDW_HTML_LIVE_PAIRS");

export const htmlLivePairsPlugin = $prose(
    () =>
        new Plugin<DecorationSet>({
            key,
            state: {
                init: (_config, state) => livePairDecorations(state.doc),
                apply(tr, set, _old, newState) {
                    if (!tr.docChanged) {
                        return set.map(tr.mapping, tr.doc);
                    }
                    let mapped = set.map(tr.mapping, tr.doc);
                    // Recompute only the textblocks the transaction touched.
                    const touched: Array<{ from: number; to: number }> = [];
                    tr.mapping.maps.forEach((stepMap, i) => {
                        stepMap.forEach((_os, _oe, newStart, newEnd) => {
                            const slice = tr.mapping.slice(i + 1);
                            touched.push({
                                from: slice.map(newStart, -1),
                                to: slice.map(newEnd, 1),
                            });
                        });
                    });
                    const doc = newState.doc;
                    const seen = new Set<number>();
                    for (const { from, to } of touched) {
                        const lo = Math.max(0, Math.min(from, doc.content.size));
                        const hi = Math.max(0, Math.min(to, doc.content.size));
                        doc.nodesBetween(lo, hi, (node, pos) => {
                            if (!node.isTextblock) {
                                return true;
                            }
                            if (!seen.has(pos)) {
                                seen.add(pos);
                                mapped = mapped.remove(
                                    mapped.find(pos, pos + node.nodeSize),
                                );
                                const fresh = blockDecorations(node, pos + 1);
                                if (fresh.length) {
                                    mapped = mapped.add(doc, fresh);
                                }
                            }
                            return false;
                        });
                    }
                    return mapped;
                },
            },
            props: {
                decorations(state: EditorState): DecorationSet | undefined {
                    return key.getState(state);
                },
            },
        }),
);

/**
 * Mod-Enter on a NodeSelection'd html atom opens its source panel; every
 * other selection falls through to insertParagraph's Mod-Enter (registered
 * later, so this binding is consulted first and must decline). A PM keymap,
 * not a raw modifier read, so the chord is recorded in keymapChords.ts.
 */
export const htmlEditKeymapPlugin = $prose(
    () =>
        keymap({
            "Mod-Enter": (_state, _dispatch, view) =>
                view ? openSelectedHtmlEditor(view) : false,
        }),
);
