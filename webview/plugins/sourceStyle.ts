/**
 * Source-style preservation (MAR-16).
 *
 * remark-stringify canonicalizes a document's cosmetic Markdown choices: every
 * emphasis/strong marker becomes `*`/`**`, every thematic break becomes the
 * global `rule` option, and every heading becomes ATX (`# Title`). Reopening
 * and saving a file therefore rewrote `_italic_` → `*italic*`, `***` → `---`
 * and setext headings (`Title\n=====`) into ATX even on lines the user never
 * touched — the minimal-diff protection layer papered over it, but the churn
 * showed up the moment a line was genuinely edited.
 *
 * This module records each construct's ORIGINAL style at parse time and
 * replays it on serialize:
 *
 * - Emphasis / strong markers (`_`/`__` vs `*`/`**`) already round-trip
 *   through Milkdown's own `remarkMarker` plugin, which writes `node.marker`
 *   onto the mdast node and threads it through the `marker` PM mark attr. The
 *   stock mdast-util-to-markdown handlers ignore `node.marker` and emit the
 *   global option, so `serializeEmphasis` / `serializeStrong` here honor it.
 * - Thematic-break markers (`***`/`___`/`---`) are recorded by the remark
 *   visitor below (`file.value.charAt(offset)`), carried on the `hr` node's
 *   `marker` attr, and emitted by `serializeThematicBreak`. New breaks created
 *   in the editor carry no marker and fall back to the serializer default.
 * - Setext headings (depth ≤ 2 whose source spans more than one line) are
 *   flagged by the same visitor, carried on the `heading` node's `setext`
 *   attr, and emitted as underlined headings by `serializeHeading`; every
 *   other heading stays ATX.
 *
 * The custom stringify handlers are vendored (not imported) from
 * mdast-util-to-markdown@2.1.2: under pnpm's strict layout that package is a
 * transitive dependency and is not resolvable by name from this package. Each
 * handler needs only the public `state` helpers (`enter`, `createTracker`,
 * `containerPhrasing`, `options`), so the bodies are self-contained. RE-DIFF
 * AGAINST THE PACKAGE SOURCE ON EVERY mdast-util-to-markdown UPGRADE.
 */
import { headingSchema, hrSchema } from "@milkdown/preset-commonmark";
import { Fragment } from "@milkdown/prose/model";
import { $remark } from "@milkdown/utils";

/** Minimal shape of the mdast nodes the parse-time visitor inspects. */
interface SourceMdastNode {
    type: string;
    depth?: number;
    position?: {
        start: { offset: number; line: number };
        end: { line: number };
    };
    children?: SourceMdastNode[];
    marker?: string;
    setext?: boolean;
}

/** Thematic-break / setext marker characters we recognize. */
const RULE_MARKERS = new Set(["*", "_", "-"]);

/**
 * Parse-time visitor: records each construct's original source style onto the
 * mdast node so the schema runners below can carry it into ProseMirror.
 *
 * Mirrors the preset's `remarkMarker` plugin (which populates `node.marker`
 * for emphasis/strong the same way); a plain recursive walk avoids importing
 * `unist-util-visit`, which is transitive-only under pnpm's strict layout.
 */
export const sourceStyleRemark = $remark(
    "sourceStyleMarker",
    // Params widen to `unknown` to satisfy unified's `Transformer` signature
    // (contravariant); the concrete mdast shape is recovered by the casts
    // below. Mirrors the preset's untyped `remarkMarker` plugin.
    () => () => (tree: unknown, file: unknown) => {
        const rawValue = (file as { value?: unknown }).value;
        const source = typeof rawValue === "string" ? rawValue : String(rawValue ?? "");

        const walk = (node: SourceMdastNode): void => {
            if (node.type === "thematicBreak" && node.position) {
                const ch = source.charAt(node.position.start.offset);
                if (RULE_MARKERS.has(ch)) node.marker = ch;
            } else if (
                node.type === "heading" &&
                node.position &&
                (node.depth ?? 1) <= 2 &&
                node.position.start.line !== node.position.end.line
            ) {
                node.setext = true;
            }
            node.children?.forEach(walk);
        };

        walk(tree as SourceMdastNode);
    },
);

/**
 * `hr` schema extended with a `marker` attr recording the original
 * thematic-break character (`*` / `_` / `-`). `null` means "created in the
 * editor" — no recorded source style, so the serializer default applies.
 */
export const hrSourceStyleSchema = hrSchema.extendSchema((prev) => (ctx) => {
    const base = prev(ctx);
    return {
        ...base,
        attrs: { ...base.attrs, marker: { default: null } },
        parseMarkdown: {
            match: ({ type }: { type: string }) => type === "thematicBreak",
            runner: (state: any, node: any, type: any) => {
                const marker = node.marker;
                state.addNode(type, { marker: RULE_MARKERS.has(marker) ? marker : null });
            },
        },
        toMarkdown: {
            match: (node: any) => node.type.name === "hr",
            runner: (state: any, node: any) => {
                state.addNode("thematicBreak", undefined, undefined, {
                    marker: node.attrs.marker ?? null,
                });
            },
        },
    };
});

/**
 * `heading` schema extended with a `setext` attr. `true` marks a depth-1/2
 * heading whose source used the underlined (setext) form; the serializer
 * replays it as setext instead of canonicalizing to ATX.
 */
export const headingSourceStyleSchema = headingSchema.extendSchema((prev) => (ctx) => {
    const base = prev(ctx);
    return {
        ...base,
        attrs: { ...base.attrs, setext: { default: false, validate: "boolean" } },
        parseMarkdown: {
            match: ({ type }: { type: string }) => type === "heading",
            runner: (state: any, node: any, type: any) => {
                state.openNode(type, { level: node.depth, setext: node.setext === true });
                state.next(node.children);
                state.closeNode();
            },
        },
        toMarkdown: {
            match: (node: any) => node.type.name === "heading",
            runner: (state: any, node: any) => {
                state.openNode("heading", undefined, {
                    depth: node.attrs.level,
                    ...(node.attrs.setext ? { setext: true } : {}),
                });
                serializeHeadingText(state, node);
                state.closeNode();
            },
        },
    };
});

/**
 * Serialize a heading's inline content, dropping a trailing hardbreak.
 * Vendored from the preset's internal `serializeText` (not exported) so the
 * extended `heading` runner behaves identically to the stock one.
 */
function serializeHeadingText(state: any, node: any): void {
    if (!(node.childCount >= 1 && node.lastChild?.type.name === "hardbreak")) {
        state.next(node.content);
        return;
    }
    const content: any[] = [];
    node.content.forEach((child: any, _offset: number, index: number) => {
        if (index === node.childCount - 1) return;
        content.push(child);
    });
    state.next(Fragment.fromArray(content));
}

// ─── mdast-util-to-markdown stringify handlers (vendored) ────────────────────

/**
 * Emphasis handler honoring the per-node `marker` (`_` or `*`) recorded by
 * `remarkMarker`. Self-contained port of the stock handler minus the
 * attention character-reference encoding, which only fires for edge-space or
 * intraword emphasis — neither of which the editor produces (the fidelity
 * serializer hoists edge spaces, and the input rules refuse intraword `_`).
 */
function serializeEmphasis(node: any, _parent: any, state: any, info: any): string {
    const marker = node.marker === "_" || node.marker === "*"
        ? node.marker
        : state.options.emphasis || "*";
    const exit = state.enter("emphasis");
    const tracker = state.createTracker(info);
    const before = tracker.move(marker);
    const between = tracker.move(
        state.containerPhrasing(node, { after: marker, before, ...tracker.current() }),
    );
    const after = tracker.move(marker);
    exit();
    // No attention run spans the mark boundary (see above), so neighbors need
    // no surrounding-encode hint.
    state.attentionEncodeSurroundingInfo = undefined;
    return before + between + after;
}
serializeEmphasis.peek = (node: any, _parent: any, state: any): string =>
    node.marker === "_" || node.marker === "*" ? node.marker : state.options.emphasis || "*";

/** Strong handler honoring the per-node `marker`. Doubled emphasis marker. */
function serializeStrong(node: any, _parent: any, state: any, info: any): string {
    const marker = node.marker === "_" || node.marker === "*"
        ? node.marker
        : state.options.strong || "*";
    const sequence = marker + marker;
    const exit = state.enter("strong");
    const tracker = state.createTracker(info);
    const before = tracker.move(sequence);
    const between = tracker.move(
        state.containerPhrasing(node, { after: marker, before, ...tracker.current() }),
    );
    const after = tracker.move(sequence);
    exit();
    state.attentionEncodeSurroundingInfo = undefined;
    return before + between + after;
}
serializeStrong.peek = (node: any, _parent: any, state: any): string =>
    node.marker === "_" || node.marker === "*" ? node.marker : state.options.strong || "*";

/**
 * Thematic-break handler honoring the per-node `marker`. New breaks (marker
 * `null`) fall back to `state.options.rule` — `-` as configured in
 * `configureSerialization`, giving `---`.
 */
function serializeThematicBreak(node: any, _parent: any, state: any): string {
    const marker = RULE_MARKERS.has(node.marker) ? node.marker : state.options.rule || "*";
    const repetition = state.options.ruleRepetition || 3;
    const value = (marker + (state.options.ruleSpaces ? " " : "")).repeat(repetition);
    return state.options.ruleSpaces ? value.slice(0, -1) : value;
}

/**
 * Heading handler emitting setext (underlined) form for `node.setext` at
 * depth ≤ 2 and ATX otherwise. Self-contained port of the stock handler; the
 * stock version only chooses setext from the GLOBAL `setext` option, so a
 * per-node choice needs this replacement.
 */
function serializeHeading(node: any, _parent: any, state: any, info: any): string {
    const rank = Math.max(Math.min(6, node.depth || 1), 1);
    const tracker = state.createTracker(info);

    if (node.setext && rank < 3) {
        const exit = state.enter("headingSetext");
        const subexit = state.enter("phrasing");
        const value = state.containerPhrasing(node, {
            ...tracker.current(),
            before: "\n",
            after: "\n",
        });
        subexit();
        exit();
        return (
            value +
            "\n" +
            (rank === 1 ? "=" : "-").repeat(
                value.length - (Math.max(value.lastIndexOf("\r"), value.lastIndexOf("\n")) + 1),
            )
        );
    }

    const sequence = "#".repeat(rank);
    const exit = state.enter("headingAtx");
    const subexit = state.enter("phrasing");
    tracker.move(sequence + " ");
    let value = state.containerPhrasing(node, {
        before: "# ",
        after: "\n",
        ...tracker.current(),
    });
    if (/^[\t ]/.test(value)) {
        value = "&#x" + value.charCodeAt(0).toString(16).toUpperCase() + ";" + value.slice(1);
    }
    value = value ? sequence + " " + value : sequence;
    if (state.options.closeAtx) value += " " + sequence;
    subexit();
    exit();
    return value;
}

/**
 * Custom mdast-util-to-markdown handlers that replay recorded source style.
 * Spread into `remarkStringifyOptionsCtx.handlers` by `configureSerialization`.
 */
export const sourceStyleHandlers = {
    emphasis: serializeEmphasis,
    strong: serializeStrong,
    thematicBreak: serializeThematicBreak,
    heading: serializeHeading,
};

/**
 * The original preset plugins this module replaces. `configureSerialization`
 * consumers filter these out of the commonmark preset before adding
 * `sourceStylePlugin`, so only the extended schemas register.
 */
export const sourceStyleReplacedPlugins = new Set<unknown>([
    hrSchema.ctx,
    hrSchema.node,
    headingSchema.ctx,
    headingSchema.node,
]);

/** All source-style plugins, flattened for `Editor.use()`. */
export const sourceStylePlugin = [
    ...sourceStyleRemark,
    ...hrSourceStyleSchema,
    ...headingSourceStyleSchema,
].flat();
