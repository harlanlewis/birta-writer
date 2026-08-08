/**
 * webview/utils/orderedMarkers.ts
 *
 * The vocabulary of ordered-list NUMBERING STYLES, and the one function that
 * spells a marker in each. Pure, dependency-free, so the store's validator
 * (blockWidth.ts), the gutter's width stamp (headingFold/foldDecorations.ts)
 * and the plugin that applies a style can all share one definition.
 *
 * WHY A STYLE IS PRESENTATION AND NEVER SOURCE. CommonMark has no alpha or
 * roman ordered list: a marker is one to nine DIGITS followed by `.` or `)`,
 * full stop. `a. alpha` is not a list to any CommonMark reader, it is a
 * paragraph that happens to start with a letter, and this editor parses it that
 * way (verified against the real bundle). Pandoc's `fancy_lists` extension does
 * spell them, but GitHub, VS Code's own preview, Obsidian and every other
 * CommonMark tool render `a. alpha` as prose.
 *
 * So writing `a.` into the file would trade a display preference for a document
 * other tools disagree with, which is the one thing this editor exists not to
 * do (phase-0-fidelity). A numbering style is therefore what it looks like: a
 * choice about how a NORMAL ordered list is drawn. The bytes stay `1.`, `2.`,
 * `3.`, and the list renders `a.`, `b.`, `c.` — semantically the same list,
 * portable everywhere, and the browser generates the markers via
 * `list-style-type` exactly as it already does for nested levels.
 */

/** The CSS `list-style-type` values we offer. `decimal` is the default and is
 * never stored — absence means "the cascade decides", which is what gives a
 * nested list its by-depth alpha and roman levels (style.css). */
export type OrderedNumbering =
    | "decimal"
    | "lower-alpha"
    | "upper-alpha"
    | "lower-roman"
    | "upper-roman";

export const ORDERED_NUMBERINGS: readonly OrderedNumbering[] = [
    "decimal",
    "lower-alpha",
    "upper-alpha",
    "lower-roman",
    "upper-roman",
];

export function isOrderedNumbering(value: unknown): value is OrderedNumbering {
    return typeof value === "string"
        && (ORDERED_NUMBERINGS as readonly string[]).includes(value);
}

const ROMAN: readonly [number, string][] = [
    [1000, "m"], [900, "cm"], [500, "d"], [400, "cd"],
    [100, "c"], [90, "xc"], [50, "l"], [40, "xl"],
    [10, "x"], [9, "ix"], [5, "v"], [4, "iv"], [1, "i"],
];

/** Lowercase roman numeral for a POSITIVE integer. CSS `lower-roman` falls
 * back to decimal outside 1..3999, and so does this. */
function romanize(n: number): string {
    if (!Number.isInteger(n) || n < 1 || n > 3999) {
        return String(n);
    }
    let rest = n;
    let out = "";
    for (const [value, glyph] of ROMAN) {
        while (rest >= value) {
            out += glyph;
            rest -= value;
        }
    }
    return out;
}

/** Spreadsheet-column lettering: 1→a, 26→z, 27→aa. CSS `lower-alpha` uses the
 * same bijective base-26 scheme, so the widths agree. */
function alphabetize(n: number): string {
    if (!Number.isInteger(n) || n < 1) {
        return String(n);
    }
    let rest = n;
    let out = "";
    while (rest > 0) {
        const rem = (rest - 1) % 26;
        out = String.fromCharCode(97 + rem) + out;
        rest = Math.floor((rest - 1) / 26);
    }
    return out;
}

/**
 * The marker text the browser will draw for the `n`th item of a list in
 * `style` — WITHOUT its delimiter. Nothing renders from this: the browser owns
 * the markers. It exists so the gutter can know how WIDE the widest marker is,
 * because the item grabber offsets left by that width and `viii` is four
 * characters where `8` is one.
 */
export function orderedMarkerText(n: number, style: OrderedNumbering): string {
    switch (style) {
        case "lower-alpha":
            return alphabetize(n);
        case "upper-alpha":
            return alphabetize(n).toUpperCase();
        case "lower-roman":
            return romanize(n);
        case "upper-roman":
            return romanize(n).toUpperCase();
        case "decimal":
            return String(n);
    }
}

/**
 * A typed marker's numbering style and the ordinal it names, or null when the
 * text is not a marker we recognize.
 *
 * `i` is ROMAN, not the ninth letter — Pandoc's own reading, and the one a
 * reader assumes from `i. ii. iii.`. That costs the letter `i` as an alpha
 * start, which is not a loss: nobody starts a lettered list at its ninth item.
 * Only a marker that STARTS its sequence is accepted here (`a`, `A`, `i`, `I`),
 * because in prose that is the one that means "begin a list"; a later marker
 * typed at the head of an existing item is handled by the retype path, which
 * knows the list it is already in.
 */
export function orderedMarkerStart(text: string): OrderedNumbering | null {
    switch (text) {
        case "a": return "lower-alpha";
        case "A": return "upper-alpha";
        case "i": return "lower-roman";
        case "I": return "upper-roman";
        default: return null;
    }
}
