/**
 * Fidelity serializer: a vendored, patched copy of Milkdown's
 * `SerializerState`, swapped into `serializerCtx` after `SerializerReady`.
 *
 * Vendored from `@milkdown/transformer@7.21.2`
 * (`node_modules/@milkdown/transformer/src/serializer/state.ts`, plus the
 * unexported `SerializerStackElement` from `stack-element.ts`). Everything is
 * verbatim except two behavioral deltas — RE-DIFF AGAINST THE PACKAGE SOURCE
 * ON EVERY MILKDOWN UPGRADE:
 *
 * (a) Links open outermost. The stock `#runNode` sorts a node's marks by
 *     `spec.priority ?? 50`, which puts `strong`/`emphasis` (50) outside
 *     `link` (50, later mark rank) and produces `**[bold](url)**` for a bold
 *     span inside a link — adjacent link segments then differ in shape and
 *     never merge. Here mark types `link` and `link_ref` sort as priority 25,
 *     so every segment of a formatted link serializes as
 *     `link{...formatting...}` and `#maybeMergeChildren` can rejoin them.
 *
 * (b) Edge-space trimming is deferred until after merging. The stock
 *     `#closeMark` hoists leading/trailing spaces out of EVERY mark's
 *     first/last text child at close time (`#moveSpaces`). That trim is
 *     required for emphasis-like marks — CommonMark forbids `** a**` — but it
 *     runs before sibling mark nodes are merged, so a link's internal
 *     segment-boundary spaces (`[**bold** and code](url)` → `" and "`) leak
 *     out as bare text BETWEEN the split link nodes and block the merge,
 *     splitting one link into several adjacent ones that each repeat the URL.
 *     Here `#closeMark` never trims; instead, after `#maybeMergeChildren`
 *     runs on a non-mark container, `#hoistEdgeSpaces` recursively hoists
 *     leading/trailing spaces out of emphasis-like mark nodes only (`strong`,
 *     `emphasis`, `delete`), from their first/last DIRECT text child into the
 *     parent's child list. `link` / `linkReference` / `inlineCode` are never
 *     trimmed — spaces are legal at their edges.
 *
 * `serializerMatchError` lives in `@milkdown/exception`, which is not a
 * direct dependency under pnpm's strict layout; a plain `Error` replaces it.
 */
import type {
    Fragment,
    MarkType,
    Node,
    NodeType,
    Schema,
} from "@milkdown/prose/model";
import { Mark } from "@milkdown/prose/model";
import type {
    JSONRecord,
    MarkSchema,
    MarkdownNode,
    NodeSchema,
    RemarkParser,
    Root,
    Serializer,
} from "@milkdown/transformer";
import { Stack, StackElement } from "@milkdown/transformer";
import type { Editor } from "@milkdown/core";
import {
    SerializerReady,
    remarkCtx,
    schemaCtx,
    serializerCtx,
} from "@milkdown/core";

type MilkdownPlugin = Exclude<Parameters<Editor["use"]>[0], unknown[]>;

const isFragment = (x: Node | Fragment): x is Fragment =>
    Object.prototype.hasOwnProperty.call(x, "size");

/** ProseMirror mark type names that must open outermost (delta a). */
const LINK_MARK_TYPES = new Set(["link", "link_ref"]);

/** mdast mark node types whose edge spaces must hoist out (delta b). */
const EMPHASIS_LIKE_TYPES = new Set(["strong", "emphasis", "delete"]);

/**
 * Vendored verbatim from `@milkdown/transformer@7.21.2`
 * `src/serializer/stack-element.ts` (the class is not exported from the
 * package entry point).
 */
class SerializerStackElement extends StackElement<MarkdownNode> {
    constructor(
        public type: string,
        public children?: MarkdownNode[],
        public value?: string,
        public props: JSONRecord = {},
    ) {
        super();
    }

    static create = (
        type: string,
        children?: MarkdownNode[],
        value?: string,
        props: JSONRecord = {},
    ) => new SerializerStackElement(type, children, value, props);

    push = (node: MarkdownNode, ...rest: MarkdownNode[]) => {
        if (!this.children) this.children = [];

        this.children.push(node, ...rest);
    };

    pop = (): MarkdownNode | undefined => this.children?.pop();
}

/**
 * Vendored from `@milkdown/transformer@7.21.2` `src/serializer/state.ts`
 * with the two deltas documented in the file header.
 */
export class FidelitySerializerState extends Stack<
    MarkdownNode,
    SerializerStackElement
> {
    /// @internal
    #marks: readonly Mark[] = Mark.none;
    /// Get the schema of state.
    readonly schema: Schema;

    /// Create a serializer from schema and remark instance.
    static create = (schema: Schema, remark: RemarkParser): Serializer => {
        const state = new this(schema);
        return (content: Node) => {
            state.run(content);
            return state.toString(remark);
        };
    };

    /// @internal
    constructor(schema: Schema) {
        super();
        this.schema = schema;
    }

    /// @internal
    #matchTarget = (node: Node | Mark): NodeType | MarkType => {
        const result = Object.values({
            ...this.schema.nodes,
            ...this.schema.marks,
        }).find((x): x is NodeType | MarkType => {
            const spec = x.spec as NodeSchema | MarkSchema;
            return spec.toMarkdown.match(node as Node & Mark);
        });

        if (!result)
            throw new Error(
                `No serializer spec matches node type: ${node.type.name}`,
            );

        return result;
    };

    /// @internal
    #runProseNode = (node: Node) => {
        const type = this.#matchTarget(node);
        const spec = type.spec as NodeSchema;
        return spec.toMarkdown.runner(this as never, node);
    };

    /// @internal
    #runProseMark = (mark: Mark, node: Node) => {
        const type = this.#matchTarget(mark);
        const spec = type.spec as MarkSchema;
        return spec.toMarkdown.runner(this as never, mark, node);
    };

    /// @internal
    #runNode = (node: Node) => {
        const { marks } = node;
        // Delta (a): link-family marks open outermost so every segment of a
        // formatted link keeps the shape link{formatting{text}} and adjacent
        // segments merge back into one link node.
        const getPriority = (x: Mark) =>
            LINK_MARK_TYPES.has(x.type.name) ? 25 : (x.type.spec.priority ?? 50);
        const tmp = [...marks].sort((a, b) => getPriority(a) - getPriority(b));
        const unPreventNext = tmp.every((mark) => !this.#runProseMark(mark, node));
        if (unPreventNext) this.#runProseNode(node);

        marks.forEach((mark) => this.#closeMark(mark));
    };

    /// @internal
    #searchType = (child: MarkdownNode, type: string): MarkdownNode => {
        if (child.type === type) return child;

        if (child.children?.length !== 1) return child;

        const searchNode = (node: MarkdownNode): MarkdownNode | null => {
            if (node.type === type) return node.value != null ? null : node;

            if (node.children?.length !== 1) return null;

            const [firstChild] = node.children;
            if (!firstChild) return null;

            return searchNode(firstChild);
        };

        const target = searchNode(child);

        if (!target) return child;

        const tmp = target.children ? [...target.children] : undefined;
        const node = { ...child, children: tmp };
        node.children = tmp;
        target.children = [node];

        return target;
    };

    /// @internal
    #maybeMergeChildren = (node: MarkdownNode): MarkdownNode => {
        const { children } = node;
        if (!children) return node;

        node.children = children.reduce((nextChildren, child, index) => {
            if (index === 0) return [child];

            const last = nextChildren.at(-1);
            if (last && last.isMark && child.isMark) {
                child = this.#searchType(child, last.type);
                const { children: currChildren, ...currRest } = child;
                const { children: prevChildren, ...prevRest } = last;
                if (
                    child.type === last.type &&
                    currChildren &&
                    prevChildren &&
                    JSON.stringify(currRest) === JSON.stringify(prevRest)
                ) {
                    const next = {
                        ...prevRest,
                        children: [...prevChildren, ...currChildren],
                    };
                    return nextChildren
                        .slice(0, -1)
                        .concat(this.#maybeMergeChildren(next));
                }
            }
            return nextChildren.concat(child);
        }, [] as MarkdownNode[]);

        return node;
    };

    /// @internal
    #createMarkdownNode = (element: SerializerStackElement) => {
        const node: MarkdownNode = {
            ...element.props,
            type: element.type,
        };

        if (element.children) node.children = element.children;

        if (element.value) node.value = element.value;

        return node;
    };

    /// Open a new node, the next operations will
    /// add nodes into that new node until `closeNode` is called.
    openNode = (type: string, value?: string, props?: JSONRecord) => {
        this.open(SerializerStackElement.create(type, undefined, value, props));
        return this;
    };

    /// @internal
    /// Delta (b): replaces the stock `#moveSpaces` close-time trim. Runs
    /// after `#maybeMergeChildren` on non-mark containers and hoists
    /// leading/trailing spaces out of emphasis-like mark nodes only, from
    /// their first/last DIRECT text child into the parent's child list.
    /// Trimming after merging means internal segment-boundary spaces survive
    /// long enough for adjacent same-mark nodes to merge; genuine edge
    /// spaces (a user bolding "bold ") still hoist so the output stays valid
    /// CommonMark. Links, link references and inline code are never trimmed.
    #hoistEdgeSpaces = (node: MarkdownNode): void => {
        const children = node.children;
        if (!children?.length) return;

        const next: MarkdownNode[] = [];
        for (const child of children) {
            // Depth first: nested emphasis hoists into `child` before
            // `child`'s own edges are inspected.
            this.#hoistEdgeSpaces(child);

            const inner = child.children;
            if (!child.isMark || !EMPHASIS_LIKE_TYPES.has(child.type) || !inner?.length) {
                next.push(child);
                continue;
            }

            let leadingSpaces = "";
            let trailingSpaces = "";
            const firstChild = inner[0] as MarkdownNode & { value?: string };
            if (
                firstChild.type === "text" &&
                typeof firstChild.value === "string" &&
                firstChild.value.startsWith(" ")
            ) {
                const text = firstChild.value;
                const trimmed = text.trimStart();
                leadingSpaces = text.slice(0, text.length - trimmed.length);
                firstChild.value = trimmed;
            }
            const lastChild = inner[inner.length - 1] as MarkdownNode & { value?: string };
            if (
                lastChild.type === "text" &&
                typeof lastChild.value === "string" &&
                lastChild.value.endsWith(" ")
            ) {
                const text = lastChild.value;
                const trimmed = text.trimEnd();
                trailingSpaces = text.slice(trimmed.length);
                lastChild.value = trimmed;
            }

            if (leadingSpaces.length)
                next.push({ type: "text", value: leadingSpaces } as MarkdownNode);
            next.push(child);
            if (trailingSpaces.length)
                next.push({ type: "text", value: trailingSpaces } as MarkdownNode);
        }
        node.children = next;
    };

    /// @internal
    /// Delta (b): the stock version takes `trim: boolean` and runs
    /// `#moveSpaces` when closing marks; here nothing trims at close time.
    #closeNodeAndPush = (): MarkdownNode => {
        const element = this.close();

        return this.#addNodeAndPush(
            element.type,
            element.children,
            element.value,
            element.props,
        );
    };

    /// Close the current node and push it into the parent node.
    closeNode = () => {
        this.#closeNodeAndPush();
        return this;
    };

    /// @internal
    #addNodeAndPush = (
        type: string,
        children?: MarkdownNode[],
        value?: string,
        props?: JSONRecord,
    ): MarkdownNode => {
        const element = SerializerStackElement.create(type, children, value, props);
        const node: MarkdownNode = this.#maybeMergeChildren(
            this.#createMarkdownNode(element),
        );
        // Delta (b): once a non-mark container has merged its children, mark
        // segments are final and edge spaces can safely hoist.
        if (!node.isMark) this.#hoistEdgeSpaces(node);
        this.push(node);
        return node;
    };

    /// Add a node into current node.
    addNode = (
        type: string,
        children?: MarkdownNode[],
        value?: string,
        props?: JSONRecord,
    ) => {
        this.#addNodeAndPush(type, children, value, props);
        return this;
    };

    /// @internal
    #openMark = (
        mark: Mark,
        type: string,
        value?: string,
        props?: JSONRecord,
    ) => {
        const isIn = mark.isInSet(this.#marks);

        if (isIn) return this;

        this.#marks = mark.addToSet(this.#marks);
        return this.openNode(type, value, { ...props, isMark: true });
    };

    /// @internal
    #closeMark = (mark: Mark): void => {
        const isIn = mark.isInSet(this.#marks);

        if (!isIn) return;

        this.#marks = mark.type.removeFromSet(this.#marks);
        this.#closeNodeAndPush();
    };

    /// Open a new mark, the next nodes added will have that mark.
    /// The mark will be closed automatically.
    withMark = (mark: Mark, type: string, value?: string, props?: JSONRecord) => {
        this.#openMark(mark, type, value, props);
        return this;
    };

    /// Close a opened mark.
    /// In most cases you don't need this because
    /// marks will be closed automatically.
    closeMark = (mark: Mark) => {
        this.#closeMark(mark);
        return this;
    };

    /// @internal
    build = (): MarkdownNode => {
        let doc: MarkdownNode | null = null;
        do doc = this.#closeNodeAndPush();
        while (this.size());

        return doc;
    };

    /// Give the node or node list back to the state and
    /// the state will find a proper runner (by `match` method in serializer spec) to handle it.
    next = (nodes: Node | Fragment) => {
        if (isFragment(nodes)) {
            nodes.forEach((node) => {
                this.#runNode(node);
            });
            return this;
        }
        this.#runNode(nodes);
        return this;
    };

    /// Use a remark parser to serialize current AST stored.
    override toString = (remark: RemarkParser): string =>
        remark.stringify(this.build() as Root);

    /// Transform a prosemirror node tree into remark AST.
    run = (tree: Node) => {
        this.next(tree);

        return this;
    };
}

/**
 * Swap the fidelity serializer into `serializerCtx` once the stock one is
 * ready. Consumers must read the slice at call time (`getMarkdown()` does;
 * see webview/editor.ts for the listener wiring) — a listener that captures
 * the serializer in a closure at `SerializerReady` may still hold the stock
 * one.
 */
export const fidelitySerializerPlugin: MilkdownPlugin = (ctx) => async () => {
    await ctx.wait(SerializerReady);
    ctx.set(
        serializerCtx,
        FidelitySerializerState.create(ctx.get(schemaCtx), ctx.get(remarkCtx)),
    );
};
