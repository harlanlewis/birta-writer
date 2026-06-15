import { commandsCtx, editorViewCtx } from "@milkdown/core";
import {
    toggleEmphasisCommand,
    toggleInlineCodeCommand,
    toggleStrongCommand,
} from "@milkdown/preset-commonmark";
import { toggleStrikethroughCommand } from "@milkdown/preset-gfm";
import { keymap } from "@milkdown/prose/keymap";
import { TextSelection } from "@milkdown/prose/state";
import { $prose } from "@milkdown/utils";

// 格式化快捷键：Mod-b 粗体、Mod-i 斜体、Mod-Shift-x 删除线、Mod-e 行内代码
// return true 使 ProseMirror 调用 preventDefault，阻止 VSCode 快捷键（如 Cmd+B 侧栏切换）冒泡
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
            const view = ctx.get(editorViewCtx);
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
