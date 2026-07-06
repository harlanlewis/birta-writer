/**
 * eventManager.ts
 *
 * Responsibility: a single place to manage binding and unbinding of event listeners.
 *
 * This module provides:
 * - Bind DOM events (Window, Document, HTMLElement), returning an unbind function
 * - Bind custom events, triggerable via emit
 * - Unbind all events at once (called on component teardown)
 * - Debug support: track the current number of bound events
 *
 * There is deliberately NO keyboard-shortcut helper here anymore: editor
 * shortcuts are contributed (user-rebindable) VS Code keybindings routed
 * through commands (see shared/editorCommands.ts), and the guard test
 * shared/__tests__/noHardcodedKeybindings.test.ts fails the suite when a
 * webview module starts matching modifier chords by hand.
 */

// ── Type definitions ──────────────────────────────────────

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

/**
 * Layout fallback mirroring prosemirror-keymap's keyCode path: when the
 * produced character cannot name a "Mod-z"-style letter binding — a non-ASCII
 * char from a non-Latin layout (Russian Ctrl+Z produces "я") or a named key
 * like "Dead" — prosemirror-keymap additionally resolves the binding via
 * `base[event.keyCode]` (w3c-keyname), where keyCodes 65-90 map to "a"-"z".
 * Letter matchers must apply the same fallback or those layouts miss/leak.
 *
 * Returns the fallback letter, or null when `e.key` is a plain ASCII char
 * (no fallback is attempted then, matching prosemirror-keymap: e.g. Dvorak
 * Cmd+X produces "x" and must match as "x", not as its physical key).
 */
export function fallbackKeyFromKeyCode(e: KeyboardEvent): string | null {
    const nonAsciiChar = e.key.length === 1 && e.key.charCodeAt(0) > 127;
    const namedKey = e.key.length > 1;
    if (!nonAsciiChar && !namedKey) { return null; }
    return e.keyCode >= 65 && e.keyCode <= 90
        ? String.fromCharCode(e.keyCode).toLowerCase()
        : null;
}

// ── EventManager implementation ───────────────────────────

export class EventManager {
    private boundEvents: BoundEvent[] = [];
    private customEvents = new Map<string, CustomEventEntry>();
    private disposed = false;

    /**
     * Bind a DOM event on Window
     * @returns unbind function
     */
    onWindow<K extends keyof WindowEventMap>(
        type: K,
        handler: (ev: WindowEventMap[K]) => void,
        options?: boolean | AddEventListenerOptions,
    ): () => void {
        return this.bind(window, type, handler as EventListener, options);
    }

    /**
     * Bind a DOM event on Document
     * @returns unbind function
     */
    onDocument<K extends keyof DocumentEventMap>(
        type: K,
        handler: (ev: DocumentEventMap[K]) => void,
        options?: boolean | AddEventListenerOptions,
    ): () => void {
        return this.bind(document, type, handler as EventListener, options);
    }

    /**
     * Bind a DOM event on a specific element
     * @returns unbind function
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
     * Bind a custom event
     * @returns unbind function
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
     * Trigger a custom event
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
     * Unbind all events at once (used on component teardown)
     */
    dispose(): void {
        if (this.disposed) { return; }
        this.disposed = true;

        // Unbind DOM events
        for (const { target, type, handler, options } of this.boundEvents) {
            try {
                target.removeEventListener(type, handler, options);
            } catch {
                // Ignore already-removed elements
            }
        }
        this.boundEvents = [];

        // Clear custom events
        this.customEvents.clear();
    }

    /**
     * Get the current number of bound events (for debugging)
     */
    get stats(): { domEvents: number; customEvents: number } {
        return {
            domEvents: this.boundEvents.length,
            customEvents: Array.from(this.customEvents.values())
                .reduce((sum, entry) => sum + entry.handlers.size, 0),
        };
    }

    // ── Internal methods ──────────────────────────────────

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

// ── Convenience factory function ──────────────────────────

/**
 * Create a new EventManager instance
 */
export function createEventManager(): EventManager {
    return new EventManager();
}
