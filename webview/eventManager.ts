/**
 * eventManager.ts
 * 
 * 职责：统一管理事件监听器的绑定和解绑
 * 
 * 本模块提供以下功能：
 * - 绑定 DOM 事件（Window、Document、HTMLElement），返回解绑函数
 * - 绑定自定义事件，支持 emit 触发
 * - 键盘快捷键绑定，支持组合键配置和行为控制
 * - 批量解绑所有事件（组件销毁时调用）
 * - 调试支持：追踪当前绑定的事件数量
 */

// ── 类型定义 ──────────────────────────────────────────────

type EventHandler<T = any> = (event: T) => void;

interface BoundEvent {
    target: EventTarget;
    type: string;
    handler: EventListenerOrEventListenerObject;
    options?: boolean | AddEventListenerOptions;
}

interface CustomEventEntry {
    handlers: Set<EventHandler>;
}

/** Keyboard shortcut configuration */
export interface ShortcutOptions {
    /**
     * Physical key code, e.g. "KeyF", "KeyM", "KeyK". Layout-independent;
     * use for Alt combos, where macOS remaps the produced character
     * (Option+K types "˚"). Ignored when `key` is set.
     */
    code?: string;
    /**
     * Produced character (KeyboardEvent.key), compared case-insensitively,
     * e.g. "f". Layout-aware — prefer this for letter shortcuts so
     * non-QWERTY layouts (Dvorak, QWERTZ, ...) match what the user typed,
     * the same way ProseMirror keymaps resolve letter bindings.
     */
    key?: string;
    /** Require the Meta/Cmd key */
    meta?: boolean;
    /** Require the Ctrl key */
    ctrl?: boolean;
    /** Require the Shift key */
    shift?: boolean;
    /** Require the Alt/Option key */
    alt?: boolean;
    /** Prevent the default action (default true) */
    preventDefault?: boolean;
    /** Stop the event from propagating further (default false) */
    stopPropagation?: boolean;
}

// ── 事件管理器实现 ────────────────────────────────────────

export class EventManager {
    private boundEvents: BoundEvent[] = [];
    private customEvents = new Map<string, CustomEventEntry>();
    private disposed = false;

    /**
     * 绑定 DOM 事件到 Window
     * @returns 解绑函数
     */
    onWindow<K extends keyof WindowEventMap>(
        type: K,
        handler: (ev: WindowEventMap[K]) => void,
        options?: boolean | AddEventListenerOptions,
    ): () => void {
        return this.bind(window, type, handler as EventListener, options);
    }

    /**
     * 绑定 DOM 事件到 Document
     * @returns 解绑函数
     */
    onDocument<K extends keyof DocumentEventMap>(
        type: K,
        handler: (ev: DocumentEventMap[K]) => void,
        options?: boolean | AddEventListenerOptions,
    ): () => void {
        return this.bind(document, type, handler as EventListener, options);
    }

    /**
     * 绑定 DOM 事件到指定元素
     * @returns 解绑函数
     */
    onElement<K extends keyof HTMLElementEventMap>(
        target: HTMLElement,
        type: K,
        handler: (ev: HTMLElementEventMap[K]) => void,
        options?: boolean | AddEventListenerOptions,
    ): () => void {
        return this.bind(target, type, handler as EventListener, options);
    }

    /**
     * 绑定自定义事件
     * @returns 解绑函数
     */
    onCustom<T = any>(
        type: string,
        handler: EventHandler<T>,
    ): () => void {
        this.ensureNotDisposed();

        let entry = this.customEvents.get(type);
        if (!entry) {
            entry = { handlers: new Set() };
            this.customEvents.set(type, entry);
        }
        entry.handlers.add(handler);

        return () => {
            entry.handlers.delete(handler);
            if (entry.handlers.size === 0) {
                this.customEvents.delete(type);
            }
        };
    }

    /**
     * Bind a keyboard shortcut.
     *
     * Modifier semantics: requesting both `meta` and `ctrl` means the
     * platform primary modifier ("Mod": Cmd on macOS, Ctrl elsewhere) —
     * either one matches. Otherwise each modifier must match exactly, so
     * e.g. Cmd+Shift+F does not trigger a plain Cmd+F shortcut.
     *
     * @param options - shortcut configuration
     * @param handler - event handler
     * @returns unbind function
     *
     * @example
     * // Cmd/Ctrl+F
     * eventManager.onShortcut(
     *     { code: "KeyF", meta: true, ctrl: true },
     *     () => openFindBar()
     * );
     *
     * @example
     * // Cmd/Ctrl+Shift+M
     * eventManager.onShortcut(
     *     { code: "KeyM", meta: true, ctrl: true, shift: true },
     *     () => switchToTextEditor()
     * );
     *
     * @example
     * // Alt+K (without stopping propagation)
     * eventManager.onShortcut(
     *     { code: "KeyK", alt: true, stopPropagation: false },
     *     () => sendToClaude()
     * );
     */
    onShortcut(
        options: ShortcutOptions,
        handler: (e: KeyboardEvent) => void,
    ): () => void {
        const {
            code,
            key,
            meta = false,
            ctrl = false,
            shift = false,
            alt = false,
            preventDefault = true,
            stopPropagation = false,
        } = options;
        const lowerKey = key?.toLowerCase();

        // Bind on `document`, NOT `window`. The VS Code webview host installs
        // its own bubble-phase keydown listener on `window` (before this
        // bundle runs) and forwards every key it sees to the workbench so
        // workbench keybindings keep working while a webview is focused.
        // Because that listener is registered first on the same node, a
        // window-level stopPropagation() of ours can never beat it. Listening
        // one node lower means our stopPropagation() (and the claimed-key
        // guard in keyboardShortcuts.ts, also on `document`) actually keeps
        // handled shortcuts from leaking to the workbench.
        return this.onDocument("keydown", (e) => {
            if (lowerKey !== undefined) {
                if (e.key.toLowerCase() !== lowerKey) { return; }
            } else if (e.code !== code) {
                return;
            }

            // Check modifiers ("Mod" when both meta and ctrl are requested)
            if (meta && ctrl) {
                if (!e.metaKey && !e.ctrlKey) { return; }
            } else if (meta !== e.metaKey || ctrl !== e.ctrlKey) {
                return;
            }
            if (shift !== e.shiftKey) { return; }
            if (alt !== e.altKey) { return; }

            // Suppress default behavior and propagation
            if (preventDefault) { e.preventDefault(); }
            if (stopPropagation) { e.stopPropagation(); }

            handler(e);
        });
    }

    /**
     * 触发自定义事件
     */
    emit<T = any>(type: string, detail?: T): void {
        this.ensureNotDisposed();

        const entry = this.customEvents.get(type);
        if (entry) {
            for (const handler of entry.handlers) {
                try {
                    handler(detail);
                } catch (e) {
                    console.error(`[EventManager] Error in custom event handler for "${type}":`, e);
                }
            }
        }
    }

    /**
     * 批量解绑所有事件（用于组件销毁）
     */
    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;

        // 解绑 DOM 事件
        for (const { target, type, handler, options } of this.boundEvents) {
            try {
                target.removeEventListener(type, handler, options);
            } catch {
                // 忽略已移除的元素
            }
        }
        this.boundEvents = [];

        // 清空自定义事件
        this.customEvents.clear();
    }

    /**
     * 获取当前绑定的事件数量（调试用）
     */
    get stats(): { domEvents: number; customEvents: number } {
        return {
            domEvents: this.boundEvents.length,
            customEvents: Array.from(this.customEvents.values())
                .reduce((sum, entry) => sum + entry.handlers.size, 0),
        };
    }

    // ── 内部方法 ──────────────────────────────────────────

    private bind(
        target: EventTarget,
        type: string,
        handler: EventListener,
        options?: boolean | AddEventListenerOptions,
    ): () => void {
        this.ensureNotDisposed();

        target.addEventListener(type, handler, options);
        this.boundEvents.push({ target, type, handler, options });

        return () => {
            target.removeEventListener(type, handler, options);
            const idx = this.boundEvents.findIndex(
                e => e.target === target && e.type === type && e.handler === handler,
            );
            if (idx !== -1) {
                this.boundEvents.splice(idx, 1);
            }
        };
    }

    private ensureNotDisposed(): void {
        if (this.disposed) {
            throw new Error("[EventManager] Instance has been disposed");
        }
    }
}

// ── 便捷工厂函数 ──────────────────────────────────────────

/**
 * 创建一个新的事件管理器实例
 */
export function createEventManager(): EventManager {
    return new EventManager();
}
