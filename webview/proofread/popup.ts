/**
 * Findings popup: click any flagged span (spelling, grammar, or style) to see
 * why it's flagged and what you can do about it. When several findings overlap
 * the same click — a filler word inside a long sentence, say — the popup stacks
 * them, one section each, most-specific first.
 *
 * This module is a dumb renderer: every action is a closure the caller
 * (plugins/proofread.ts) builds with the editor view and document positions in
 * hand, so the popup itself imports neither the engine nor the plugin.
 */
import type { EditorView } from "@milkdown/prose/view";
import { closeTopmostLayer, registerEscapeLayer } from "../ui/escapeLayers";
import { computeAnchoredPosition, viewportSize } from "../ui/anchoredPlacement";
import { onOutsideClick } from "../ui/outsideClick";
import "./proofread.css";

/** One button inside a finding section. */
export type PopupButton = {
    label: string;
    /** Dismiss actions (Ignore / Add to dictionary) render quieter, below a rule. */
    dismiss?: boolean;
    run: () => void | Promise<void>;
};

/** One finding, rendered as a labelled message plus its own action buttons. */
export type PopupFinding = {
    /** Short category chip, e.g. "Filler", "Spelling", "Long sentence". */
    tag: string;
    /** Full explanation, e.g. "This sentence is 44 words long." */
    message: string;
    buttons: PopupButton[];
};

let activePopup: HTMLElement | null = null;
let cleanup: (() => void) | null = null;

export function hideLintPopup(): void {
    cleanup?.();
    cleanup = null;
    activePopup?.remove();
    activePopup = null;
}

function renderFinding(view: EditorView, finding: PopupFinding): HTMLElement {
    const group = document.createElement("div");
    group.className = "pf-popup-group";

    const message = document.createElement("div");
    message.className = "pf-popup-message";
    const tag = document.createElement("span");
    tag.className = "pf-popup-tag";
    tag.textContent = finding.tag;
    message.appendChild(tag);
    message.appendChild(document.createTextNode(finding.message));
    group.appendChild(message);

    for (const button of finding.buttons) {
        const item = document.createElement("button");
        item.type = "button";
        item.className = "pf-popup-item" + (button.dismiss ? " pf-popup-ignore" : "");
        item.textContent = button.label;
        item.addEventListener("click", async () => {
            await button.run();
            hideLintPopup();
            view.focus();
        });
        group.appendChild(item);
    }
    return group;
}

/**
 * Show the popup for one or more findings, anchored under `anchorPos`. The
 * caller passes findings ordered most-specific-first; an empty list is a no-op.
 */
export function showFindingsPopup(view: EditorView, anchorPos: number, findings: PopupFinding[]): void {
    hideLintPopup();
    if (findings.length === 0) { return; }

    const popup = document.createElement("div");
    popup.className = "pf-popup";
    for (const finding of findings) {
        popup.appendChild(renderFinding(view, finding));
    }

    document.body.appendChild(popup);
    activePopup = popup;

    // Position below the anchor, clamped to the viewport; flip above on
    // overflow (even into less room — the top clamp keeps it on screen).
    const coords = view.coordsAtPos(anchorPos);
    const rect = popup.getBoundingClientRect();
    const placed = computeAnchoredPosition(
        coords,
        { width: rect.width, height: rect.height },
        viewportSize(),
        { gap: 4, fitSlack: 4, flipPolicy: "overflow" },
    );
    popup.style.left = `${placed.left}px`;
    popup.style.top = `${Math.max(8, placed.top)}px`;

    const onKeyDown = (e: KeyboardEvent) => {
        // Only a bare Escape closes a layer; modifier-Escape (Shift+Esc pops
        // the escape-layer stack, etc.) must fall through untouched — no
        // surface acts on modifier-Escape (matches blockKeys' guard).
        if (e.key === "Escape" && !e.metaKey && !e.ctrlKey && !e.altKey && !e.shiftKey) {
            // Consume (the old bare hide let the key fall through to the
            // block-selection keymap, closing the popup AND selecting the
            // block) and route through the Escape-layer stack, so a surface
            // opened after this popup — the find bar, say — closes first
            // and the popup takes the next Escape. The registry can't be
            // empty while this capture handler is alive, but keep the
            // direct hide as a belt-and-braces fallback.
            e.preventDefault();
            e.stopPropagation();
            if (!closeTopmostLayer()) { hideLintPopup(); }
        }
    };
    const escapeLayerOff = registerEscapeLayer(hideLintPopup);
    const outsideOff = onOutsideClick([popup], () => hideLintPopup());
    document.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("scroll", hideLintPopup, true);
    cleanup = () => {
        escapeLayerOff();
        outsideOff();
        document.removeEventListener("keydown", onKeyDown, true);
        window.removeEventListener("scroll", hideLintPopup, true);
    };
}
