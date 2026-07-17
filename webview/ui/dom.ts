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
 * The house inline-editing semantics for an always-present input: Enter and
 * blur apply the edit, Escape reverts it, and there is no confirm button
 * (see "save on blur" in samples/content-inventory.md).
 *
 * Consumers: the image caption and title inputs (components/imageView). The
 * two other save-on-blur surfaces follow the same UX but deliberately
 * hand-roll variants this helper cannot express:
 * - the link popup (components/linkPopup) commits on blur only when focus
 *   leaves the whole popup (moves between its two fields are not a save
 *   point), and its Escape closes the popup discarding uncommitted typing
 *   rather than reverting the input in place;
 * - the callout title (components/callout) edits a contenteditable span, not
 *   an <input>, relies on blur-THEN-commit ordering so the NodeView's render
 *   re-syncs the normalized (trimmed) title once focus has left, and lets
 *   Enter/Escape bubble less aggressively (no stopPropagation).
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

