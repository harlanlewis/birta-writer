/**
 * The placeholder after a committed slash pill: once `/ai ` is a pill and
 * nothing has been typed after it, a quiet line at the caret says what to
 * type and where it will go.
 *
 * It is the empty-line affordance one level down (plugins/emptyLineHint.ts):
 * same italic, same dimmed ink, same rule that one character of content
 * removes it, because the discovery is over the moment the user acts on it.
 * The difference is what it answers. An empty line asks "what can I do
 * here"; a committed pill asks "what goes in the blank, and what happens
 * when I press Enter" — and for `/ai` the answer names the tool and, when
 * the template says one, the model, which is otherwise invisible until the
 * run has already started.
 *
 * Driven by setSlashArgumentHint(view, hint|null) via a meta-only
 * transaction, the setPendingRange pattern: no doc change, so it never
 * touches serialization or autosave, and the decoration maps through
 * concurrent doc changes. The slash menu dispatches it only when the text
 * CHANGES, so typing an argument costs one transaction at the first
 * keystroke rather than one per keystroke.
 *
 * The widget takes no width (a zero-width host whose content overflows), so
 * a construct with text after it on the line does not reflow when the hint
 * appears and vanishes — the document must look exactly as it will once the
 * hint is gone.
 *
 * `side: 1` is safe HERE and is not a pattern to copy to a new widget. In an
 * empty textblock, WebKit will not hold an insertion point in front of an
 * uneditable widget with nothing before it, and re-anchors the caret to the
 * end of the previous block; such a widget needs a negative side, and
 * Chromium never reports the problem. This one sits after a committed pill,
 * so there are always at least the pill's own characters before it and the
 * position is never a block's first.
 */
import { Plugin, PluginKey } from "../pm";
import { Decoration, DecorationSet } from "../pm";
import type { EditorView } from "../pm";
import { $prose } from "@milkdown/utils";

/** The hint's words, in the weights it renders them at. */
export interface SlashArgumentHintText {
    /** The sentence. An empty string draws nothing. */
    text: string;
    /**
     * The part of `text` naming what will run (a model, an effort), drawn
     * heavier. Must be a SUBSTRING of `text`: the sentence is always exactly
     * `text`, and a `strong` not found in it simply fails to emphasise
     * rather than appending words nobody wrote.
     */
    strong?: string;
    /** What another key does from here, drawn quieter after the sentence. */
    trailing?: string;
}

export interface SlashArgumentHint extends SlashArgumentHintText {
    /** Doc position the hint sits after: the caret at the end of the pill. */
    pos: number;
}

const slashArgumentHintKey = new PluginKey<DecorationSet>("MD_SLASH_ARG_HINT");

/** The hint's DOM: a zero-size host so the absolute child adds no layout. */
export function slashArgumentHintDom(hint: SlashArgumentHintText): () => HTMLElement {
    return () => {
        const host = document.createElement("span");
        host.className = "md-slash-arg-hint";
        host.contentEditable = "false";
        const line = document.createElement("span");
        const at = hint.strong ? hint.text.indexOf(hint.strong) : -1;
        if (hint.strong && at >= 0) {
            line.append(hint.text.slice(0, at));
            const strong = document.createElement("strong");
            strong.textContent = hint.strong;
            line.appendChild(strong);
            line.append(hint.text.slice(at + hint.strong.length));
        } else {
            line.textContent = hint.text;
        }
        if (hint.trailing) {
            const tail = document.createElement("span");
            tail.className = "md-slash-arg-hint-tail";
            tail.textContent = ` (${hint.trailing})`;
            line.appendChild(tail);
        }
        host.appendChild(line);
        return host;
    };
}

/** Show `hint` (null clears it). */
export function setSlashArgumentHint(view: EditorView, hint: SlashArgumentHint | null): void {
    view.dispatch(view.state.tr.setMeta(slashArgumentHintKey, hint));
}

/** The decoration set for one hint. Exported for tests. */
export function slashArgumentHintDecorations(
    doc: Parameters<typeof DecorationSet.create>[0],
    hint: SlashArgumentHint | null,
): DecorationSet {
    if (!hint || hint.text === "") {
        return DecorationSet.empty;
    }
    return DecorationSet.create(doc, [
        // `side: 1` keeps the widget after the caret rather than before it,
        // so the caret stays where the next character will land.
        // `ignoreSelection` stops a DOM selection landing inside the widget
        // from being read back as a document position.
        Decoration.widget(hint.pos, slashArgumentHintDom(hint), {
            side: 1,
            ignoreSelection: true,
            key: `md-slash-arg-hint:${hint.text}|${hint.strong ?? ""}|${hint.trailing ?? ""}`,
        }),
    ]);
}

export const slashArgumentHintPlugin = $prose(
    () =>
        new Plugin<DecorationSet>({
            key: slashArgumentHintKey,
            state: {
                init: () => DecorationSet.empty,
                apply(tr, set) {
                    const meta = tr.getMeta(slashArgumentHintKey) as
                        | SlashArgumentHint
                        | null
                        | undefined;
                    if (meta !== undefined) {
                        return slashArgumentHintDecorations(tr.doc, meta);
                    }
                    return set.map(tr.mapping, tr.doc);
                },
            },
            props: {
                decorations(state) {
                    return slashArgumentHintKey.getState(state) ?? DecorationSet.empty;
                },
            },
        }),
);
