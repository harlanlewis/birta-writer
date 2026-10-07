/**
 * `<details>` disclosure blocks, as GitHub READMEs and issues write them:
 *
 *   <details>
 *   <summary>Timestamps</summary>
 *
 *   - Markdown inside, because a blank line separates it from the tags.
 *
 *   </details>
 *
 * CommonMark ends an HTML block at a blank line, so the mdast arrives as
 * SIBLINGS: html("<details>\n<summary>…</summary>"), the body's own parsed
 * blocks, then html("</details>"). Rendered one by one, that is an empty
 * disclosure widget, the body loose beneath it, and a second empty one for
 * the closer. The transform here pairs the opener with its closer (counting
 * nested openers, so a details inside a details pairs inside-out) and wraps
 * what lies between into one `details` node. Nothing is sub-parsed: the body
 * blocks are the ones the parser already produced, positions and all.
 *
 * The opener is kept as its EXACT bytes (`opener` attr), the wikilink and
 * callout-marker philosophy: an untouched details serializes back to the
 * line(s) it was read from. Three opener spellings are recognised, which are
 * the three every generator writes:
 *
 *   <details>\n<summary>X</summary>     summary on the next line (GitHub's own)
 *   <details><summary>X</summary>       summary on the same line
 *   <details>  then, after a blank line, <summary>X</summary> as its own block
 *
 * plus `<details open>`, and no summary at all (a browser draws "Details").
 * The summary must be plain text (entities allowed): a summary holding tags
 * cannot be edited as text and rewritten provably, so that details stays the
 * inert HTML it was. So does every shape this grammar does not name, an
 * unclosed `<details>` above all, and a details written as ONE html block
 * (no blank lines inside), whose body a CommonMark renderer never parses as
 * Markdown either.
 *
 * What is NOT a summary is the place generators most often go wrong, and the
 * transform deliberately does not paper over it: a `<summary>` line indented
 * four spaces after a blank line is an indented code block in every
 * CommonMark renderer, GitHub's included, so it renders as code inside the
 * disclosure here too.
 *
 * Open or closed is the source's `open` attribute, and the editor maps it to
 * the fold layer: a details without `open` loads folded to its summary row,
 * the way a `[!note]-` callout does, and folding or unfolding it afterwards
 * is view state that never touches the document (plugins/headingFold).
 */
import { $command, $nodeSchema, $remark } from "@milkdown/utils";
import { wrapBlocksIn, wrapTarget } from "../editing/wrapBlocks";

export const detailsId = "details";

// ─── Opener grammar ─────────────────────────────────────────────────────────

/**
 * `<details>` or `<details open>` (any spelling of the boolean attribute), with
 * an optional plain-text `<summary>` on the same line or the next. Case is
 * accepted as HTML accepts it; the bytes are kept either way.
 */
const OPENER_RE =
    /^<details((?:[ \t]+open(?:[ \t]*=[ \t]*(?:"[^"]*"|'[^']*'|[^\s>]*))?)?)[ \t]*>(?:([ \t]*\n?[ \t]*)<summary>([^<]*)<\/summary>)?[ \t]*$/i;

/** A `<summary>` written as its own block after a bare opener. */
const SUMMARY_BLOCK_RE = /^<summary>([^<]*)<\/summary>[ \t]*$/i;

/** Any line that opens a details, recognised or not: what the depth counts. */
const ANY_OPENER_RE = /^<details[\s>]/i;
const CLOSER_RE = /^<\/details>$/i;

export interface ParsedOpener {
    open: boolean;
    /** The summary's text with entities decoded, or null when there is none. */
    summary: string | null;
}

/** Reads an opener's bytes, or null when they are outside the grammar. */
export function parseOpener(opener: string): ParsedOpener | null {
    const lines = opener.split("\n\n");
    if (lines.length > 2) {
        return null;
    }
    const head = OPENER_RE.exec(lines[0] ?? "");
    if (!head) {
        return null;
    }
    const open = (head[1] ?? "").trim() !== "";
    if (lines.length === 2) {
        const block = head[3] === undefined ? SUMMARY_BLOCK_RE.exec(lines[1] ?? "") : null;
        return block ? { open, summary: decodeEntities(block[1] ?? "") } : null;
    }
    return { open, summary: head[3] === undefined ? null : decodeEntities(head[3]) };
}

const NAMED_ENTITIES: Record<string, string> = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: "\"",
    apos: "'",
    nbsp: " ",
};

/** The handful of entities a summary written by hand or by a generator uses. */
export function decodeEntities(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#[0-9]+|[a-z]+);/gi, (whole, body: string) => {
        if (body[0] === "#") {
            const code = body[1] === "x" || body[1] === "X"
                ? parseInt(body.slice(2), 16)
                : parseInt(body.slice(1), 10);
            return Number.isFinite(code) && code > 0 && code <= 0x10ffff
                ? String.fromCodePoint(code)
                : whole;
        }
        return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
    });
}

/**
 * The summary as HTML text. `&` and `<` are what HTML needs; `>` is escaped
 * too, so a typed `</summary>` cannot be read back as markup by anything.
 */
export function escapeSummary(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * The opener with its summary replaced, everything else kept: the `<details>`
 * tag's own bytes and whichever of the three summary placements it used. An
 * empty summary removes the element, which is the source spelling of "no
 * summary" (the browser's own "Details" label). Adding one to an opener that
 * had none uses GitHub's placement, the next line.
 */
export function openerWithSummary(opener: string, summary: string): string {
    const text = summary.trim();
    const parts = opener.split("\n\n");
    const tag = /^<details[^>]*>/i.exec(parts[0] ?? "")?.[0] ?? "<details>";
    if (parts.length === 2) {
        return text === "" ? tag : `${tag}\n\n<summary>${escapeSummary(text)}</summary>`;
    }
    const head = OPENER_RE.exec(parts[0] ?? "");
    const separator = head?.[3] !== undefined ? (head[2] ?? "\n") : "\n";
    return text === "" ? tag : `${tag}${separator}<summary>${escapeSummary(text)}</summary>`;
}

export const DEFAULT_OPENER = "<details>";

/** Attrs for an opener's bytes. Callers have already checked the grammar. */
export function attrsFromOpener(opener: string): {
    opener: string;
    open: boolean;
    summary: string;
    hasSummary: boolean;
} {
    const parsed = parseOpener(opener) ?? { open: false, summary: null };
    return {
        opener,
        open: parsed.open,
        summary: parsed.summary ?? "",
        hasSummary: parsed.summary !== null,
    };
}

// ─── Parse: html-block pairing ──────────────────────────────────────────────

interface MdastNode {
    type: string;
    value?: string;
    opener?: string;
    children?: MdastNode[];
    position?: unknown;
}

const isHtml = (node: MdastNode | undefined, re: RegExp): boolean =>
    node?.type === "html" && typeof node.value === "string" && re.test(node.value.trim());

/**
 * The index of the closer that matches the opener at `from`, counting every
 * details opener between (recognised or not, since an unrecognised one still
 * claims a closer in the browser), or -1 when the parent ends first.
 */
function matchingCloser(children: MdastNode[], from: number): number {
    let depth = 0;
    for (let j = from; j < children.length; j++) {
        const node = children[j];
        if (isHtml(node, ANY_OPENER_RE) && !/<\/details>\s*$/i.test(node!.value!)) {
            depth++;
        } else if (isHtml(node, CLOSER_RE)) {
            depth--;
            if (depth === 0) {
                return j;
            }
        }
    }
    return -1;
}

/** Wraps every recognised details run among one parent's children. */
export function wrapDetails(children: MdastNode[]): MdastNode[] {
    const out: MdastNode[] = [];
    let i = 0;
    while (i < children.length) {
        const node = children[i]!;
        if (node.type === "html" && typeof node.value === "string" && OPENER_RE.test(node.value)) {
            let opener = node.value;
            let bodyStart = i + 1;
            const bare = parseOpener(opener)?.summary === null;
            const next = children[i + 1];
            if (bare && isHtml(next, SUMMARY_BLOCK_RE) && next!.value === next!.value!.trim()) {
                opener = `${opener}\n\n${next!.value}`;
                bodyStart = i + 2;
            }
            const close = matchingCloser(children, i);
            if (close >= bodyStart && parseOpener(opener)) {
                const body = wrapDetails(children.slice(bodyStart, close));
                out.push({
                    type: "details",
                    opener,
                    children: body.length > 0 ? body : [{ type: "paragraph", children: [] }],
                });
                i = close + 1;
                continue;
            }
        }
        out.push(node);
        i++;
    }
    return out;
}

// ─── Serialize ──────────────────────────────────────────────────────────────

/**
 * The opener, a blank line, the body's own flow, a blank line, the closer.
 * Both blank lines are load-bearing rather than style: without the first the
 * body is raw HTML-block text, and without the second the closer is inline
 * HTML in the body's last paragraph. An empty body is the opener and the
 * closer with one blank line between, which reads back as an empty body.
 */
const detailsToMarkdown = {
    handlers: {
        details(node: MdastNode, _parent: unknown, state: any, info: unknown): string {
            const exit = state.enter("details");
            const tracker = state.createTracker(info);
            const flow: string = state.containerFlow({ ...node, type: "details" }, tracker.current());
            exit();
            const opener = node.opener ?? DEFAULT_OPENER;
            return flow === "" ? `${opener}\n\n</details>` : `${opener}\n\n${flow}\n\n</details>`;
        },
    },
};

function remarkDetails(this: any): (tree: unknown) => void {
    const data = this.data();
    const list = data["toMarkdownExtensions"] ?? (data["toMarkdownExtensions"] = []);
    list.push(detailsToMarkdown);
    return (tree: unknown) => {
        const walk = (node: MdastNode): void => {
            if (!node.children) return;
            node.children = wrapDetails(node.children);
            node.children.forEach(walk);
        };
        walk(tree as MdastNode);
    };
}

export const detailsRemarkPlugin = $remark("remarkDetails", () => remarkDetails);

// ─── ProseMirror schema ─────────────────────────────────────────────────────

export const detailsSchema = $nodeSchema(detailsId, () => ({
    content: "block+",
    group: "block",
    defining: true,
    // The opener and the `</details>` line have no text position in the
    // document; declared for the source-line mapping (utils/sourceCaret.ts).
    markerLines: { closer: true },
    attrs: {
        opener: { default: DEFAULT_OPENER },
        open: { default: false },
        summary: { default: "" },
        hasSummary: { default: false },
    },
    parseDOM: [
        {
            tag: 'div[data-type="details"]',
            getAttrs: (dom) => attrsFromOpener((dom as HTMLElement).dataset["opener"] ?? DEFAULT_OPENER),
        },
    ],
    toDOM: (node) => [
        "div",
        {
            "data-type": "details",
            "data-opener": node.attrs["opener"] as string,
            class: "details-block",
        },
        0,
    ],
    parseMarkdown: {
        match: (node) => node.type === "details",
        runner: (state, node, type) => {
            state
                .openNode(type, attrsFromOpener((node["opener"] as string) ?? DEFAULT_OPENER))
                .next(node.children)
                .closeNode();
        },
    },
    toMarkdown: {
        match: (node) => node.type.name === detailsId,
        runner: (state, node) => {
            state
                .openNode("details", undefined, { opener: node.attrs["opener"] as string })
                .next(node.content)
                .closeNode();
        },
    },
}));

// ─── Insert command (slash menu / palette / Format menu) ────────────────────

/**
 * Wraps the blocks the selection covers in a details with no summary yet.
 * The summary row shows the browser's own "Details" label as its placeholder,
 * so a reader sees what an unnamed disclosure looks like everywhere else, and
 * typing there writes the `<summary>` line. Goes through editing/wrapBlocks
 * for the reason the callout insert does: a list or a table goes in whole.
 */
export const insertDetailsCommand = $command(
    "InsertDetails",
    (ctx) => () => (state, dispatch) => {
        const type = detailsSchema.type(ctx);
        if (!wrapTarget(state, type)) {
            return false;
        }
        // The source keeps the browser's default (closed). The editor only
        // folds a closed details when a document LOADS, so the body the
        // writer is about to fill stays on screen.
        return wrapBlocksIn(type, attrsFromOpener(DEFAULT_OPENER))(state, dispatch);
    },
);

/**
 * The two halves register at DIFFERENT positions in pureCommonmark, for the
 * reasons `notionCalloutRemark` and `notionCalloutNodes` give:
 * - `detailsRemark` BEFORE the preset, whose html transformer wraps every
 *   block-level html node in a paragraph and would leave this transform
 *   nothing to pair;
 * - `detailsNodes` AFTER it, because a block whose content is `block+`,
 *   registered before `paragraph`, makes `createAndFill` recurse.
 */
export const detailsRemark = [detailsRemarkPlugin].flat();
export const detailsNodes = [detailsSchema].flat();
