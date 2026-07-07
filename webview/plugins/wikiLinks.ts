/**
 * Wikilinks — `[[target]]`, `[[target|alias]]`, `[[target#heading]]`.
 *
 * The Obsidian/Foam convention (target first, `|` alias after), parsed by a
 * ~100-line custom micromark construct instead of an existing package, for
 * one reason: round-trip fidelity. The published wikilink extensions
 * RECONSTRUCT `[[value|alias]]` from parsed fields on stringify, so divider
 * spacing and escape edge cases aren't provably byte-identical. Here the
 * mdast node's `value` is `sliceSerialize` of the source bytes between the
 * brackets and the stringify handler re-emits `[[` + value + `]]` verbatim —
 * byte-identity by construction, the fidelitySerializer philosophy.
 *
 * Grammar (deliberately strict — anything else stays plain text):
 *   `[[` , one or more chars that are not `[`, `]`, or a line ending , `]]`
 * The construct bails unless the second char is also `[`, so `[text](url)`,
 * `[ref]` shortcuts, footnotes `[^1]`, and task markers `[x]` never reach it.
 *
 * In ProseMirror a wikilink is an inline ATOM node (the image_ref precedent),
 * not a mark: the display text (alias) differs from the target, and an atom
 * makes it structurally impossible for typing to desync the visible text from
 * the raw form. `raw` is the only canonical attr; target/heading/alias are
 * derived (parseWikiRaw) for display and navigation only.
 *
 * Navigation (the openFile `wiki` flag) and creation UI live elsewhere; this
 * module is parse/render/serialize only, registered unconditionally in
 * serialization.ts so round-trip behavior never depends on configuration.
 */
import type { Node as MdastNode } from "@milkdown/transformer";
import { nodeRule } from "@milkdown/prose";
import { $inputRule, $nodeSchema, $remark } from "@milkdown/utils";

export const wikiLinkId = "wiki_link";

/** The parsed (display/navigation) reading of a wikilink's raw content. */
export interface WikiRawParts {
    /** file target, trimmed; empty for a same-page `[[#heading]]` link */
    target: string;
    /** heading inside the target, trimmed; null when absent */
    heading: string | null;
    /** display alias, trimmed; null when absent */
    alias: string | null;
}

/** Index of the first `ch` not preceded by a backslash, or -1. */
function indexOfUnescaped(s: string, ch: string): number {
    for (let i = 0; i < s.length; i++) {
        if (s[i] === "\\") { i++; continue; }
        if (s[i] === ch) return i;
    }
    return -1;
}

/**
 * Splits a wikilink's raw inner bytes on the FIRST unescaped `|` (alias —
 * `\|` is Obsidian's in-table spelling of a plain pipe) and the first `#`
 * before it (heading). Returns trimmed, unescaped copies for display and
 * resolution; `raw` itself is never modified — it is what serializes back
 * to disk.
 */
export function parseWikiRaw(raw: string): WikiRawParts {
    const unescapePipes = (s: string) => s.replace(/\\\|/g, "|");
    const pipe = indexOfUnescaped(raw, "|");
    const targetPart = pipe >= 0 ? raw.slice(0, pipe) : raw;
    const aliasPart = pipe >= 0 ? raw.slice(pipe + 1) : null;
    const hash = targetPart.indexOf("#");
    const target = unescapePipes(hash >= 0 ? targetPart.slice(0, hash) : targetPart).trim();
    const heading = hash >= 0 ? unescapePipes(targetPart.slice(hash + 1)).trim() : null;
    const alias = aliasPart !== null ? unescapePipes(aliasPart).trim() : null;
    return { target, heading, alias };
}

/**
 * The text a wikilink displays: the alias if present, else target(#heading).
 * A degenerate raw (`[[ ]]`, `[[|]]`) falls back to the bracketed source so
 * the atom is never an invisible chip ("visible but safe").
 */
export function wikiDisplayText(raw: string): string {
    const { target, heading, alias } = parseWikiRaw(raw);
    if (alias) return alias;
    const text = heading !== null && heading !== "" ? `${target}#${heading}` : target;
    return text.trim() !== "" ? text : `[[${raw}]]`;
}

// ─── micromark construct ────────────────────────────────────────────────────

const LEFT_BRACKET = 91; // [
const RIGHT_BRACKET = 93; // ]

/** EOF or any of micromark's virtual characters (line endings, tab fills). */
function isUnrepresentable(code: number | null): boolean {
    return code === null || code < 0;
}

// Plain-object micromark extension: a text construct keyed on `[`. Written
// with raw character codes so no micromark-util-* helper packages are needed.
const wikiLinkSyntax = {
    text: {
        [LEFT_BRACKET]: {
            name: "wikiLink",
            tokenize(effects: any, ok: any, nok: any) {
                return start;

                function start(code: number): any {
                    effects.enter("wikiLink");
                    effects.enter("wikiLinkMarker");
                    effects.consume(code);
                    return secondOpen;
                }

                function secondOpen(code: number | null): any {
                    if (code !== LEFT_BRACKET) return nok(code);
                    effects.consume(code);
                    effects.exit("wikiLinkMarker");
                    return firstData;
                }

                function firstData(code: number | null): any {
                    if (
                        isUnrepresentable(code) ||
                        code === LEFT_BRACKET ||
                        code === RIGHT_BRACKET
                    ) {
                        return nok(code);
                    }
                    effects.enter("wikiLinkData");
                    effects.consume(code);
                    return data;
                }

                function data(code: number | null): any {
                    if (isUnrepresentable(code) || code === LEFT_BRACKET) {
                        return nok(code);
                    }
                    if (code === RIGHT_BRACKET) {
                        effects.exit("wikiLinkData");
                        effects.enter("wikiLinkMarker");
                        effects.consume(code);
                        return secondClose;
                    }
                    effects.consume(code);
                    return data;
                }

                function secondClose(code: number | null): any {
                    if (code !== RIGHT_BRACKET) return nok(code);
                    effects.consume(code);
                    return afterClose;
                }

                function afterClose(code: number | null): any {
                    // `[[x]](url)` is a CommonMark link whose label happens
                    // to hold brackets (the LLM-citation pattern) — hand it
                    // back to the label parser instead of hijacking the URL.
                    if (code === 40 /* ( */) return nok(code);
                    effects.exit("wikiLinkMarker");
                    effects.exit("wikiLink");
                    return ok(code);
                }
            },
        },
    },
};

// fromMarkdown: build a `wikiLink` mdast node whose value is the EXACT source
// bytes between the brackets (sliceSerialize of the data token).
const wikiLinkFromMarkdown = {
    enter: {
        wikiLink(this: any, token: unknown) {
            this.enter({ type: "wikiLink", value: "" }, token);
        },
    },
    exit: {
        wikiLinkData(this: any, token: unknown) {
            const node = this.stack[this.stack.length - 1];
            node.value = this.sliceSerialize(token);
        },
        wikiLink(this: any, token: unknown) {
            this.exit(token);
        },
    },
};

// toMarkdown: emit the stored bytes verbatim. No `peek` on purpose — peeking
// `[` would make the stringifier escape a preceding `!` (the image-ambiguity
// rule), changing bytes; unescaped `![[…]]` re-parses identically anyway.
// The one context-sensitive edit: inside a table cell, a bare `|` must ship
// as `\|` or it splits the cell. Only NEWLY CREATED atoms can carry a bare
// pipe there (a parsed-in-cell wikilink's source necessarily spelled `\|`,
// or the pipe would have ended the cell before the parser saw it), so
// escaping unescaped pipes never changes parsed bytes.
const wikiLinkToMarkdown = {
    handlers: {
        wikiLink(
            node: MdastNode & { value: string },
            _parent: unknown,
            state: { stack?: string[] } | undefined,
        ): string {
            const inCell = state?.stack?.includes("tableCell") ?? false;
            const value = inCell
                ? node.value.replace(/(?<!\\)\|/g, "\\|")
                : node.value;
            return `[[${value}]]`;
        },
    },
};

/** remark plugin wiring the three extensions into the shared pipeline. */
function remarkWikiLink(this: any): void {
    const data = this.data();
    const add = (field: string, value: unknown) => {
        const list = data[field] ?? (data[field] = []);
        list.push(value);
    };
    add("micromarkExtensions", wikiLinkSyntax);
    add("fromMarkdownExtensions", wikiLinkFromMarkdown);
    add("toMarkdownExtensions", wikiLinkToMarkdown);
}

export const remarkWikiLinkPlugin = $remark("remarkWikiLink", () => remarkWikiLink);

// ─── ProseMirror schema ─────────────────────────────────────────────────────

/** Attrs derived from `raw` for DOM and click routing. */
export function attrsFromRaw(raw: string): Record<string, string> {
    const { target, heading, alias } = parseWikiRaw(raw);
    return { raw, target, heading: heading ?? "", alias: alias ?? "" };
}

export const wikiLinkSchema = $nodeSchema(wikiLinkId, () => ({
    group: "inline",
    inline: true,
    atom: true,
    selectable: true,
    marks: "",
    attrs: {
        raw: { default: "" },
        target: { default: "" },
        heading: { default: "" },
        alias: { default: "" },
    },
    parseDOM: [
        {
            tag: 'a[data-type="wiki-link"]',
            getAttrs: (dom) => attrsFromRaw((dom as HTMLElement).dataset["raw"] ?? ""),
        },
    ],
    toDOM: (node) => {
        const raw = node.attrs["raw"] as string;
        return [
            "a",
            {
                "data-type": "wiki-link",
                "data-raw": raw,
                "data-target": node.attrs["target"] as string,
                "data-heading": node.attrs["heading"] as string,
                class: "wiki-link",
                contenteditable: "false",
            },
            wikiDisplayText(raw),
        ];
    },
    parseMarkdown: {
        match: (node) => node.type === "wikiLink",
        runner: (state, node, type) => {
            state.addNode(type, attrsFromRaw((node["value"] as string) ?? ""));
        },
    },
    toMarkdown: {
        match: (node) => node.type.name === wikiLinkId,
        runner: (state, node) => {
            state.addNode("wikiLink", undefined, node.attrs["raw"] as string);
        },
    },
}));

/**
 * Typing `[[target]]` (with optional `#heading` / `|alias`) converts to a
 * wikilink atom as the closing bracket lands — the mathInlineInputRule
 * pattern.
 */
export const WIKI_LINK_RULE_REGEX = /\[\[([^[\]]+)\]\]$/;

export const wikiLinkInputRule = $inputRule((ctx) =>
    nodeRule(WIKI_LINK_RULE_REGEX, wikiLinkSchema.type(ctx), {
        getAttr: (match) => attrsFromRaw(match[1] ?? ""),
    }),
);

/** All wikilink plugins, flattened for `Editor.use()` / pureCommonmark. */
export const wikiLinksPlugin = [
    remarkWikiLinkPlugin,
    wikiLinkSchema,
    wikiLinkInputRule,
].flat();
