/**
 * webview/editing/blockSource.ts
 *
 * The block-level source round trip behind source-peek (MAR-20): turn a range
 * of top-level blocks into Markdown the user can edit, and turn their edited
 * Markdown back into blocks.
 *
 * ── Why parsing a block ALONE is wrong ──────────────────────────────────────
 *
 * Reference links, reference images and footnote references are DOCUMENT
 * scoped: `[text][ref]` and `[^1]` mean what they mean because a definition
 * sits elsewhere in the file. Serializing one block emits the reference
 * faithfully, but parsing that block on its own finds no definition, so the
 * reference degrades to literal text and the next serialization escapes its
 * brackets — `[^1]` becomes `\[^1]`, silently, in the one surface whose whole
 * purpose is precise syntax control.
 *
 * So the parse runs with the document's definitions appended, and only the
 * blocks before the boundary marker are kept. `blockSourceRoundTrip.test.ts`
 * measures both arms over the corpus and is the reason this module is shaped
 * this way; run it rather than trusting this paragraph.
 *
 * ── Coverage boundary ───────────────────────────────────────────────────────
 *
 * TOP-LEVEL blocks only — the children of the document. A list is edited as a
 * whole list, not one item at a time: a lone `list_item` has no standalone
 * Markdown spelling (`- foo` parses back as a list WRAPPING an item), so the
 * node the user edited is not the node type that returns. Per-item editing
 * needs its own design and is not this.
 */
import { Fragment } from "../pm";
import type { Node as ProseNode, Schema } from "../pm";

/** Definition blocks are document-scoped: a reference resolves against them. */
const DEFINITION_TYPES = new Set(["link_definition", "footnote_definition"]);

/**
 * Separates the user's blocks from the definitions appended after them. A
 * paragraph of exactly this text is what the parse leaves behind, and text a
 * user could plausibly type would defeat a friendlier marker.
 */
const BOUNDARY = "zzbirtablocksourceboundaryzz";

export interface BlockSourcePipeline {
    serialize(doc: ProseNode): string;
    parse(markdown: string): ProseNode | null;
}

/** Wrap `nodes` in a standalone document of `schema` so they can serialize. */
function soloDoc(schema: Schema, nodes: readonly ProseNode[]): ProseNode {
    return schema.topNodeType.create(null, Fragment.from(nodes as ProseNode[]));
}

/** Every definition in `doc`, as Markdown — the scope references resolve in. */
function definitionsOf(pipeline: BlockSourcePipeline, doc: ProseNode): string {
    const defs: ProseNode[] = [];
    doc.forEach((node) => {
        if (DEFINITION_TYPES.has(node.type.name)) defs.push(node);
    });
    return defs.length ? pipeline.serialize(soloDoc(doc.type.schema, defs)) : "";
}

/** The Markdown for `nodes`, as the file would spell them. */
export function sourceOfBlocks(
    pipeline: BlockSourcePipeline,
    schema: Schema,
    nodes: readonly ProseNode[],
): string {
    return pipeline.serialize(soloDoc(schema, nodes));
}

/**
 * Parse `text` back into blocks, with `doc`'s definitions in scope.
 *
 * Returns null when the text cannot be parsed at all. An EMPTY array is a
 * legitimate result (the user cleared the block) and is distinct from null.
 */
export function blocksFromSource(
    pipeline: BlockSourcePipeline,
    doc: ProseNode,
    text: string,
): ProseNode[] | null {
    const defs = definitionsOf(pipeline, doc);
    const parsed = pipeline.parse(`${text}\n\n${BOUNDARY}\n\n${defs}`);
    if (parsed) {
        const kids: ProseNode[] = [];
        let sawBoundary = false;
        parsed.forEach((node) => {
            if (sawBoundary) return;
            if (node.textContent.trim() === BOUNDARY) {
                sawBoundary = true;
                return;
            }
            kids.push(node);
        });
        if (sawBoundary) return kids;
    }

    // The marker is gone, which means a construct in `text` ran to the end of
    // the input and swallowed it: an unclosed fence, `<pre>`, `<!--`, or `$$`.
    // Those are all VALID Markdown, and refusing them would make the one
    // surface built for precise syntax control reject the deliberately
    // unclosed fence BENEFITS.md says the editor preserves.
    //
    // Parse without the definitions instead. Nothing after an unterminated
    // construct can reference a definition anyway, so the scope this drops is
    // scope the input could not have used.
    const bare = pipeline.parse(text);
    return bare ? collectChildren(bare) : null;
}

/** The top-level children of `doc`, as an array. */
function collectChildren(doc: ProseNode): ProseNode[] {
    const out: ProseNode[] = [];
    doc.forEach((node) => out.push(node));
    return out;
}
