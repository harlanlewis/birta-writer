/**
 * Replacement for `@milkdown/plugin-prism`'s `prismPlugin` — same decorations,
 * without the two whole-document walks it ran on every transaction (MAR-137).
 *
 * What the behavior is: syntax-highlight decorations over `code_block` content,
 * recomputed when a code block's text, count, or language could have changed
 * and otherwise carried forward by mapping the existing set.
 *
 * Upstream's `apply` opens with:
 *
 *     const isNodeName         = state.selection.$head.parent.type.name === name;
 *     const isPreviousNodeName = oldState.selection.$head.parent.type.name === name;
 *     const oldNode = findChildren(n => n.type.name === name)(oldState.doc);
 *     const newNode = findChildren(n => n.type.name === name)(state.doc);
 *     if (transaction.docChanged && ( … )) return getDecorations(…);
 *     return decorationSet.map(transaction.mapping, transaction.doc);
 *
 * Both `findChildren` calls are **unconditional and eager**, and `findChildren`
 * is `flatten().filter()` — a full recursive `descendants` walk that pushes
 * EVERY node in the document into an array before filtering it down to the
 * code blocks. So each transaction built two arrays of the whole document, and
 * because the walks sit above the `transaction.docChanged` test they ran on
 * selection-only transactions too — every arrow key, every click.
 *
 * Measured on the 300 KB `xlarge` fixture: a selection-only `state.apply` cost
 * 2.40 ms, of which 1.70 ms (71%) was this plugin — a cost the typing harness
 * cannot see at all, because `instrumentTransactions` only stamps doc-changing
 * transactions. It was also 4.48 ms/key (18%) of typing dispatch.
 *
 * Two corrections, in increasing order of how much thought they need:
 *
 *   1. **The walks are lazy.** `docChanged` is tested first, and the two cheap
 *      caret tests short-circuit ahead of the walks, exactly as the `||` chain
 *      already implied. This is a pure evaluation-order change — same inputs,
 *      same result — and it alone removes the whole selection-only cost.
 *   2. **An edit confined to one non-`code_block` textblock's inline content
 *      cannot change the code blocks at all** — not their count, not their
 *      language attr (attrs are untouched by an inline edit), and no step of
 *      it can span a code block. So the decorations are carried forward
 *      without walking. Same `singleTextblockInlineEdit` used by the Contents
 *      outline, the Notes scanner, and `keepTableAlign.ts`.
 *
 * Deliberately NOT changed: upstream recomputes whenever the caret sits in a
 * code block, even on an edit elsewhere. That is redundant (recomputing from
 * an unchanged doc yields the same decorations) but harmless, and preserving
 * it keeps this a performance change rather than a behavioral one.
 *
 * ## Keeping a vendored fork honest
 *
 * The decoration computation below is transcribed from `@milkdown/plugin-prism`
 * **7.21.2**, because `getDecorations` is not exported and a plugin's `apply`
 * cannot be intercepted from outside. A transcription that drifts from upstream
 * would surface as wrong syntax highlighting — silently, since no perf gate can
 * see it.
 *
 * The version above is a note for humans; the actual contract is
 * `__tests__/prismHighlight.test.ts`, which registers upstream's plugin
 * ALONGSIDE this one over every corpus fixture and asserts the two decoration
 * sets are identical. That compares against whatever version is installed, so
 * it doubles as an upgrade guard: a future bump that changes upstream's
 * decorations fails on the upgrade PR rather than shipping divergence. Keep
 * upstream installed and registered in that test even though production
 * filters it out — the comparison is the whole point.
 */
import type { EditorState, Node as ProseNode, Transaction } from "../pm";
import { Decoration, DecorationSet, Plugin, PluginKey } from "../pm";
import { $prose } from "@milkdown/utils";
import { prismConfig } from "@milkdown/plugin-prism";
// `refractor/core`, via our own module — NOT the bare "refractor" entrypoint
// upstream's plugin imports. Both name the same singleton (verified: `===` is
// true), but the bare entrypoint is `refractor/lib/common.js`, which pulls all
// 62 bundled grammars into the EAGER graph — the regression MAR-219 exists to
// prevent, and the reason `highlighter.ts` is written the way it is.
import { refractor } from "../highlighter";
import { singleTextblockInlineEdit } from "../utils/textblockEdit";

const NAME = "code_block";

type RefractorLike = {
    highlight: (value: string, language: string) => { children: unknown[] };
    listLanguages: () => string[];
};

type HastNode = { type?: string; value?: string; children?: HastNode[]; properties?: { className?: string[] } };

/** Flatten refractor's hast tree to text runs carrying their class names. */
function flatNodes(nodes: HastNode[], className: string[] = []): { text: string; className: string[] }[] {
    return nodes.flatMap((node) =>
        node.type === "element"
            ? flatNodes(node.children ?? [], [...className, ...(node.properties?.className ?? [])])
            : [{ text: node.value ?? "", className }],
    );
}

/** Every code block in the doc, as [pos, node] pairs. Top-level-or-nested. */
function codeBlocks(doc: ProseNode): { pos: number; node: ProseNode }[] {
    const found: { pos: number; node: ProseNode }[] = [];
    doc.descendants((node: ProseNode, pos: number) => {
        if (node.type.name === NAME) {
            found.push({ pos, node });
            return false;
        }
        return true;
    });
    return found;
}

function getDecorations(doc: ProseNode, refractorInstance: RefractorLike): DecorationSet {
    const { highlight, listLanguages } = refractorInstance;
    const allLanguages = listLanguages();
    const decorations: Decoration[] = [];
    for (const block of codeBlocks(doc)) {
        let from = block.pos + 1;
        const language = block.node.attrs["language"] as string | undefined;
        if (!language || !allLanguages.includes(language)) {
            // Kept verbatim from upstream: this is a performance change, and
            // silently dropping a diagnostic is not part of it.
            console.warn(
                "Unsupported language detected, this language has not been supported by current prism config: ",
                language,
            );
            continue;
        }
        for (const node of flatNodes(highlight(block.node.textContent, language).children as HastNode[])) {
            const to = from + node.text.length;
            if (node.className.length) {
                decorations.push(Decoration.inline(from, to, { class: node.className.join(" ") }));
            }
            from = to;
        }
    }
    return DecorationSet.create(doc, decorations);
}

/**
 * True when this transaction cannot have changed anything the decorations
 * depend on: the whole diff sits inside one textblock's inline content and
 * that textblock is not a code block.
 */
function cannotAffectCodeBlocks(oldState: EditorState, state: EditorState): boolean {
    const edit = singleTextblockInlineEdit(oldState.doc, state.doc);
    if (!edit) {
        return false;
    }
    return edit.kind === "identical" || edit.nextBlock.type.name !== NAME;
}

export const prismHighlightPlugin = $prose((ctx) => {
    const { configureRefractor } = ctx.get(prismConfig.key);
    const configured = (configureRefractor(refractor) ?? refractor) as RefractorLike;
    return new Plugin<DecorationSet>({
        key: new PluginKey("birtaPrismHighlight"),
        state: {
            init: (_, { doc }) => getDecorations(doc, configured),
            apply: (transaction: Transaction, decorationSet: DecorationSet, oldState: EditorState, state: EditorState) => {
                // The plugin's contract, stated where it is easiest to read: a
                // decoration can only change when the document does. Kept for
                // that reason and NOT as an optimization — measured against
                // removing it, selection-only `state.apply` is 0.600 ms either
                // way, because the `identical` branch below already catches
                // this case. Deleting it would leave the contract implicit.
                if (!transaction.docChanged) {
                    return decorationSet;
                }
                if (cannotAffectCodeBlocks(oldState, state)) {
                    return decorationSet.map(transaction.mapping, transaction.doc);
                }
                if (
                    state.selection.$head.parent.type.name === NAME ||
                    oldState.selection.$head.parent.type.name === NAME
                ) {
                    return getDecorations(transaction.doc, configured);
                }
                // Only now is a walk warranted.
                const oldBlocks = codeBlocks(oldState.doc);
                const newBlocks = codeBlocks(state.doc);
                const changed =
                    oldBlocks.length !== newBlocks.length ||
                    oldBlocks[0]?.node.attrs["language"] !== newBlocks[0]?.node.attrs["language"] ||
                    transaction.steps.some((step) => {
                        const { from, to } = step as unknown as { from?: number; to?: number };
                        if (from === undefined || to === undefined) {
                            return false;
                        }
                        return oldBlocks.some((b) => b.pos >= from && b.pos + b.node.nodeSize <= to);
                    });
                return changed
                    ? getDecorations(transaction.doc, configured)
                    : decorationSet.map(transaction.mapping, transaction.doc);
            },
        },
        props: {
            decorations(state) {
                return this.getState(state);
            },
        },
    });
});
