/**
 * The dev-only Debug dropdown, built only when the host passes `debugOpts` and
 * shown only while `birta.debugMode` is on. It samples document positions
 * against the line map and copies the result to the clipboard - a diagnostic
 * for the position mapping, never a user-facing feature.
 */
import { getView, type EditorView } from "@/pm";
import { IconList, IconChevronDown } from "@/ui/icons";
import { t } from "@/i18n";
import { sampleDocPosition } from "@/utils/docPosition";
import type { GetEditor } from "@/editorCommands";
import { wireHoverMenu } from "./hoverMenu";

export interface DebugOpts {
    getLineMap: () => number[];
    getMarkdownSource: () => string;
}

export function createDebugMenu(debugOpts: DebugOpts, getEditor: GetEditor): HTMLElement {
    const { getLineMap, getMarkdownSource } = debugOpts;

    const dbgWrap = document.createElement("div");
    dbgWrap.className = "tb-fmt-wrap";

    const dbgBtn = document.createElement("button");
    dbgBtn.className = "ui-btn tb-btn tb-fmt-btn";
    dbgBtn.innerHTML = IconList + IconChevronDown;
    dbgBtn.setAttribute("aria-label", t("Debug"));
    // No tooltip: it would overlap the dropdown menu (see the font picker).
    dbgBtn.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
    });

    const dbgMenu = document.createElement("div");
    dbgMenu.className = "tb-fmt-menu";
    dbgMenu.style.display = "none";

    const testLineItem = document.createElement("button");
    testLineItem.className = "ui-menu-row tb-fmt-item";
    testLineItem.textContent = t("Test get line number");
    testLineItem.addEventListener("click", async () => {
        closeDbgMenu(); // shared close — owns the Escape-layer unregister
        const editor = getEditor();
        if (!editor) {
            return;
        }
        const view: EditorView = editor.action((ctx) =>
            getView(ctx),
        );
        if (!view) {
            return;
        }

        const nodeCount = view.state.doc.childCount;
        const step = Math.max(1, Math.floor(nodeCount / 10));
        const samples: object[] = [];
        let offset = 0;

        for (let idx = 0; idx < nodeCount; idx++) {
            const node = view.state.doc.child(idx);
            if (idx % step === 0 && samples.length < 10) {
                samples.push({
                    n: samples.length + 1,
                    ...sampleDocPosition(
                        view,
                        offset + 1,
                        getLineMap,
                        getMarkdownSource,
                    ),
                });
            }
            offset += node.nodeSize;
        }

        const json = JSON.stringify(
            {
                ts: new Date().toISOString(),
                docNodes: nodeCount,
                lineMapLen: getLineMap().length,
                srcLines: getMarkdownSource().split("\n").length,
                samples,
            },
            null,
            2,
        );

        try {
            await navigator.clipboard.writeText(json);
        } catch {
            console.log(
                "[Debug] line-number test result (clipboard write failed, falling back to console):",
                json,
            );
        }
    });

    dbgMenu.appendChild(testLineItem);
    dbgWrap.appendChild(dbgBtn);
    dbgWrap.appendChild(dbgMenu);

    const { close: closeDbgMenu } = wireHoverMenu(dbgWrap, dbgBtn, dbgMenu);

    return dbgWrap;
}
