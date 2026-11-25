/**
 * webview/utils/templateDirectives.ts — where a textblock holds template
 * directives, the spans a site generator or docs tool expands before (or
 * instead of) Markdown: Hugo and Quarto shortcodes (`{{< x >}}`, `{{% x %}}`),
 * Liquid, Jekyll, Eleventy, Nunjucks and Jinja tags and output
 * (`{% tag %}`, `{{ var }}`, `{# note #}`), Mustache and Handlebars
 * (`{{#each}}`, `{{{ raw }}}`).
 *
 * The family is recognized by its DELIMITERS, never by a table of tag names:
 * every one of those tools spells a directive as a brace pair with an inner
 * marker (`{{`, `{%`, `{#`), so one grammar covers them all and a tool nobody
 * listed is covered the day it appears. The editor never runs or expands a
 * directive; this module only says where one is, so the page can draw it as
 * source (plugins/templateDirectives.ts).
 *
 * Grammar, deliberately strict, one line at most:
 *   `{{{` inner `}}}`   (inner holds no brace)
 *   `{{` inner `}}`     (not part of a longer brace run; inner holds no `{{`)
 *   `{%` inner `%}`
 *   `{#` inner `#}`
 * The inner text must name something: at least one letter, digit, `_`, `.`,
 * `$` or `@`. That is what keeps `{{}}`, `{% %}` and brace punctuation in
 * prose out, and what lets Go's `{{ . }}` in.
 *
 * Code is never a directive. The scan string a textblock builds puts a
 * placeholder where inline code, math, a wikilink, an image or any other
 * non-text inline sits, and the grammar refuses a placeholder, so a match can
 * neither start in nor run through one; a code block is skipped whole. An
 * inline `html` atom is the exception, because `{{<figure src="a">}}` parses
 * its middle as a tag: the atom contributes its raw bytes, and a match may run
 * through it but never start or end inside it.
 *
 * This reads text and changes nothing. `findDirectives` is also the grammar
 * three byte-level decisions use: which spans the save path's serializer
 * writes verbatim (serialization.ts), which saved spans an edited line keeps
 * (`carrySavedDirectives` in utils/minimalDiff.ts), and where a bare URL stays
 * text at parse time (plugins/directiveAutolinks.ts). A change to the grammar
 * is a change to all three.
 */
import type { Node as ProseNode } from "../pm";

/** What stands in for an inline the grammar must never cross. */
const PLACEHOLDER = "\uFFFC";

/**
 * The four delimiter forms. The double form's lookarounds stop it from
 * claiming two braces out of a longer run (`{{{ x }}}` is the triple form or
 * nothing, and `{{ x }}}` is taken whole rather than leaving a brace behind). Excluding the line break and the
 * placeholder keeps every form to one line and out of code.
 */
const DIRECTIVE_RE =
    /\{\{\{[^\n\uFFFC{}]*?\}\}\}|(?<!\{)\{\{(?!\{)(?:(?!\{\{)[^\n\uFFFC])*?\}\}(?!\})|\{%[^\n\uFFFC]*?%\}|\{#[^\n\uFFFC]*?#\}/g;

/** The inner text must name something (see the header). */
const NAMES_SOMETHING = /[\p{L}\p{N}_.$@]/u;

export interface DirectiveSpan {
    /** Offset of the first `{`, in the scanned string. */
    from: number;
    /** Offset just past the last `}`. */
    to: number;
}

/** Every directive in `text`, in order, non-overlapping. */
export function findDirectives(text: string): DirectiveSpan[] {
    if (text.indexOf("{") < 0) return [];
    const out: DirectiveSpan[] = [];
    DIRECTIVE_RE.lastIndex = 0;
    for (let m = DIRECTIVE_RE.exec(text); m; m = DIRECTIVE_RE.exec(text)) {
        const raw = m[0];
        const open = raw.startsWith("{{{") ? 3 : 2;
        const inner = raw.slice(open, raw.length - open);
        if (NAMES_SOMETHING.test(inner)) {
            out.push({ from: m.index, to: m.index + raw.length });
        }
    }
    return out;
}

/** One directive in a textblock, in document positions. */
export interface BlockDirective {
    from: number;
    to: number;
    /** Inline `html` atoms the directive runs through: position and raw bytes. */
    atoms: Array<{ pos: number; value: string }>;
}

/** A textblock's directives, and the soft breaks that should draw as line breaks. */
export interface BlockDirectives {
    directives: BlockDirective[];
    /** Positions of soft breaks that border a line holding only directives. */
    lineBreaks: number[];
}

const NONE: BlockDirectives = { directives: [], lineBreaks: [] };

/**
 * The directives in one textblock whose content starts at `start` (the
 * block's position plus one). A code block holds none, by definition.
 */
export function blockDirectives(block: ProseNode, start: number): BlockDirectives {
    if (!block.isTextblock || block.type.spec.code) return NONE;
    // Most blocks hold no brace outside code: answer them before allocating.
    let sawBrace = false;
    block.forEach((child) => {
        if (!sawBrace && child.isText && (child.text ?? "").indexOf("{") >= 0
            && !child.marks.some((m) => m.type.spec.code)) sawBrace = true;
    });
    if (!sawBrace) return NONE;
    // The scan string and, per character, the document position it came from
    // and whether it is text a directive may begin or end on. An html atom's
    // bytes all map to the atom's own position, which is why a match boundary
    // may not fall inside one.
    let text = "";
    const posOf: number[] = [];
    const edgeOk: boolean[] = [];
    const breaks: Array<{ index: number; pos: number; soft: boolean }> = [];
    block.forEach((child, offset) => {
        const pos = start + offset;
        if (child.isText) {
            const value = child.text ?? "";
            const code = child.marks.some((m) => m.type.spec.code);
            for (let i = 0; i < value.length; i++) {
                text += code ? PLACEHOLDER : value[i];
                posOf.push(pos + i);
                edgeOk.push(!code);
            }
            return;
        }
        if (child.type.name === "hardbreak") {
            breaks.push({ index: text.length, pos, soft: Boolean(child.attrs["isInline"]) });
            text += "\n";
            posOf.push(pos);
            edgeOk.push(false);
            return;
        }
        if (child.type.name === "html") {
            const value = String(child.attrs["value"] ?? "");
            for (let i = 0; i < value.length; i++) {
                text += value[i];
                posOf.push(pos);
                edgeOk.push(false);
            }
            return;
        }
        for (let i = 0; i < child.nodeSize; i++) {
            text += PLACEHOLDER;
            posOf.push(pos + i);
            edgeOk.push(false);
        }
    });

    const directives: BlockDirective[] = [];
    const spans: DirectiveSpan[] = [];
    for (const span of findDirectives(text)) {
        if (!edgeOk[span.from] || !edgeOk[span.to - 1]) continue;
        const atoms: BlockDirective["atoms"] = [];
        let last = -1;
        block.nodesBetween(posOf[span.from]! - start, posOf[span.to - 1]! + 1 - start, (child, offset) => {
            if (child.type.name === "html" && start + offset !== last) {
                last = start + offset;
                atoms.push({ pos: last, value: String(child.attrs["value"] ?? "") });
            }
            return false;
        });
        directives.push({ from: posOf[span.from]!, to: posOf[span.to - 1]! + 1, atoms });
        spans.push(span);
    }
    if (directives.length === 0) return NONE;
    return { directives, lineBreaks: directiveLineBreaks(text, spans, breaks) };
}

/**
 * The soft breaks on either side of a line that holds directives and nothing
 * else but whitespace. CommonMark joins the lines of a paragraph, so a
 * directive written on its own line would otherwise run into the text beside
 * it; a hard break already ends its line and needs nothing.
 */
function directiveLineBreaks(
    text: string,
    spans: readonly DirectiveSpan[],
    breaks: ReadonlyArray<{ index: number; pos: number; soft: boolean }>,
): number[] {
    if (breaks.length === 0) return [];
    const out = new Set<number>();
    let lineStart = 0;
    let s = 0;
    for (let b = 0; b <= breaks.length; b++) {
        const lineEnd = b < breaks.length ? breaks[b]!.index : text.length;
        let rest = "";
        let held = 0;
        let cursor = lineStart;
        while (s < spans.length && spans[s]!.from < lineEnd) {
            rest += text.slice(cursor, spans[s]!.from);
            cursor = spans[s]!.to;
            held++;
            s++;
        }
        rest += text.slice(cursor, lineEnd);
        if (held > 0 && rest.trim() === "") {
            const before = b > 0 ? breaks[b - 1] : undefined;
            const after = b < breaks.length ? breaks[b] : undefined;
            if (before?.soft) out.add(before.pos);
            if (after?.soft) out.add(after.pos);
        }
        lineStart = lineEnd + 1;
    }
    return [...out].sort((a, b) => a - b);
}
