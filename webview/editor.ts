import {
    defaultValueCtx,
    Editor,
    editorViewCtx,
    nodeViewCtx,
    rootCtx,
} from "@milkdown/core";
import { listener, listenerCtx } from "@milkdown/plugin-listener";
import { prism, prismConfig } from "@milkdown/plugin-prism";
import { gfm } from "@milkdown/preset-gfm";
import type { EditorView } from "@milkdown/prose/view";
import DOMPurify from "dompurify";
import { createCodeBlockView } from "./components/codeBlock";
import { createImageView } from "./components/imageView";
import { refractor } from "./highlighter";
import { configureSerialization, pureCommonmark } from "./serialization";
import { applyMinimalChanges } from "./utils/minimalDiff";
import {
    cellClickFixPlugin,
    codeBlockBackspacePlugin,
    codeBlockSelectAllPlugin,
    formatKeymapPlugin,
    headingEmptyDeletePlugin,
    headingFoldPlugin,
    headingStickyPlugin,
    historyKeymapPlugin,
    historyPlugin,
    horizontalRuleKeymapPlugin,
    horizontalRulePlugin,
    listLiftPlugin,
    listSpreadNormalizePlugin,
    selectionPlugin,
    tabKeymapPlugin,
    trailingHrParagraphPlugin,
} from "./plugins";

export { registerSelectionChangeHandler, setLogTableSel } from "./plugins";

// ── HTML inline NodeView ───────────────────────────────────────────────────
// Milkdown 的 html 节点（atom, inline）默认以 textContent 显示原始标签。
// 此 NodeView 用 DOMPurify 净化后渲染真实 HTML，实现只读预览。
function createHtmlView(node: { attrs: Record<string, string> }) {
    const dom = document.createElement("span");
    dom.className = "html-inline";
    dom.dataset["type"] = "html";
    const raw = node.attrs["value"] ?? "";
    dom.innerHTML = DOMPurify.sanitize(raw, {
        USE_PROFILES: { html: true },
        ADD_ATTR: ["align", "width", "height"],
    });
    return {
        dom,
        ignoreMutation: () => true,
        stopEvent: () => false,
    };
}

let _editor: Editor | null = null;

// 上次保存/加载的 Markdown 原文（含用户原始格式：空行、分隔线宽度等）
// 用于在自动保存时做最小化差异合并，避免全量序列化改变未编辑区域的格式
let _savedMarkdown = '';

// 用户是否已与编辑器产生交互（键盘/鼠标/粘贴等）
// 每次 createEditor() 重置为 false，避免"仅打开文件即触发自动保存"
let _hasUserInteracted = false;
let _interactionListenerAdded = false;

function setupInteractionTracking(): void {
    if (_interactionListenerAdded) return;
    _interactionListenerAdded = true;
    const mark = () => { _hasUserInteracted = true; };
    document.addEventListener('keydown',   mark, { capture: true });
    document.addEventListener('mousedown', mark, { capture: true });
    document.addEventListener('paste',     mark, { capture: true });
    document.addEventListener('drop',      mark, { capture: true });
    document.addEventListener('cut',       mark, { capture: true });
}

export function getEditorView(): EditorView | null {
    if (!_editor) {
        return null;
    }
    return _editor.action((ctx) => ctx.get(editorViewCtx));
}

export async function createEditor(
    container: HTMLElement,
    initialMarkdown: string,
    onUpdate: (markdown: string) => void,
    onRenameImage?: (webviewUri: string, newBasename: string) => Promise<void>,
): Promise<Editor> {
    // Milkdown 的 markdownUpdated 监听器在 create() 完成后异步交付（RAF/microtask），
    // 此时 isSettled 已为 true，会误触发保存。通过 _hasUserInteracted 确保
    // 只有用户真正操作过才允许向 Extension 发送内容更新。
    _hasUserInteracted = false;
    setupInteractionTracking();

    let debounceTimer: ReturnType<typeof setTimeout>;
    // IME 合成期间（compositionstart → compositionend）暂存最新 markdown，
    // 防止拼音中间态被保存到文件
    let isComposing = false;
    let pendingMd: string | null = null;

    const fireUpdate = (md: string) => {
        clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => onUpdate(md), 300);
    };
    const debouncedUpdate = (md: string) => {
        if (isComposing) {
            pendingMd = md; // 合成中：暂存，等 compositionend 再发
            return;
        }
        fireUpdate(md);
    };

    container.addEventListener('compositionstart', () => {
        isComposing = true;
    });
    container.addEventListener('compositionend', () => {
        isComposing = false;
        if (pendingMd !== null) {
            const md = pendingMd;
            pendingMd = null;
            fireUpdate(md); // 合成完成后立即触发（仍经 300ms 防抖，合并快速连续提交）
        }
    });

    // editor.create() 期间会因设置初始内容而触发 markdownUpdated，
    // 用此标志阻断该初始触发，避免"打开即静默保存"的问题
    let isSettled = false;

    _editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, container);
            ctx.set(defaultValueCtx, initialMarkdown);
            // Stringify options that keep serializer output close to the
            // original file formatting (bullets, rules, table widths)
            configureSerialization(ctx);
            _savedMarkdown = initialMarkdown;
            ctx.get(listenerCtx).markdownUpdated((_ctx, markdown) => {
                if (!isSettled) return;          // 跳过初始化同步触发
                if (!_hasUserInteracted) return; // 跳过初始化异步触发（RAF/microtask 延迟交付）
                const toSave = applyMinimalChanges(_savedMarkdown, markdown);
                if (toSave === _savedMarkdown) return; // 内容无实质变化，不触发保存
                _savedMarkdown = toSave;
                debouncedUpdate(toSave);
            });
            // 配置 prism：使用我们已注册语言的 refractor 实例
            ctx.set(prismConfig.key, {
                configureRefractor: () => refractor,
            });
            // 注册 code_block NodeView（顶部语言选择 + 复制按钮）
            ctx.set(nodeViewCtx, [
                ["code_block", createCodeBlockView],
                ["html", (node: { attrs: Record<string, string> }) => createHtmlView(node)],
                [
                    "image",
                    (node, view, getPos) =>
                        createImageView(
                            node,
                            view,
                            getPos,
                            undefined,
                            undefined,
                            onRenameImage,
                        ),
                ],
            ]);
        })
        .use(pureCommonmark)
        .use(gfm)
        .use(listener)
        .use(prism)
        .use(historyPlugin)
        .use(historyKeymapPlugin)
        .use(listLiftPlugin)
        .use(horizontalRulePlugin)
        .use(horizontalRuleKeymapPlugin)
        .use(codeBlockBackspacePlugin)
        .use(codeBlockSelectAllPlugin)
        .use(headingEmptyDeletePlugin)
        .use(selectionPlugin)
        .use(headingFoldPlugin)
        .use(headingStickyPlugin)
        .use(formatKeymapPlugin)
        .use(tabKeymapPlugin)
        .use(cellClickFixPlugin)
        .use(listSpreadNormalizePlugin)
        .use(trailingHrParagraphPlugin)
        .create();

    isSettled = true;
    return _editor;
}
