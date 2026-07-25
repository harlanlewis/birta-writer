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
 * - List marker style (MAR-218) — the bullet character (`-`/`*`/`+`), the
 *   ordered delimiter (`.`/`)`), and whether the source NUMBERED its items
 *   (`1./2./3.`) or repeated one number (`1./1./1.`) — is recorded by the same
 *   visitor and emitted by `serializeList`. The PM carriage for those three
 *   facts lives in plugins/list.ts, not here: the three list node ids are
 *   already `extendSchema`'d there and only one schema per node id wins. The
 *   split is deliberate — capture must happen HERE because this transformer is
 *   the only place with access to the raw source (`file.value`), while carriage
 *   must happen THERE because that is where the list schemas are owned. List
 *   INDENT width is deliberately not carried; leading whitespace is owned by
 *   the minimal-diff merge layer (MAR-213/214).
 *
 * The custom stringify handlers are vendored (not imported) from
 * mdast-util-to-markdown@2.1.2: under pnpm's strict layout that package is a
 * transitive dependency and is not resolvable by name from this package. Each
 * handler needs only the public `state` helpers (`enter`, `createTracker`,
 * `containerPhrasing`, `options`), so the bodies are self-contained. RE-DIFF
 * AGAINST THE PACKAGE SOURCE ON EVERY mdast-util-to-markdown UPGRADE.
 */
import { headingSchema, hrSchema } from "@milkdown/preset-commonmark";
import { Fragment } from "../pm";
import { $remark } from "@milkdown/utils";

/** Minimal shape of the mdast nodes the parse-time visitor inspects. */
interface SourceMdastNode {
    type: string;
    depth?: number;
    ordered?: boolean;
    position?: {
        start: { offset: number; line: number };
        end: { line: number };
    };
    children?: SourceMdastNode[];
    marker?: string;
    setext?: boolean;
    /** `false` when the source repeated ONE number across every item. */
    incrementMarker?: boolean;
}

/** Thematic-break / setext marker characters we recognize. */
const RULE_MARKERS = new Set(["*", "_", "-"]);

/** Bullet-list marker characters CommonMark allows. */
const BULLET_MARKERS = new Set(["-", "*", "+"]);

/**
 * An ordered item's source marker, anchored at the item's own start offset:
 * up to nine digits (CommonMark's limit) then `.` or `)`.
 */
const ORDERED_ITEM_MARKER_RE = /^(\d{1,9})([.)])/;

/**
 * Record a list's marker style onto the mdast `list` node (MAR-218).
 *
 * An item's `position.start.offset` points AT its marker character (the
 * indentation is not part of the item's range), so the source style is a
 * direct read at that offset. Nothing is recorded unless every item agrees —
 * a partially readable list falls back to the serializer defaults rather than
 * pinning a style half the items don't support.
 *
 * `incrementMarker` is only recorded for lists of TWO OR MORE items: a single
 * item's number is trivially "the same as every other item", and pinning it
 * non-incrementing would make a second item added in the editor number `1.`
 * as well.
 */
function recordListMarkerStyle(node: SourceMdastNode, source: string): void {
    const items = node.children;
    if (!items?.length) return;

    if (!node.ordered) {
        const offset = items[0].position?.start.offset;
        if (typeof offset !== "number") return;
        const ch = source.charAt(offset);
        if (BULLET_MARKERS.has(ch)) node.marker = ch;
        return;
    }

    const numbers: string[] = [];
    let delimiter: string | undefined;
    for (const item of items) {
        const offset = item.position?.start.offset;
        if (typeof offset !== "number") return;
        // 9 digits + 1 delimiter is the longest marker CommonMark accepts.
        const match = ORDERED_ITEM_MARKER_RE.exec(source.slice(offset, offset + 10));
        if (!match) return;
        numbers.push(match[1]);
        if (delimiter === undefined) delimiter = match[2];
        else if (delimiter !== match[2]) return;
    }
    node.marker = delimiter;
    if (numbers.length > 1) {
        node.incrementMarker = !numbers.every((n) => n === numbers[0]);
    }
}

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
            } else if (node.type === "list") {
                recordListMarkerStyle(node, source);
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
 * List handler honoring the per-list `marker` (bullet character or ordered
 * delimiter) and `incrementMarker` recorded by the visitor above (MAR-218).
 *
 * Bullet character and ordered delimiter are GLOBAL stringify options in
 * mdast-util-to-markdown (`bullet`, `bulletOrdered`) with no per-node override,
 * and numbering style is the global `incrementListMarker` — so a per-list
 * choice needs this replacement. Ported from the stock handler with three
 * deltas:
 *
 * (a) `bullet` comes from `node.marker` when the source recorded one, else the
 *     configured global (`-` / `.` via `configureSerialization`). Upstream's
 *     `checkBullet` / `checkBulletOrdered` THROW on an unrecognized option;
 *     both are inlined here as a fallback instead, since the option is pinned
 *     in this repo and a throw mid-serialize would lose a save.
 * (b) `bulletOther` derives from the bullet ACTUALLY chosen, not from the
 *     global option. Upstream's `checkBulletOther` reads `options.bullet`,
 *     which with a per-list marker can hand back the very character already in
 *     use — turning the "use a different marker" safety into a no-op.
 * (c) `incrementListMarker` is forced off for this list's subtree and restored
 *     afterwards. That is what carries `1./1./1.` WITHOUT vendoring the
 *     `listItem` handler — which owns indent width (`checkListItemIndent`) and
 *     is therefore deliberately left stock, since leading whitespace belongs to
 *     the minimal-diff merge layer (MAR-213/214). `state.options` is a fresh,
 *     mutable object per `toMarkdown()` call, and the save/restore is the same
 *     bookkeeping discipline the handler already uses for `state.bulletCurrent`.
 *
 * The `useDifferentMarker` logic is otherwise VERBATIM and load-bearing: two
 * adjacent same-type lists are separated only by a blank line, so if both
 * emitted the same bullet they would merge back into one list on reparse.
 * `containerFlow` clears `state.bulletLastUsed` after any non-list sibling, so
 * it only fires for genuinely adjacent lists.
 */
function serializeList(node: any, parent: any, state: any, info: any): string {
    const exit = state.enter("list");
    const bulletCurrent = state.bulletCurrent;
    const recorded = node.marker;
    let bullet: string;
    if (node.ordered) {
        bullet =
            recorded === "." || recorded === ")"
                ? recorded
                : state.options.bulletOrdered === ")"
                  ? ")"
                  : ".";
    } else {
        bullet = BULLET_MARKERS.has(recorded)
            ? recorded
            : BULLET_MARKERS.has(state.options.bullet)
              ? state.options.bullet
              : "*";
    }
    const bulletOther = node.ordered
        ? bullet === "."
            ? ")"
            : "."
        : bullet === "*"
          ? "-"
          : "*";
    let useDifferentMarker =
        parent && state.bulletLastUsed ? bullet === state.bulletLastUsed : false;

    if (!node.ordered) {
        const firstListItem = node.children ? node.children[0] : undefined;

        // An empty first list item directly inside two list items has to use a
        // different bullet — `* - *` would otherwise become one thematic break.
        // Upstream assumes ONE global bullet, so all three levels matched by
        // construction; with a per-list marker the hazard only exists when this
        // bullet repeats the enclosing one, and flipping unconditionally makes
        // `* - *` oscillate with `* - -` on every save.
        if (
            (bullet === "*" || bullet === "-") &&
            bullet === bulletCurrent &&
            firstListItem &&
            (!firstListItem.children || !firstListItem.children[0]) &&
            state.stack[state.stack.length - 1] === "list" &&
            state.stack[state.stack.length - 2] === "listItem" &&
            state.stack[state.stack.length - 3] === "list" &&
            state.stack[state.stack.length - 4] === "listItem" &&
            state.indexStack[state.indexStack.length - 1] === 0 &&
            state.indexStack[state.indexStack.length - 2] === 0 &&
            state.indexStack[state.indexStack.length - 3] === 0
        ) {
            useDifferentMarker = true;
        }

        // A thematic break at the start of the first list item needs a
        // different bullet, for the same reason (`- ---` is four dashes).
        // Unreachable through this editor — `list_item`'s content is
        // `"paragraph block*"`, so an item's first child is always a paragraph
        // — but kept verbatim so a schema change can't quietly remove the
        // guard. (`state.options.rule` is the global; sourceStyle carries a
        // per-node rule marker, so if this ever DOES become reachable the
        // comparison has to move to the break's own marker.)
        if ((state.options.rule || "*") === bullet && firstListItem) {
            for (const item of node.children) {
                if (item?.type === "listItem" && item.children?.[0]?.type === "thematicBreak") {
                    useDifferentMarker = true;
                    break;
                }
            }
        }
    }

    if (useDifferentMarker) bullet = bulletOther;

    state.bulletCurrent = bullet;
    const incrementCurrent = state.options.incrementListMarker;
    if (node.incrementMarker === false) state.options.incrementListMarker = false;
    let value: string;
    try {
        value = state.containerFlow(node, info);
    } finally {
        state.options.incrementListMarker = incrementCurrent;
    }
    state.bulletLastUsed = bullet;
    state.bulletCurrent = bulletCurrent;
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
    list: serializeList,
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
