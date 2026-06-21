/**
 * scrollPersistence.ts
 * 
 * 职责：实现滚动位置的跨会话持久化
 * 
 * 本模块提供以下功能：
 * - 监听滚动事件，防抖保存滚动位置到 VSCode WebView 状态
 * - 在 tab 切换（visibilitychange）时恢复滚动位置
 * - 支持 VSCode 重启后恢复标签页的滚动位置
 */

import { getWebviewState, setWebviewState } from "./messaging";
import type { EventManager } from "./eventManager";

// ── 滚动位置持久化 ────────────────────────────────────────────
// 保存：滚动时防抖写入 VSCode WebView 状态（跨会话可恢复）
let _scrollSaveTimer: ReturnType<typeof setTimeout> | null = null;

/** 初始化滚动位置持久化 */
export function initScrollPersistence(eventManager: EventManager): void {
    eventManager.onWindow("scroll", () => {
        if (_scrollSaveTimer) clearTimeout(_scrollSaveTimer);
        _scrollSaveTimer = setTimeout(() => {
            const cur = getWebviewState() ?? {};
            setWebviewState({ ...cur, scrollY: window.scrollY });
        }, 200);
    }, { passive: true });

    // 恢复（主路径）：tab 切换时 iframe 被隐藏再显示，浏览器会重置 scrollY
    // visibilitychange 触发时读取已保存位置并还原
    eventManager.onDocument("visibilitychange", () => {
        if (document.visibilityState !== 'visible') return;
        const state = getWebviewState();
        if (state?.scrollY !== undefined) {
            requestAnimationFrame(() => {
                window.scrollTo({ top: state.scrollY as number });
            });
        }
    });
}
