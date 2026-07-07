/**
 * Highlight — `==marked text==` (the Obsidian highlight syntax).
 *
 * Character-level-novel syntax, so — like wikiLinks.ts — a custom micromark
 * text construct rather than a tree transform. The grammar is deliberately
 * STRICT; anything else stays plain text:
 *
 *   `==` , content , `==`
 *   where content is 1+ chars with no `=`, no line endings, and no leading
 *   or trailing space.
 *
 * Rationale: allowing `=` inside content requires attention-style resolvers
 * (the strikethrough machinery); rejecting it keeps the tokenizer a simple
 * linear scan with zero ambiguity. `==a=b==` and `== spaced ==` stay plain
 * text — visible and byte-preserved. Content is NOT sub-tokenized: nested
 * formatting inside `==…==` renders literally (matching the raw-slice
 * fidelity philosophy — the mdast child is the exact source bytes and the
 * stringify handler re-emits them verbatim, no escaping applied).
 *
 * In ProseMirror, highlight is a MARK (like strikethrough), so toggling and
 * typing across it behave natively.
 */
import type { Node as MdastNode } from "@milkdown/transformer";
import { markRule } from "@milkdown/prose";
import { toggleMark } from "@milkdown/prose/commands";
import { $command, $inputRule, $markSchema, $remark } from "@milkdown/utils";

export const highlightId = "highlight";

// ─── micromark construct ────────────────────────────────────────────────────

const EQUALS = 61; // =
const SPACE = 32;
const TAB = 9;

/** EOF or any of micromark's virtual characters (line endings, tab fills). */
function isUnrepresentable(code: number | null): boolean {
    return code === null || code < 0;
}

function isSpace(code: number | null): boolean {
    return code === SPACE || code === TAB;
}

const highlightSyntax = {
    text: {
        [EQUALS]: {
            name: "highlight",
            tokenize(effects: any, ok: any, nok: any) {
                let previousWasSpace = false;

                return start;

                function start(code: number): any {
                    effects.enter("highlight");
                    effects.enter("highlightMarker");
                    effects.consume(code);
                    return secondOpen;
                }

                function secondOpen(code: number | null): any {
                    if (code !== EQUALS) return nok(code);
                    effects.consume(code);
                    effects.exit("highlightMarker");
                    return firstData;
                }

                function firstData(code: number | null): any {
                    // No empty highlight, no leading space, no `===`.
                    if (isUnrepresentable(code) || isSpace(code) || code === EQUALS) {
                        return nok(code);
                    }
                    effects.enter("highlightData");
                    effects.consume(code);
                    previousWasSpace = false;
                    return data;
                }

                function data(code: number | null): any {
                    if (isUnrepresentable(code)) return nok(code);
                    if (code === EQUALS) {
                        // No trailing space before the closing marker.
                        if (previousWasSpace) return nok(code);
                        effects.exit("highlightData");
                        effects.enter("highlightMarker");
                        effects.consume(code);
                        return secondClose;
                    }
                    previousWasSpace = isSpace(code);
                    effects.consume(code);
                    return data;
                }

                function secondClose(code: number | null): any {
                    // A single `=` in content rejects the whole construct
                    // (strict grammar) — the text falls back to plain prose.
                    if (code !== EQUALS) return nok(code);
                    effects.consume(code);
                    effects.exit("highlightMarker");
                    effects.exit("highlight");
                    return ok;
                }
            },
        },
    },
};

// fromMarkdown: a `highlight` mdast node whose single text child is the EXACT
// source bytes between the markers.
const highlightFromMarkdown = {
    enter: {
        highlight(this: any, token: unknown) {
            this.enter({ type: "highlight", children: [] }, token);
        },
    },
    exit: {
        highlightData(this: any, token: unknown) {
            const node = this.stack[this.stack.length - 1];
            node.children.push({ type: "text", value: this.sliceSerialize(token) });
        },
        highlight(this: any, token: unknown) {
            this.exit(token);
        },
    },
};

// toMarkdown: re-emit the child text verbatim between markers — no escaping,
// byte-identity by construction. (A highlight CREATED in the editor whose
// text contains `==` would not survive a reparse; the toggle command and
// input rule can't produce one from parsed content, so this stays a
// theoretical paste-edge, preserved as typed.)
const highlightToMarkdown = {
    handlers: {
        highlight(node: MdastNode & { children?: Array<{ value?: string }> }): string {
            const text = (node.children ?? []).map((c) => c.value ?? "").join("");
            return `==${text}==`;
        },
    },
};

function remarkHighlight(this: any): void {
    const data = this.data();
    const add = (field: string, value: unknown) => {
        const list = data[field] ?? (data[field] = []);
        list.push(value);
    };
    add("micromarkExtensions", highlightSyntax);
    add("fromMarkdownExtensions", highlightFromMarkdown);
    add("toMarkdownExtensions", highlightToMarkdown);
}

export const highlightRemarkPlugin = $remark("remarkHighlight", () => remarkHighlight);

// ─── ProseMirror mark schema ────────────────────────────────────────────────

export const highlightSchema = $markSchema(highlightId, () => ({
    parseDOM: [{ tag: "mark" }],
    toDOM: () => ["mark", { class: "md-highlight" }],
    parseMarkdown: {
        match: (node) => node.type === "highlight",
        runner: (state, node, markType) => {
            state.openMark(markType);
            state.next(node.children);
            state.closeMark(markType);
        },
    },
    toMarkdown: {
        match: (mark) => mark.type.name === highlightId,
        runner: (state, mark) => {
            state.withMark(mark, "highlight");
        },
    },
}));

/** Typing `==text==` applies the mark as the closing `=` lands. */
export const HIGHLIGHT_RULE_REGEX = /==([^=\s](?:[^=]*[^=\s])?)==$/;

export const highlightInputRule = $inputRule((ctx) =>
    markRule(HIGHLIGHT_RULE_REGEX, highlightSchema.type(ctx)),
);

/** Toggles the highlight mark on the selection. */
export const toggleHighlightCommand = $command(
    "ToggleHighlight",
    (ctx) => () => toggleMark(highlightSchema.type(ctx)),
);

/** Parse/serialize plugins, flattened for `Editor.use()` / pureCommonmark. */
export const highlightPlugin = [
    highlightRemarkPlugin,
    highlightSchema,
    highlightInputRule,
].flat();
