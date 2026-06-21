/**
 * headingUtils.ts
 * 
 * 职责：提供标题（heading）相关的公共工具函数
 * 
 * 本模块抽取了 headingSticky 和 TOC 共用的滚动检测逻辑：
 * - 获取可见的 heading 元素
 * - 获取顶部工具栏位置
 * - 检测当前可见的 heading
 * - 查找 heading 对应的文档位置
 */

import type { EditorView } from "@milkdown/prose/view";

const HEADING_SELECTOR = "h1,h2,h3,h4,h5,h6";

/** 获取顶部工具栏底部位置 */
export function getTopbarBottom(): number {
    return document.querySelector(".editor-topbar")?.getBoundingClientRect().bottom ?? 40;
}

/** 获取所有可见的 heading 元素（排除折叠隐藏的） */
export function getVisibleHeadings(view: EditorView): HTMLElement[] {
    return Array.from(view.dom.querySelectorAll<HTMLElement>(HEADING_SELECTOR)).filter((heading) => {
        const rect = heading.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0 && !heading.classList.contains("heading-fold-hidden");
    });
}

/** 获取所有 heading 元素（不排除折叠隐藏的） */
export function getAllHeadings(view: EditorView): HTMLElement[] {
    return Array.from(view.dom.querySelectorAll<HTMLElement>(HEADING_SELECTOR));
}

/** 查找 heading 元素对应的文档位置 */
export function findHeadingPos(view: EditorView, heading: HTMLElement): number | null {
    let result: number | null = null;
    view.state.doc.descendants((node, pos) => {
        if (node.type.name === "heading" && view.nodeDOM(pos) === heading) {
            result = pos;
            return false;
        }
        return true;
    });
    return result;
}

/** 获取 heading 的文本内容（去除折叠按钮等内部元素） */
export function getHeadingText(heading: HTMLElement): string {
    const clone = heading.cloneNode(true) as HTMLElement;
    clone.querySelectorAll(".heading-fold-gutter").forEach((node) => node.remove());
    return clone.textContent?.trim() ?? "";
}

/** 获取 heading 的层级 */
export function getHeadingLevel(heading: HTMLElement): number {
    const level = Number(heading.tagName.slice(1));
    return Number.isFinite(level) ? level : 1;
}

/**
 * 检测当前可见的 active heading
 * @param view - EditorView
 * @param threshold - 判断阈值位置（通常是 topbarBottom + offset）
 * @param excludeCollapsed - 是否排除折叠隐藏的 heading（headingSticky 需要，TOC 不需要）
 * @returns active heading 信息，如果没有则返回 null
 */
export function findActiveHeading(
    view: EditorView,
    threshold: number,
    excludeCollapsed: boolean = true,
): { element: HTMLElement; pos: number } | null {
    const headings = excludeCollapsed ? getVisibleHeadings(view) : getAllHeadings(view);
    let activeHeading: HTMLElement | null = null;
    let activePos: number | null = null;

    for (const heading of headings) {
        const rect = heading.getBoundingClientRect();
        if (rect.width === 0 || rect.height === 0) {
            continue;
        }
        if (rect.top <= threshold) {
            const pos = findHeadingPos(view, heading);
            if (pos !== null) {
                activeHeading = heading;
                activePos = pos;
            }
        } else {
            break;
        }
    }

    if (activeHeading && activePos !== null) {
        return { element: activeHeading, pos: activePos };
    }
    return null;
}
