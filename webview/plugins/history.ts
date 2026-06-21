import { history, redo, undo } from "@milkdown/prose/history";
import { keymap } from "@milkdown/prose/keymap";
import { $prose } from "@milkdown/utils";

// 注册 ProseMirror history 插件（支持 undo/redo）
export const historyPlugin = $prose(() => history());

// 注册快捷键：Mod-z = undo，Mod-Shift-z / Mod-y = redo
export const historyKeymapPlugin = $prose(() =>
    keymap({
        "Mod-z": undo,
        "Mod-y": redo,
        "Mod-Shift-z": redo,
    }),
);
