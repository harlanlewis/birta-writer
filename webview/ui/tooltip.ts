let tooltipEl: HTMLElement | null = null;

function getTooltip(): HTMLElement {
    if (!tooltipEl) {
        tooltipEl = document.createElement("div");
        tooltipEl.className = "custom-tooltip";
        document.body.appendChild(tooltipEl);
    }
    return tooltipEl;
}

interface TooltipOptions {
    /** Placement: 'below' (default, used by the toolbar) or 'above' */
    placement?: "above" | "below";
    /** Only show when the text is truncated (an ellipsis appears) */
    truncatedOnly?: boolean;
}

interface TooltipHandle {
    /** Dynamically update the tooltip text (without affecting visibility) */
    setText(t: string): void;
    /** Show the tooltip programmatically (e.g. for post-click feedback) */
    show(): void;
}

function position(
    tip: HTMLElement,
    el: HTMLElement,
    placement: "above" | "below",
): void {
    tip.style.visibility = "hidden";
    tip.style.display = "block";

    const elRect = el.getBoundingClientRect();
    const tipRect = tip.getBoundingClientRect();

    let x = elRect.left + elRect.width / 2 - tipRect.width / 2;
    let y: number;

    if (placement === "above") {
        y = elRect.top - tipRect.height - 6;
        if (y < 4) {
            y = elRect.bottom + 6;
        } // not enough room above, so drop below
    } else {
        y = elRect.bottom + 6;
        if (y + tipRect.height > window.innerHeight - 4) {
            y = elRect.top - tipRect.height - 6;
        }
    }

    if (x + tipRect.width > window.innerWidth - 4) {
        x = window.innerWidth - tipRect.width - 4;
    }
    if (x < 4) {
        x = 4;
    }

    tip.style.left = `${x}px`;
    tip.style.top = `${y}px`;
    tip.style.visibility = "visible";
}

/** Immediately hide the currently visible tooltip (e.g. to clear it after a click interaction) */
export function hideTooltip(): void {
    if (tooltipEl) {
        tooltipEl.style.display = "none";
    }
}

/** Imperative: show a tooltip next to the given element right away, no event binding needed */
export function showTooltipAt(
    el: Element,
    text: string,
    placement: "above" | "below" = "above",
): void {
    const tip = getTooltip();
    tip.textContent = text;
    position(tip, el as HTMLElement, placement);
}

/** Replace the native title with a VSCode-style custom tooltip */
export function applyTooltip(
    el: HTMLElement,
    text: string,
    options: TooltipOptions = {},
): TooltipHandle {
    const { placement = "below", truncatedOnly = false } = options;
    let currentText = text;

    el.removeAttribute("title");

    el.addEventListener("mouseenter", () => {
        if (!currentText) {
            return;
        }
        if (truncatedOnly && el.scrollWidth <= el.offsetWidth) {
            return;
        }
        const tip = getTooltip();
        tip.textContent = currentText;
        position(tip, el, placement);
    });

    el.addEventListener("mouseleave", () => {
        if (tooltipEl) {
            tooltipEl.style.display = "none";
        }
    });

    return {
        setText(t: string) {
            currentText = t;
        },
        show() {
            if (!currentText) {
                return;
            }
            const tip = getTooltip();
            tip.textContent = currentText;
            position(tip, el, placement);
        },
    };
}
