/**
 * Backtick wraps a selection in inline code.
 *
 * With text selected, `` ` `` toggles the inlineCode mark instead of replacing
 * the selection with a literal backtick — the behavior every comparable editor
 * has, and the one the slash menu already advertises (`inlineCode`'s hint is
 * "`"). It is the same toggle `Mod-e` and the toolbar button perform, so the
 * three surfaces can't drift: already-code text un-codes.
 *
 * `handleTextInput` is the seam rather than a keymap, because a keymap matches
 * `event.key` and backtick is a DEAD KEY on a good number of layouts (it starts
 * a compose sequence and never arrives as a plain keydown). This prop is fed by
 * ProseMirror's own text-input path, so composed and IME input reach it the
 * same way ordinary typing does. It fires only for a selection inside ONE
 * textblock — a selection spanning blocks keeps the standard replace-the-
 * selection behavior, unchanged from today.
 *
 * Empty selection is deliberately untouched: a lone `` ` `` there is the
 * opening delimiter of the stock ``` `code` ``` input rule, and claiming it
 * would break typing code spans the ordinary way.
 */
import { Plugin, PluginKey, toggleMark } from "../pm";
import type { EditorState, EditorView } from "../pm";
import { $prose } from "@milkdown/utils";

const backtickWrapKey = new PluginKey("MD_BACKTICK_WRAP");

/**
 * Toggles inlineCode over a non-empty selection when the typed character is a
 * backtick. Exported for the unit test, and pure of the plugin wiring.
 */
export function handleBacktickInput(
    state: EditorState,
    dispatch: ((tr: EditorState["tr"]) => void) | undefined,
    from: number,
    to: number,
    text: string,
): boolean {
    if (text !== "`" || from >= to) { return false; }
    const codeMark = state.schema.marks["inlineCode"];
    if (!codeMark) { return false; }
    // Inside a code block a backtick is literal text, never formatting.
    if (state.doc.resolve(from).parent.type.spec.code) { return false; }
    return toggleMark(codeMark)(state, dispatch);
}

export const backtickWrapPlugin = $prose(() =>
    new Plugin({
        key: backtickWrapKey,
        props: {
            handleTextInput(view: EditorView, from: number, to: number, text: string): boolean {
                return handleBacktickInput(
                    view.state,
                    (tr) => view.dispatch(tr),
                    from,
                    to,
                    text,
                );
            },
        },
    }),
);
