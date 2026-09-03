/**
 * webview/utils/blockDom.ts — the element of every block node, read in ONE
 * walk instead of one `view.nodeDOM` per block.
 *
 * `view.nodeDOM(pos)` answers for a single position by walking the view-desc
 * tree from the document root, child by child, until it reaches `pos`. Asked
 * once per top-level block, that is quadratic in the block count, and on a
 * document of a few thousand blocks a margin click or a drag start spent
 * longer in that walk than in everything else it did. The view's DOM is
 * already the document in order, and ProseMirror stamps every element it
 * renders with its desc (`pmViewDesc`), so the pairing can be read off each
 * content element's children in lockstep with the node's children, at one
 * identity comparison per child.
 *
 * The answer is `nodeDOM`'s for every position, only cheaper: a node the
 * lockstep cannot pair (a stub view in a test, a desc mid-update) is asked of
 * `nodeDOM` itself, so a consumer can hold the two equal and `blockDom.test.ts`
 * does, over a document holding every block kind the schema renders.
 *
 * Inline content is never entered. A textblock's children are text and marks,
 * whose descs pair differently, and no caller here wants them.
 */
import type { EditorView, Node as ProseNode } from "../pm";

/** The slice of a ProseMirror view desc this walk reads. */
interface ViewDescLike {
    node?: ProseNode;
    contentDOM?: Node | null;
    nodeDOM?: Node | null;
}

const descOf = (dom: Node): ViewDescLike | undefined =>
    (dom as Node & { pmViewDesc?: ViewDescLike }).pmViewDesc;

export interface BlockDom {
    node: ProseNode;
    /** The node's position: `view.nodeDOM(pos)` is its element. */
    pos: number;
    dom: HTMLElement | null;
}

/**
 * Pair `parent`'s children with the children of its content element, in
 * order, calling `visit` for each. `contentDom` null means the element could
 * not be found and every child is resolved through `nodeDOM`.
 */
function pairChildren(
    view: EditorView,
    parent: ProseNode,
    firstChildPos: number,
    contentDom: Node | null,
    depth: number,
    maxDepth: number,
    visit: (entry: BlockDom) => void,
): void {
    let cursor: Node | null = contentDom?.firstChild ?? null;
    parent.forEach((child, offset) => {
        const pos = firstChildPos + offset;
        let dom: HTMLElement | null = null;
        let paired: Node | null = null;
        let pairedDesc: ViewDescLike | null = null;
        // Widgets and other node-less descs sit between blocks and are
        // skipped; the next desc that HOLDS a node must be this child's, or
        // the DOM and the document have drifted and the walk stops trusting
        // its cursor for this child.
        for (let scan = cursor; scan; scan = scan.nextSibling) {
            const desc = descOf(scan);
            if (!desc || !desc.node) continue;
            if (desc.node === child) {
                paired = scan;
                pairedDesc = desc;
                const own = desc.nodeDOM ?? scan;
                dom = own instanceof HTMLElement ? own : null;
            }
            break;
        }
        if (paired) {
            cursor = paired.nextSibling;
        } else {
            const fallback = view.nodeDOM(pos);
            dom = fallback instanceof HTMLElement ? fallback : null;
            // Re-anchor behind the element the view names, when it is in
            // this content element at all, so one drift does not cost the
            // rest of the siblings their pairing.
            if (fallback && fallback.parentNode === contentDom) cursor = fallback.nextSibling;
        }
        visit({ node: child, pos, dom });
        if (depth < maxDepth && !child.isTextblock && !child.isLeaf && child.childCount > 0) {
            // The child's content element, read from the desc that was
            // paired: a wrapping node decoration puts the desc on the
            // wrapper and none on the node's own element. A NodeView that
            // renders no content leaves it null, and its children then take
            // the `nodeDOM` path one by one.
            const contentOf = (pairedDesc ?? (dom ? descOf(dom) : undefined))?.contentDOM ?? null;
            pairChildren(view, child, pos + 1, contentOf, depth + 1, maxDepth, visit);
        }
    });
}

/** The document's top-level blocks with their elements, in document order. */
export function topLevelBlockDoms(view: EditorView): BlockDom[] {
    const out: BlockDom[] = [];
    pairChildren(view, view.state.doc, 0, view.dom, 0, 0, (entry) => out.push(entry));
    return out;
}

/**
 * A resolver for the element of any block node, textblocks included and
 * their inline content never entered, built from one walk of the document.
 * A position the walk did not reach (an inline position, a stale one) is
 * answered by `nodeDOM`, so the resolver is a drop-in for it.
 */
export function blockDomResolver(view: EditorView): (pos: number) => HTMLElement | null {
    const index = new Map<number, HTMLElement | null>();
    pairChildren(view, view.state.doc, 0, view.dom, 0, Number.POSITIVE_INFINITY, (entry) => {
        index.set(entry.pos, entry.dom);
    });
    return (pos) => {
        const known = index.get(pos);
        if (known !== undefined) return known;
        // No node starts here (the slot after a list's last item, a parent's
        // end): `nodeDOM` would walk to the same null, so it is not asked.
        if (!view.state.doc.nodeAt(pos)) return null;
        const dom = view.nodeDOM(pos);
        return dom instanceof HTMLElement ? dom : null;
    };
}
