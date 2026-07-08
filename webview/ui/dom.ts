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
    ariaLabel?: string;
    tabIndex?: number;
    tooltipPlacement?: 'above' | 'below';
    onClick?: () => void;
}): HTMLButtonElement {
    const btn = document.createElement('button');
    btn.className = options.className;
    if (options.tabIndex !== undefined) btn.tabIndex = options.tabIndex;
    if (options.icon) btn.innerHTML = options.icon;
    if (options.label) btn.textContent = options.label;

    // Accessible name: an explicit ariaLabel wins; otherwise icon-only
    // buttons take the tooltip title minus any trailing "(⌘K)"-style
    // shortcut hint (a visible label already names the button).
    const ariaLabel = options.ariaLabel ??
        (!options.label && options.title
            ? options.title.replace(/\s*\([^()]*\)\s*$/, '')
            : undefined);
    if (ariaLabel) btn.setAttribute('aria-label', ariaLabel);

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
        // Enter/Space synthesize a click with detail 0 and never fire
        // mousedown, so without this branch the button is keyboard-dead.
        // Real mouse clicks (detail ≥ 1) were already handled above.
        btn.addEventListener('click', (e) => {
            if (e.detail === 0) {
                e.preventDefault();
                e.stopPropagation();
                handler();
            }
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
 * The house inline-editing semantics for an always-present input: Enter and
 * blur apply the edit, Escape reverts it, and there is no confirm button.
 * (The link popup, callout titles, and the image caption/title all behave
 * this way — see "save on blur" in samples/content-inventory.md.)
 *
 * `commit` must be a no-op when the value is unchanged: Enter/Escape blur the
 * input, which fires the blur commit a second time. Only Enter/Escape are
 * intercepted — other keys bubble so the VS Code webview's native clipboard
 * handling keeps working.
 */
export function setupApplyOnBlur(
    input: HTMLInputElement,
    opts: {
        /** Apply the current input value (idempotent for unchanged values). */
        commit: () => void;
        /** Restore the input to the last applied value. */
        revert: () => void;
        /** Called after Enter/Escape close the edit (e.g. refocus the editor). */
        onClose?: () => void;
    },
): void {
    input.addEventListener('keydown', (e) => {
        if (e.isComposing) return;
        if (e.key === 'Enter') {
            e.stopPropagation();
            e.preventDefault();
            opts.commit();
            input.blur();
            opts.onClose?.();
        } else if (e.key === 'Escape') {
            e.stopPropagation();
            e.preventDefault();
            opts.revert();
            input.blur();
            opts.onClose?.();
        }
    });
    input.addEventListener('blur', () => opts.commit());
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
