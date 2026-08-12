/**
 * webview/plugins/invisibleParagraph.ts (MAR-360)
 *
 * A top-level paragraph with nothing visible in it — empty, or holding only
 * hard breaks — must serialize to NOTHING, not to blank lines.
 *
 * Markdown has no spelling for an empty paragraph (MAR-123's settled policy:
 * an empty paragraph is not content), so the stock runner emits an empty
 * mdast paragraph whose block separators still surround it: two blank lines
 * where the node sits. Those bytes poison the saved file through a gesture as
 * small as add-a-paragraph-then-delete-it. The sync that lands while the
 * emptied node still exists (mid-backspace) merges the serializer's blank
 * lines into the file; the next sync serializes clean, but a blank-line-only
 * difference is deliberately invisible to the minimal-diff merge (user
 * blank-line style is preserved, MAR-313/MAR-290), so the residue is
 * permanent. Emitting no node at all is the only spelling with no residue in
 * any position — between blocks, at document start, at document end, or
 * stacked.
 *
 * ROOT LEVEL ONLY. Inside a list item an empty paragraph is load-bearing:
 * itemContentGapJoin (webview/serialization.ts) glues an item's leading empty
 * paragraph by policy (MAR-306/MAR-309), and dropping the node instead would
 * move the item's first real block onto the marker line — a different
 * spelling than the one measured and chosen there. Blockquotes and callouts
 * keep the stock behavior for the same reason: their spacing decisions belong
 * to their own serializers, and their `>` residue lines are significant to
 * the merge, so they self-heal where root blank lines cannot.
 *
 * The drop STANDS DOWN on a document whose top level is entirely invisible
 * paragraphs, because dropping every child leaves mdast's root with no
 * `children` array at all and remark-stringify's root handler reads
 * `children.some(...)` unconditionally. Such a document has no residue to
 * remove anyway.
 *
 * That question is answered from the doc being SERIALIZED, recorded by the
 * wrapper below, and never from the live view. The two are not the same
 * document: `getProtection` serializes the baseline snapshot while the view
 * holds the user's edits, so a view read answers about the wrong doc — on an
 * empty file edited before the idle protection compute it would drop the
 * snapshot's only paragraph, throw inside getProtection's catch, and leave
 * the session with no round-trip protection at all.
 */
import { SerializerReady, serializerCtx, type Editor } from "@milkdown/core";
import { paragraphSchema } from "@milkdown/preset-commonmark";

type MilkdownPlugin = Exclude<Parameters<Editor["use"]>[0], unknown[]>;

/** The minimal node surface both predicates read. */
interface BlockNodeLike {
    content: { size: number };
    childCount: number;
    child: (i: number) => BlockNodeLike & { type: { name: string } };
}

/**
 * Whether the serialization in flight may drop invisible paragraphs: false
 * until the wrapper has judged a document, so a serialize that somehow
 * reaches the runner without one keeps the stock spelling.
 */
let _mayDrop = false;

/** Nothing visible: no inline content, or only hard breaks. */
function isInvisibleParagraph(node: BlockNodeLike): boolean {
    if (node.content.size === 0) return true;
    for (let i = 0; i < node.childCount; i++) {
        if (node.child(i).type.name !== "hardbreak") return false;
    }
    return true;
}

/** Does at least one top-level block survive the drop? */
function hasVisibleTopLevelBlock(doc: BlockNodeLike): boolean {
    for (let i = 0; i < doc.childCount; i++) {
        const child = doc.child(i);
        if (!(child.type.name === "paragraph" && isInvisibleParagraph(child))) return true;
    }
    return false;
}

/**
 * Judge the document once per serialization and hold the verdict for the
 * runners beneath it. Saved and restored rather than cleared, so a nested
 * serialize returns the outer document's verdict to the outer document.
 *
 * Wraps `serializerCtx` the way plugins/serializerPostPass.ts does, and
 * composes with it in either order: this one only brackets the call.
 */
const paragraphInvisibleDocPlugin: MilkdownPlugin = (ctx) => async () => {
    await ctx.wait(SerializerReady);
    const inner = ctx.get(serializerCtx);
    ctx.set(serializerCtx, (doc) => {
        const previous = _mayDrop;
        _mayDrop = hasVisibleTopLevelBlock(doc as unknown as BlockNodeLike);
        try {
            return inner(doc);
        } finally {
            _mayDrop = previous;
        }
    });
};

/**
 * `paragraph` schema whose toMarkdown runner skips an invisible paragraph
 * sitting directly under the document root (the serializer stack's open
 * element is mdast's `root`). Everything else delegates to the stock runner.
 */
export const paragraphInvisibleSchema = paragraphSchema.extendSchema((prev) => (ctx) => {
    const base = prev(ctx);
    return {
        ...base,
        toMarkdown: {
            match: base.toMarkdown.match,
            runner: (state: any, node: any) => {
                if (_mayDrop && state.top()?.type === "root" && isInvisibleParagraph(node)) return;
                base.toMarkdown.runner(state, node);
            },
        },
    };
});

/**
 * The paragraph override plus the doc-recording wrapper, flattened for
 * `Editor.use()`. Registered AFTER the preset with the stock schema left in
 * place (the list_item-after-gfm pattern, NOT the sourceStyle filter
 * pattern): paragraph is the schema's default block fill, and filtering the
 * stock plugin moves the node's registration to this late slot, where `doc`'s
 * `block+` stops resolving to it and createAndFill recurses forever
 * (schemaNodeOrder.test.ts).
 */
export const paragraphInvisiblePlugins = [
    paragraphInvisibleSchema,
    paragraphInvisibleDocPlugin,
].flat();
