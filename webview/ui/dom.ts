import { applyTooltip } from '@/ui/tooltip';

/**
 * Generic button factory.
 * onClick is automatically wrapped with e.preventDefault() + e.stopPropagation().
 */
export function createButton(options: {
    className: string;
    icon?: string;
    label?: string;
    title?: string;
    tabIndex?: number;
    tooltipPlacement?: 'above' | 'below';
    onClick?: () => void;
}): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = options.className;
    if (options.tabIndex !== undefined) btn.tabIndex = options.tabIndex;
    if (options.icon) btn.innerHTML = options.icon;
    if (options.label) btn.textContent = options.label;

    const tipText = options.title ?? options.label;
    if (tipText) {
        applyTooltip(btn, tipText, { placement: options.tooltipPlacement ?? 'below' });
    }

    if (options.onClick) {
        const handler = options.onClick;
        btn.addEventListener('mousedown', (e) => {
            e.preventDefault();
            e.stopPropagation();
            handler();
        });
    }

    return btn;
}

/**
 * Generic separator factory.
 * Replaces the per-component sep() / sSep() / makeSep() helpers.
 */
export function createSeparator(className: string, tag: 'div' | 'span' = 'div'): HTMLElement {
    const el = document.createElement(tag);
    el.className = className;
    return el;
}

/**
 * Bind Enter/Escape keyboard handling to an input.
 * Automatically handles isComposing, stopPropagation, and preventDefault.
 */
export function setupInputKeyboard(
    input: HTMLInputElement,
    onEnter: () => void,
    onEscape: () => void,
): void {
    input.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        e.stopPropagation();
        if (e.key === 'Enter') {
            e.preventDefault();
            onEnter();
        } else if (e.key === 'Escape') {
            e.preventDefault();
            onEscape();
        }
    });
}

/**
 * Listen for outside mousedown events to close a popup.
 * Returns a function that removes the listener, for manual cleanup.
 * @param targets clicking inside these elements does not trigger close
 * @param onClose close callback
 * @param delayMs delay before registering (default 0), to avoid the current event firing it immediately
 */
export function onOutsideMousedown(
    targets: HTMLElement[],
    onClose: () => void,
    delayMs = 0,
): () => void {
    function handler(e: MouseEvent) {
        const target = e.target as Node;
        if (targets.some((el) => el.contains(target))) return;
        onClose();
        document.removeEventListener('mousedown', handler);
    }

    if (delayMs > 0) {
        setTimeout(() => document.addEventListener('mousedown', handler), delayMs);
    } else {
        document.addEventListener('mousedown', handler);
    }

    return () => document.removeEventListener('mousedown', handler);
}
