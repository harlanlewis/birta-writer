/**
 * Heading-link autocompletion at the caret: typing `#` mid-prose opens an
 * advisory dropdown of the document's headings, filtered as the user types.
 *
 * Trigger discipline: the `#` must follow whitespace — a line-start `#` is
 * heading syntax, not a link ask, so it never triggers (the one exception is
 * the Section Link command, which inserts the `#` itself and arms a one-shot
 * block-start allowance so the slash flow works on an empty line). The typed
 * `#query` is real document text, decorated with the slash menu's query-chip
 * look while the menu is open. Picking replaces the construct with a plain
 * `[Heading title](#slug)` markdown link (round-trips; no new node type).
 * The menu never captures plain typing or an unhighlighted Enter — the user
 * is free to ignore it even when the query exactly matches a heading
 * (advisory, reversible, quiet — docs/DESIGN_PRINCIPLES.md).
 *
 * Controller machinery is caretSuggest.ts, rows are the shared suggest
 * widget, and the heading source/filter is utils/headingSuggest.ts — the
 * same source the section-link picker and the link popup's anchor
 * suggestions consume, so all three surfaces agree.
 */
import { PluginKey } from "../pm";
import { $prose } from "@milkdown/utils";
import {
    collectHeadingSuggestions,
    filterHeadingSuggestions,
    outlineDisplayRows,
    type HeadingSuggestion,
} from "../utils/headingSuggest";
import { createSuggestMenuFromRows } from "../components/pathLink/linkTargetComplete";
import { caretSuggestPlugin, type CaretSuggestSpec } from "./caretSuggest";
import { t } from "../i18n";

/** `#partial` ending at the caret, with the `#` after whitespace (zero-width
 * lookbehind, so the match span is exactly `#partial`). */
export const PARTIAL_HEADING_REGEX = /(?<=\s)#([^\s#]*)$/;
/** The block-start form, valid only while `armed` (see below). */
const BLOCK_START_HEADING_REGEX = /^#([^\s#]*)$/;

/** Rows offered per menu — plenty to scan, bounded DOM (same cap family as
 * the wikilink autocomplete). Typing narrows the rest into view. */
const MAX_HEADING_ROWS = 20;

// One-shot allowance for a block-start `#`: typing `#` at a line start means
// heading syntax and must stay silent, but the Section Link command INSERTS
// the `#` itself — often on an empty line — and that one deserves the menu.
// Armed by the command right before its insert; disarmed the moment the
// caret leaves the construct.
let armed = false;

/** Called by the insertSectionLink command just before it inserts `#`. */
export function armBlockStartHeadingComplete(): void {
    armed = true;
}

// The display→pick map for the most recent menu (the widget reports a pick
// by display text; outlineDisplayRows keeps displays injective).
let pickByDisplay = new Map<string, HeadingSuggestion>();

const headingCompleteKey = new PluginKey("MD_HEADING_LINK_COMPLETE");

const headingCompleteSpec: CaretSuggestSpec = {
    match(textBefore, ctx) {
        const strict = PARTIAL_HEADING_REGEX.exec(textBefore);
        if (strict) { return { length: strict[0].length, query: strict[1] }; }
        if (armed && !ctx?.truncated) {
            const lenient = BLOCK_START_HEADING_REGEX.exec(textBefore);
            if (lenient) { return { length: lenient[0].length, query: lenient[1] }; }
        }
        armed = false; // caret left the construct — the allowance is spent
        return null;
    },

    // A bare `#` suggests immediately: the empty query is the browse state
    // (every heading, outline order) — the section-link picker's list.
    shouldSuggest: () => true,

    fetch(query, cb, ctx) {
        // Local and synchronous — the document's own headings, no roundtrip.
        const doc = ctx?.state.doc;
        if (!doc) { cb([]); return; }
        cb(filterHeadingSuggestions(collectHeadingSuggestions(doc), query));
    },

    buildMenu(items, _match, anchor, onPick) {
        const rows = outlineDisplayRows(
            (items as HeadingSuggestion[]).slice(0, MAX_HEADING_ROWS),
        );
        if (rows.length === 0) { return null; }
        pickByDisplay = new Map(rows.map((r) => [r.display, r.pick]));
        return createSuggestMenuFromRows(
            rows.map((r) => ({ text: r.display, title: `#${r.pick.slug}` })),
            anchor,
            onPick,
            { footer: t("Type to filter") },
        );
    },

    pick(view, match, picked) {
        const pick = pickByDisplay.get(picked);
        if (!pick) { return; }
        const { state } = view;
        const linkType = state.schema.marks["link"];
        if (!linkType) { return; }
        // Plain markdown out: the heading's title as freshly linked text.
        // Marks active at the construct survive (a `#` typed inside bold
        // prose yields a bold link), with any enclosing link replaced by ours.
        const mark = linkType.create({ href: `#${pick.slug}`, title: null });
        const marks = [
            ...state.doc.resolve(match.start).marks().filter((m) => m.type !== linkType),
            mark,
        ];
        view.dispatch(
            state.tr
                .replaceWith(match.start, match.caret, state.schema.text(pick.title, marks))
                .scrollIntoView(),
        );
    },

    // The slash-menu affordance: the typed `#query` reads as UI input while
    // the menu is open (same decoration class, same look).
    queryChipClass: "slash-query",
};

/** The composable plugin (registered beside wikiLinkCompletePlugin). */
export const headingLinkCompletePlugin = $prose(() =>
    caretSuggestPlugin(headingCompleteKey, headingCompleteSpec),
);
