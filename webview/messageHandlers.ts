/**
 * messageHandlers.ts
 * 
 * 职责：处理 Extension → WebView 方向的消息分发
 * 
 * 本模块将每种消息类型映射到对应的处理函数，实现消息的解耦和类型安全。
 * 处理函数通过依赖注入获取所需的外部能力，便于测试和维护。
 */

import type { Editor } from "@milkdown/core";
import type { EditorView } from "@milkdown/prose/view";
import { editorViewCtx } from "@milkdown/core";
import type { ToWebviewMessage, TableWrapMode } from "../shared/messages";
import { setImageUriMap } from "./components/imageView";
import { dispatchPathSuggestions } from "./components/pathLink/pathComplete";
import { dispatchLinkTargetSuggestions } from "./components/pathLink/linkTargetComplete";
import { dispatchImgPathSuggestions, dispatchImagePathResolved } from "./components/imageView/imgPathComplete";
import { setDebugMode } from "./components/table/addButtons";
import { setLogTableSel, syncExternalContent } from "./editor";
import { setProofreadConfig } from "./plugins";
import { applyLintResults } from "./plugins/proofread";
import { notifySwitchToTextEditor, getWebviewState, setBaseSyncVersion } from "./messaging";
import { renderFrontmatterPanel } from "./components/frontmatter";
import { dispatchFmSuggestions } from "./components/frontmatter/suggestMenu";
import {
    handleImageUploaded,
    handleImageUploadError,
    handleProjectImagesList,
    handleImageRenamed,
    handleImageRenameError,
} from "./imageUpload";

// ── 全局表格换行模式 ─────────────────────────────────────────
let currentTableWrap: TableWrapMode = "normal";

/** 根据当前 tableWrap 配置动态更新表格单元格的 overflow-wrap 属性 */
export function applyTableWrap(wrap: TableWrapMode): void {
    currentTableWrap = wrap;
    const root = document.documentElement;
    switch (wrap) {
        case "aggressive":
            root.style.setProperty("--tbl-ow", "anywhere");
            break;
        case "normal":
            root.style.setProperty("--tbl-ow", "break-word");
            break;
        case "none":
            root.style.setProperty("--tbl-ow", "normal");
            break;
    }
}

// ── 类型定义 ──────────────────────────────────────────────

type ExtractMessage<T extends ToWebviewMessage["type"]> = Extract<ToWebviewMessage, { type: T }>;

/** 消息处理函数类型 */
export type Handler<T extends ToWebviewMessage["type"] = ToWebviewMessage["type"]> = (
    msg: ExtractMessage<T>,
    container: HTMLElement,
) => void | Promise<void>;

/** 工具栏控制器接口 */
export interface ToolbarController {
    onSelectionChange(view: EditorView): void;
    setDebugMode(enabled: boolean): void;
}

/** 编辑器状态管理接口 */
export interface EditorStateAccessor {
    getEditor: () => Editor | null;
    setEditor: (editor: Editor | null) => void;
    getLineMap: () => number[];
    setLineMap: (lineMap: number[]) => void;
    getMarkdownSource: () => string;
    setMarkdownSource: (source: string) => void;
}

/** 编辑器操作接口 */
export interface EditorActions {
    scrollToSourceLine: (view: EditorView, lineMap: number[], targetLine: number) => void;
    getFirstVisibleSourceLine: (view: EditorView, lineMap: number[]) => number;
    initEditor: (container: HTMLElement, markdown: string) => Promise<void>;
    retryScroll: (fn: () => void) => void;
    getEditorView: () => EditorView | null;
    /** Refreshes the table-of-contents panel after an inbound diff sync. */
    refreshToc: () => void;
}

/** 消息处理器依赖项 */
export interface MessageHandlerDeps {
    state: EditorStateAccessor;
    actions: EditorActions;
    topbarTb: ToolbarController | null;
    themeOverrides: Set<string>;
}

// ── 消息处理器工厂 ────────────────────────────────────────

/** 创建消息处理器 */
export function createMessageHandlers(
    deps: MessageHandlerDeps,
): { [K in ToWebviewMessage["type"]]?: Handler<K> } {
    const { state, actions, topbarTb, themeOverrides } = deps;
    const { getEditor, setEditor, getLineMap, setLineMap, getMarkdownSource, setMarkdownSource } = state;
    const { scrollToSourceLine, getFirstVisibleSourceLine, initEditor, retryScroll, getEditorView, refreshToc } = actions;

    return {
        async init(msg, container) {
            setBaseSyncVersion(msg.syncVersion);
            setMarkdownSource(msg.content);
            setLineMap(msg.lineMap ?? []);
            renderFrontmatterPanel(msg.frontmatter);
            if (msg.imageUriMap) {
                setImageUriMap(msg.imageUriMap);
            }
            if (msg.tableWrap) {
                applyTableWrap(msg.tableWrap);
            }
            await initEditor(container, msg.content);
            window.focus();
            if (msg.scrollToLine) {
                retryScroll(() =>
                    scrollToSourceLine(
                        getEditorView()!,
                        getLineMap(),
                        msg.scrollToLine!,
                    ),
                );
            } else {
                const saved = getWebviewState();
                if (saved?.scrollY) {
                    retryScroll(() =>
                        window.scrollTo({ top: saved.scrollY as number }),
                    );
                }
            }
        },
        async revert(msg, container) {
            setMarkdownSource(msg.content);
            setLineMap(msg.lineMap ?? []);
            renderFrontmatterPanel(msg.frontmatter);
            if (msg.imageUriMap) {
                setImageUriMap(msg.imageUriMap);
            }
            if (msg.tableWrap) {
                applyTableWrap(msg.tableWrap);
            }
            await initEditor(container, msg.content);
        },
        async externalUpdate(msg, container) {
            // Record the version we're syncing to so subsequent outbound edits
            // carry it as baseSyncVersion (stale-update rejection on the
            // extension side).
            setBaseSyncVersion(msg.syncVersion);
            setMarkdownSource(msg.content);
            setLineMap(msg.lineMap ?? []);
            renderFrontmatterPanel(msg.frontmatter);
            if (msg.imageUriMap) {
                setImageUriMap(msg.imageUriMap);
            }
            if (msg.tableWrap) {
                applyTableWrap(msg.tableWrap);
            }
            // Cursor-preserving diff apply; on any failure fall back to a full
            // rebuild exactly like revert (which loses the selection but is
            // guaranteed correct).
            if (syncExternalContent(msg.content)) {
                refreshToc();
            } else {
                await initEditor(container, msg.content);
            }
        },
        requestSwitchToTextEditor() {
            const view = getEditorView();
            const lineMap = getLineMap();
            const line = view ? getFirstVisibleSourceLine(view, lineMap) : undefined;
            notifySwitchToTextEditor(line);
        },
        scrollToLine(msg) {
            const lineMap = getLineMap();
            const scrollLine = msg.line;
            let scrollAttempts = 0;
            const tryScrollNow = () => {
                const view = getEditorView();
                if (view) {
                    scrollToSourceLine(view, lineMap, scrollLine);
                } else if (scrollAttempts < 8) {
                    scrollAttempts++;
                    setTimeout(tryScrollNow, 250);
                }
            };
            tryScrollNow();
        },
        lineMapUpdate(msg) {
            setLineMap(msg.lineMap);
        },
        setDebugMode(msg) {
            setDebugMode(msg.enabled);
            setLogTableSel(msg.enabled);
            topbarTb?.setDebugMode(msg.enabled);
        },
        imageUploaded(msg) {
            handleImageUploaded(msg.id, msg.url);
        },
        imageUploadError(msg) {
            handleImageUploadError(msg.id, msg.error);
        },
        projectImagesList(msg) {
            handleProjectImagesList(msg.id, msg.images);
        },
        imageRenamed(msg) {
            handleImageRenamed(msg.id);
            const editor = getEditor();
            if (editor) {
                editor.action((ctx) => {
                    const view = ctx.get(editorViewCtx);
                    const { state } = view;
                    const tr = state.tr;
                    let changed = false;
                    state.doc.descendants((node, pos) => {
                        if (
                            node.type.name === "image" &&
                            node.attrs["src"] === msg.oldWebviewUri
                        ) {
                            tr.setNodeMarkup(pos, null, {
                                ...node.attrs,
                                src: msg.newWebviewUri,
                            });
                            changed = true;
                        }
                    });
                    if (changed) {
                        view.dispatch(tr);
                    }
                });
            }
        },
        imageRenameError(msg) {
            handleImageRenameError(msg.id, msg.error);
        },
        pathSuggestions(msg) {
            dispatchPathSuggestions(msg.id, msg.items);
            dispatchImgPathSuggestions(msg.id, msg.items);
        },
        linkTargetSuggestions(msg) {
            dispatchLinkTargetSuggestions(msg.id, msg.items);
        },
        imagePathResolved(msg) {
            dispatchImagePathResolved(msg.id, msg.webviewUri);
        },
        setTheme(msg) {
            const root = document.documentElement;
            for (const prop of themeOverrides) {
                root.style.removeProperty(prop);
            }
            themeOverrides.clear();
            for (const [key, value] of Object.entries(msg.colors)) {
                if (value) {
                    root.style.setProperty(key, value);
                    themeOverrides.add(key);
                }
            }
            window.dispatchEvent(new CustomEvent("theme-changed"));
        },
        setTableWrap(msg) {
            applyTableWrap(msg.wrap);
        },
        fmSuggestions(msg) {
            dispatchFmSuggestions(msg.key, msg.values);
        },
        proofreadConfig(msg) {
            const view = getEditorView();
            if (view) {
                setProofreadConfig(view, msg.config);
            }
        },
        lintResults(msg) {
            applyLintResults(msg.id, msg.results);
        },
    };
}
