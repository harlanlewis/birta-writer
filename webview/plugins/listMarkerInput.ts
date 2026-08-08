/**
 * plugins/listMarkerInput.ts
 *
 * ONE grammar for typing a list marker, wherever the caret is: the four rules
 * here replace the stock `wrapInBulletListInputRule`,
 * `wrapInOrderedListInputRule` (preset-commonmark) and
 * `wrapInTaskListInputRule` (preset-gfm).
 *
 *   typed          in prose                     at the head of a list item
 *   ─────────────  ───────────────────────────  ──────────────────────────────
 *   `- ` `* ` `+ ` wrap in a bullet list        retype THAT item to bullet
 *   `1. ` `1) `    wrap in an ordered list      retype THAT item to ordered
 *   `a. ` `A. `    wrap in an ordered list      restyle an ordered list, or
 *   `i. ` `I. `      DRAWN in that style          retype a bullet item and style
 *   `[ ] ` `[x] `  (nothing — GFM has no        set the item's checkbox
 *                   task item outside a list)
 *
 * The `a.`/`i.` row does NOT write a lettered marker to the file. CommonMark has
 * no such marker, so the bytes stay `1.` and only the drawing changes;
 * utils/orderedMarkers.ts holds that argument in full.
 *
 * WHY THE ITEM COLUMN DID NOT EXIST BEFORE. Both stock list rules are
 * `wrappingInputRule`s, and wrapping is structurally impossible inside an item:
 * `list_item`'s content is `paragraph block*`, so index 0 must be a paragraph
 * and `findWrapping` refuses to put a list there. The rule returned null and
 * the marker stayed as text — `1. ` typed at the head of a bullet item saved as
 * `- 1\. beta`, an escaped literal. So the only way to mix list flavors was the
 * gutter menu's Turn-into, and the keyboard could not build the shape at all.
 * GFM's task rule was the shape to copy: it does not wrap, it climbs to the
 * enclosing `list_item` and sets an attr.
 *
 * WHY A MARKER RETYPES ONE ITEM AND SPLITS THE LIST — see `retypeListItemAt`
 * (editing/listConvert.ts), which owns that argument and the transform.
 *
 * THE TWO AXES ARE ORTHOGONAL, and keeping them so is what makes the table
 * above learnable. `- `/`1. ` set the list TYPE; `[ ]`/`[x]` set the item's
 * CHECKBOX. Neither disturbs the other, because Markdown does not couple them:
 * `1. [ ] step` is a valid ordered task item, and typing `1. ` on `- [ ] step`
 * describes the line `1. [ ] step` — the marker is what changed, not the box.
 * (The cost is that no typed marker UN-tasks an item; the checkbox is a
 * clickable affordance and the menus convert. A `[ ]`-toggles-off reading would
 * buy that one gesture by making the whole table conditional.)
 *
 * A MARKER THAT CHANGES NOTHING IS LEFT AS TEXT — `- ` at the head of a bullet
 * item, `[x] ` on an already-checked one. Consuming it would delete the user's
 * keystrokes and show nothing for them; declining keeps literal `- ` and `[ ]`
 * typeable at the head of an item, which is otherwise unreachable. The rule a
 * user can hold: the marker either changes the line's shape, or it is text.
 *
 * TWO WAYS BACK, and they differ. Backspace runs `undoInputRule`, which puts
 * the marker back as literal text — plugins/list.ts chains it ahead of its own
 * list handling for exactly this. Cmd+Z is history, which groups the rule's
 * transaction with the keystrokes that triggered it, so it reverts to the line
 * as it stood BEFORE the marker was typed. Backspace is the one that says "I
 * meant text"; Cmd+Z is the one that says "forget I typed anything".
 */
import {
    bulletListSchema,
    orderedListSchema,
    wrapInBulletListInputRule,
    wrapInOrderedListInputRule,
} from "@milkdown/preset-commonmark";
import { wrapInTaskListInputRule } from "@milkdown/preset-gfm";
import { $inputRule } from "@milkdown/utils";
import { InputRule, wrappingInputRule } from "../pm";
import type { EditorState, Node as ProseNode, NodeType, ResolvedPos, Transaction } from "../pm";
import { retypeListItemAt } from "../editing/listConvert";
import { armListNumbering } from "./listNumbering";
import { orderedMarkerStart, type OrderedNumbering } from "../utils/orderedMarkers";

/**
 * Leading whitespace is part of the match (as in the stock rules) so that a
 * marker typed after an accidental space still fires and the space is consumed
 * with it. Nine digits is CommonMark's own limit on an ordered marker, and the
 * same bound `ORDERED_ITEM_MARKER_RE` uses when reading one back out of source
 * (plugins/sourceStyle.ts).
 */
const BULLET_MARKER = /^\s*([-*+])\s$/;
const ORDERED_MARKER = /^\s*(\d{1,9})([.)])\s$/;
/**
 * `a. `, `A. `, `i. `, `I. ` — a lettered or roman list's FIRST marker. The
 * pattern is one letter on purpose; see orderedMarkerStart for why only a
 * sequence-starting marker fires, and why `i` reads as roman.
 */
const STYLED_ORDERED_MARKER = /^\s*([aAiI])([.)])\s$/;
/** No `\s*`: a checkbox is only a checkbox flush against its marker. */
const TASK_MARKER = /^\[([ xX])\]\s$/;

/**
 * The list item whose MARKER LINE starts at `$start`, or null.
 *
 * "Marker line" is the load-bearing part, and it is why upstream's task rule
 * was wrong: that rule climbs to the nearest `list_item` from anywhere, so
 * `[ ] ` typed on an item's CONTINUATION paragraph checkboxed the item's first
 * line instead — a marker consumed on one line, a checkbox appearing on
 * another. A continuation line has no marker of its own, and neither does a
 * paragraph inside a quote inside an item, so both must decline.
 *
 * The one non-obvious admission is an item whose first child is an EMPTY
 * ARTIFACT PARAGRAPH: `list_item`'s content is `paragraph block*`, so an item
 * that really begins with a heading (or fence, or quote) is parsed with an
 * empty paragraph forced in front of it, and it is the SECOND child that rides
 * the marker line. `itemContentForMarkdown` (plugins/list.ts) drops that
 * artifact on the way out for the same reason, and this admits the same child
 * under the same test — including its "a following PARAGRAPH is a real blank
 * line, not an artifact" clause, without which a genuine second paragraph
 * would look like a marker line.
 */
function markerLineItem($start: ResolvedPos): { pos: number; node: ProseNode } | null {
    if ($start.parentOffset !== 0 || $start.depth < 1) {
        return null;
    }
    const item = $start.node($start.depth - 1);
    if (item.type.name !== "list_item") {
        return null;
    }
    const index = $start.index($start.depth - 1);
    const pos = $start.before($start.depth - 1);
    if (index === 0) {
        return { pos, node: item };
    }
    if (index !== 1 || $start.parent.type.name === "paragraph") {
        return null;
    }
    const first = item.child(0);
    return first.type.name === "paragraph" && first.content.size === 0
        ? { pos, node: item }
        : null;
}

/**
 * A stock `wrappingInputRule`, exposed as a plain function so the PROSE half of
 * each rule below is upstream's own code rather than a copy of it — including
 * the join with a preceding same-type list, which is what makes a marker typed
 * on the line under a list continue that list instead of starting a new one.
 * Delegating rather than vendoring is the `mathAwareEmphasisStarInputRule`
 * pattern (plugins/emphasisInput.ts), and it means a Milkdown upgrade carries
 * no re-diff obligation for this half.
 *
 * `handler` is a public field that prosemirror-inputrules' typings mark
 * internal, hence the cast — named in one place here.
 */
function stockWrap(
    regexp: RegExp,
    type: NodeType,
    getAttrs: (match: RegExpMatchArray) => Record<string, unknown>,
    joinPredicate?: (match: RegExpMatchArray, node: ProseNode) => boolean,
): (state: EditorState, match: RegExpMatchArray, start: number, end: number) => Transaction | null {
    const rule = wrappingInputRule(regexp, type, getAttrs, joinPredicate) as InputRule & {
        handler: (
            state: EditorState,
            match: RegExpMatchArray,
            start: number,
            end: number,
        ) => Transaction | null;
    };
    return (state, match, start, end) => rule.handler(state, match, start, end);
}

/**
 * `- `, `* `, `+ `. The typed character is recorded as the list's `marker`, so
 * a list born in the editor spells itself the way its author asked, the same
 * fact `sourceStyle` records off a parsed file (MAR-218). Nothing else reads
 * the character, so this is the whole cost of honoring it.
 */
export const bulletMarkerInputRule = $inputRule((ctx) => {
    const wrap = stockWrap(BULLET_MARKER, bulletListSchema.type(ctx), (match) => ({
        marker: match[1] ?? "-",
    }));
    return new InputRule(BULLET_MARKER, (state, match, start, end) => {
        const item = markerLineItem(state.doc.resolve(start));
        if (!item) {
            return wrap(state, match, start, end);
        }
        const tr = state.tr.delete(start, end);
        return retypeListItemAt(tr, item.pos, {
            kind: "bulletList",
            marker: match[1] ?? "-",
        })
            ? tr
            : null;
    });
});

/**
 * `1. `, `1) `, `7. `. The delimiter is recorded alongside the number, which is
 * also what makes `)` work at all: the stock rule's regex is `.`-only, so
 * `1) ` used to produce the escaped literal `1\) `.
 *
 * ANY NUMBER FIRES, ON ANY LINE. CommonMark's own answer to the `- 1990. The
 * year we moved` collision — an ordered list may not interrupt a paragraph
 * unless it starts at 1 — was tried here and removed, because mapped onto a
 * WYSIWYG it protects nothing: the ordinary way to reach that line is to type
 * it into an empty item, and an empty line is exactly where the rule has to
 * fire. It would have bought a collision the user can already only hit by
 * PREPENDING to existing text, and charged for it the most natural way to
 * number an existing sublist — `1. `, `2. `, `3. ` down lines that all have
 * text. The honest mitigation for a misfire is the one prose has always had:
 * Backspace or Cmd+Z puts the characters back.
 */
export const orderedMarkerInputRule = $inputRule((ctx) => {
    const wrap = stockWrap(
        ORDERED_MARKER,
        orderedListSchema.type(ctx),
        (match) => ({ order: Number(match[1]), marker: match[2] ?? "." }),
        // Stock's own predicate: continue the list above only when the typed
        // number is the one that comes next in it.
        (match, node) => node.childCount + Number(node.attrs["order"] ?? 1) === Number(match[1]),
    );
    return new InputRule(ORDERED_MARKER, (state, match, start, end) => {
        const item = markerLineItem(state.doc.resolve(start));
        if (!item) {
            return wrap(state, match, start, end);
        }
        const tr = state.tr.delete(start, end);
        return retypeListItemAt(tr, item.pos, {
            kind: "orderedList",
            order: Number(match[1]),
            marker: match[2] ?? ".",
        })
            ? tr
            : null;
    });
});

/**
 * `a. `, `A. `, `i. `, `I. ` build an ordered list DRAWN in that style. The file
 * gets `1.`, because CommonMark has no lettered or roman marker and writing one
 * produces a document GitHub renders as prose; the style is a presentation attr
 * (utils/orderedMarkers.ts holds the whole argument).
 *
 * So this rule is the digit rule plus one attr, and it deliberately reuses
 * `order: 1` — every style it can start begins at its first item.
 *
 * THE MISFIRE IS REAL AND ACCEPTED. `A. Smith said so` opens a paragraph whose
 * first three characters are a marker, and this converts it, where the digit
 * rule's equivalent (`1. `) is not something prose starts with. Two things make
 * that the right trade. Only a SEQUENCE START fires, so `B. Jones` and the rest
 * of a name-initial list are untouched; and the mitigation is the one the digit
 * rule already documents, Backspace to put the characters back as text or Cmd+Z
 * to forget the keystrokes. The alternative — no typed path to a lettered list —
 * charges every outline author for a collision a single Backspace answers.
 */
export const styledOrderedMarkerInputRule = $inputRule((ctx) => {
    const wrap = stockWrap(
        STYLED_ORDERED_MARKER,
        orderedListSchema.type(ctx),
        (match) => ({
            order: 1,
            marker: match[2] ?? ".",
            numbering: orderedMarkerStart(match[1] ?? ""),
        }),
        // No join predicate: a lettered list typed under an existing ordered
        // list is a NEW list in a different style, never a continuation of it.
        () => false,
    );
    return new InputRule(STYLED_ORDERED_MARKER, (state, match, start, end) => {
        const numbering = orderedMarkerStart(match[1] ?? "");
        if (numbering === null) {
            return null;
        }
        const item = markerLineItem(state.doc.resolve(start));
        if (!item) {
            const tr = wrap(state, match, start, end);
            if (!tr) {
                return null;
            }
            armListNumbering();
            // A list typed on the line DIRECTLY BELOW an ordered one does not
            // stay a second list: adjacency auto-joins (listAutoJoin), and the
            // survivor keeps the FIRST list's attrs — so the style would land on
            // a node that is about to be discarded, and the marker would appear
            // to do nothing. Style the list it is about to become part of, which
            // is also the reading the item branch below already gives `a. ` at
            // an ordered item's head: restyle this list.
            const precedingList = orderedListEndingAt(state.doc, start);
            if (precedingList !== null) {
                return tr.setNodeMarkup(
                    tr.mapping.map(precedingList.pos, -1),
                    undefined,
                    { ...precedingList.node.attrs, numbering },
                );
            }
            return tr;
        }
        // At the head of an item, what the marker changes depends on the list
        // the item is ALREADY in — decided here rather than by attempting a
        // retype, because a declined retype has already touched the
        // transaction it was handed.
        const enclosing = enclosingOrderedList(state.doc, item.pos);
        if (enclosing) {
            const current = enclosing.node.attrs["numbering"];
            if (current === numbering) {
                // Names the state the line is already in: left as text, the
                // module's own rule for a marker that changes nothing.
                return null;
            }
            // Already ordered, so there is nothing to retype — the marker names
            // a STYLE change, which is a real change to the line's shape.
            armListNumbering();
            const tr = state.tr.delete(start, end);
            return tr.setNodeMarkup(
                tr.mapping.map(enclosing.pos, -1),
                undefined,
                { ...enclosing.node.attrs, numbering },
            );
        }
        // A bullet or task item: retype it, the same one-item-and-split
        // contract the digit rule has, then style the list that produced.
        const tr = state.tr.delete(start, end);
        if (!retypeListItemAt(tr, item.pos, {
            kind: "orderedList",
            order: 1,
            marker: match[2] ?? ".",
        })) {
            return null;
        }
        armListNumbering();
        return applyNumberingAroundItem(tr, item.pos, numbering);
    });
});

/**
 * The ordered_list that is the immediately PRECEDING sibling of the textblock
 * containing `pos`, or null. Used to spot the adjacency that auto-joins.
 */
function orderedListEndingAt(
    doc: ProseNode,
    pos: number,
): { pos: number; node: ProseNode } | null {
    const $pos = doc.resolve(pos);
    // Only a top-level-or-container paragraph can have a list as a sibling; a
    // paragraph inside an item is handled by the item branch instead.
    if ($pos.depth < 1) {
        return null;
    }
    const index = $pos.index($pos.depth - 1);
    if (index < 1) {
        return null;
    }
    const parent = $pos.node($pos.depth - 1);
    const previous = parent.child(index - 1);
    if (previous.type.name !== "ordered_list") {
        return null;
    }
    // The sibling's own document position: this textblock's start, back over the
    // sibling's size.
    return { pos: $pos.before($pos.depth) - previous.nodeSize, node: previous };
}

/**
 * The ordered_list directly holding the item at `itemPos` (the position BEFORE
 * a list_item), or null when its parent is a bullet list.
 */
function enclosingOrderedList(
    doc: ProseNode,
    itemPos: number,
): { pos: number; node: ProseNode } | null {
    const $item = doc.resolve(itemPos);
    const parent = $item.parent;
    return parent.type.name === "ordered_list"
        ? { pos: $item.before($item.depth), node: parent }
        : null;
}

/**
 * Stamp `numbering` on whichever ordered_list now holds the item at `itemPos`.
 * The retype rebuilt the list around it, so the list has to be found in the
 * transaction's OWN doc rather than the state's.
 */
function applyNumberingAroundItem(
    tr: Transaction,
    itemPos: number,
    numbering: OrderedNumbering,
): Transaction | null {
    const mapped = tr.mapping.map(itemPos, -1);
    const $item = tr.doc.resolve(Math.min(Math.max(mapped, 0), tr.doc.content.size));
    for (let depth = $item.depth; depth >= 0; depth--) {
        const node = $item.node(depth);
        if (node.type.name === "ordered_list") {
            tr.setNodeMarkup($item.before(depth), undefined, {
                ...node.attrs,
                numbering,
            });
            return tr;
        }
    }
    // The retype produced no ordered list (it declined, or produced a bullet):
    // the transaction still stands, just without a style.
    return tr;
}

/**
 * `[ ] ` and `[x] ` set the item's checkbox, on a bullet OR an ordered item
 * (`1. [ ] step` is valid GFM and already round-trips). Two divergences from
 * the upstream rule this replaces, both of them bugs it had:
 *
 *   - it accepted any enclosing item from anywhere, so the marker could be
 *     typed on one line and take effect on another — `markerLineItem` above;
 *   - it refused an item that was ALREADY a task (`checked != null`), so there
 *     was no typed way to tick a box: `[x] ` on an open task left the escaped
 *     literal `\[x]` in the text. Setting the state the marker names is
 *     idempotent and needs no such guard — only a marker naming the state the
 *     item is already in declines, and then it stays text, as everywhere else.
 */
export const taskMarkerInputRule = $inputRule(() =>
    new InputRule(TASK_MARKER, (state, match, start, end) => {
        const item = markerLineItem(state.doc.resolve(start));
        if (!item) {
            return null;
        }
        const checked = (match[1] ?? "").toLowerCase() === "x";
        if (item.node.attrs["checked"] === checked) {
            return null;
        }
        return state.tr
            .delete(start, end)
            .setNodeMarkup(item.pos, undefined, { ...item.node.attrs, checked });
    }),
);

/**
 * The three rules split by which PRESET they replace, because registration
 * order is the only thing that makes a replacement win: the bullet/ordered
 * pair belongs to commonmark, the task rule to gfm, and gfm registers after
 * commonmark. Each set/array pair is consumed next to the preset it filters
 * (serialization.ts).
 */
export const listMarkerInputReplacedPlugins = new Set<unknown>([
    wrapInBulletListInputRule,
    wrapInOrderedListInputRule,
]);

export const listMarkerInputRules = [
    bulletMarkerInputRule,
    orderedMarkerInputRule,
    // AFTER the digit rule: the two patterns cannot both match (digits vs a
    // letter), so order is not a correctness matter, only a reading one.
    styledOrderedMarkerInputRule,
].flat();

export const taskMarkerInputReplacedPlugins = new Set<unknown>([wrapInTaskListInputRule]);

export const taskMarkerInputRules = [taskMarkerInputRule].flat();
