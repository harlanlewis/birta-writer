import { commandsCtx } from "@milkdown/core";
import {
    toggleEmphasisCommand,
    toggleInlineCodeCommand,
    toggleStrongCommand,
} from "@milkdown/preset-commonmark";
import { toggleStrikethroughCommand } from "@milkdown/preset-gfm";
import { getView, keymap } from "../pm";
import { TextSelection } from "../pm";
import { $prose } from "@milkdown/utils";

// Formatting shortcuts: Mod-b bold, Mod-i italic, Mod-Shift-x strikethrough,
// Mod-e inline code.
// Returning true makes ProseMirror call preventDefault(), but the event still
// BUBBLES: the VS Code webview host forwards it to the workbench from a
// window-level listener (so Cmd+B would also toggle the sidebar, Cmd+I open
// chat, ...). The document-level key-leak guard in webview/keyboardShortcuts.ts
// stops propagation for these combos before they reach that forwarder.
export const formatKeymapPlugin = $prose((ctx) =>
    keymap({
        "Mod-b": () => {
            ctx.get(commandsCtx).call(toggleStrongCommand.key);
            return true;
        },
        "Mod-i": () => {
            ctx.get(commandsCtx).call(toggleEmphasisCommand.key);
            return true;
        },
        "Mod-Shift-x": () => {
            ctx.get(commandsCtx).call(toggleStrikethroughCommand.key);
            return true;
        },
        "Mod-e": () => {
            const view = getView(ctx);
            const { state } = view;
            if (!state.selection.empty) {
                ctx.get(commandsCtx).call(toggleInlineCodeCommand.key);
                return true;
            }

            const codeMark = state.schema.marks["inlineCode"];
            if (!codeMark) { return true; }
            const { from } = state.selection;
            const textNode = state.schema.text("\u200b", [codeMark.create()]);
            const tr = state.tr.insert(from, textNode);
            tr.setSelection(TextSelection.create(tr.doc, from + 1));
            view.dispatch(tr);
            return true;
        },
    }),
);
