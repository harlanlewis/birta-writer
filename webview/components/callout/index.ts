/**
 * Callout NodeView (MAR-27) — the visual chrome for `callout` nodes
 * (plugins/callouts.ts): kind icon + accent color, an editable title, a
 * collapsed-state ellipsis, and a keyboard-accessible kind-picker menu.
 *
 * Invariants:
 *   - Folding is VISUAL ONLY. Fold state is OWNED by the fold plugin
 *     (plugins/headingFold, MAR-110): the chevron lives in the block's
 *     gutter, the `collapsed` class arrives as a node decoration, and this
 *     view only renders the `…` ellipsis and dispatches the shared fold
 *     meta. The document (and the `[!type]-` marker) is never touched by
 *     collapsing/expanding, so reading a file can never dirty it. (The one
 *     deliberate marker write is the block menu's "Collapsed by default"
 *     row — a real document edit, like changing the kind.)
 *   - Changing the kind or title IS a document edit: the marker attr is
 *     re-synthesized (markerWithKind / markerWithTitle — case, fold, and
 *     raw bytes preserved where untouched) and dispatched as one
 *     setNodeMarkup transaction.
 *   - The title editor writes back through escapeCalloutTitle, so a typed
 *     `*x*` can never silently downgrade the callout to a blockquote on the
 *     next load (formatted marker lines are deliberately not callouts).
 */
import "./callout.css";
import type { Node as PMNode } from "@/pm";
import type { EditorView } from "@/pm";
import { t } from "@/i18n";
import { registerEscapeLayer } from "@/ui/escapeLayers";
import { onOutsideClick } from "@/ui/outsideClick";
import {
    CALLOUT_KINDS,
    attrsFromMarker,
    markerWithKind,
    markerWithTitle,
    type CalloutKind,
} from "@/plugins/callouts";
import { createFoldEllipsis } from "@/ui/foldEllipsis";
import { foldPluginKey, type FoldMeta } from "@/plugins/foldState";
import {
    IconAlertTriangle,
    IconBug,
    IconCheck,
    IconCheckCircle,
    IconClipboardList,
    IconHelpCircle,
    IconInfo,
    IconLightbulb,
    IconList,
    IconMessageAlert,
    IconOctagonAlert,
    IconPencil,
    IconQuote,
    IconX,
    IconZap,
} from "@/ui/icons";

/** Kind → icon SVG markup. Every canonical kind has an entry. */
export const CALLOUT_ICONS: Record<CalloutKind, string> = {
    note: IconPencil,
    tip: IconLightbulb,
    important: IconMessageAlert,
    warning: IconAlertTriangle,
    caution: IconOctagonAlert,
    abstract: IconClipboardList,
    info: IconInfo,
    todo: IconCheckCircle,
    success: IconCheck,
    question: IconHelpCircle,
    failure: IconX,
    danger: IconZap,
    bug: IconBug,
    example: IconList,
    quote: IconQuote,
};

/**
 * The title bar's display text: the explicit title when present, else the
 * raw type capitalized (`[!note]` → "Note"), preserving an all-caps type as
 * typed. Editing this text sets an explicit title; clearing it falls back.
 */
export function calloutLabel(node: PMNode): string {
    const title = (node.attrs["title"] as string) ?? "";
    if (title !== "") return title;
    const rawType = (node.attrs["rawType"] as string) ?? "Note";
    if (rawType === rawType.toUpperCase()) {
        return rawType.charAt(0) + rawType.slice(1).toLowerCase();
    }
    return rawType.charAt(0).toUpperCase() + rawType.slice(1);
}

interface CalloutView {
    dom: HTMLElement;
    contentDOM: HTMLElement;
    update(node: PMNode): boolean;
    stopEvent(event: Event): boolean;
    ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }): boolean;
    destroy(): void;
}

/**
 * Notion-aside callout NodeView (plugins/notionCallouts.ts) — much lighter
 * than the marker-callout view: Notion callouts have no kind marker, title,
 * or fold, so the chrome is just the emoji icon beside an editable body.
 * The emoji is document content (it serializes back as the line prefix), so
 * it renders read-only here; the kind accent comes from the emoji mapping.
 */
export function createNotionCalloutView(initialNode: PMNode): {
    dom: HTMLElement;
    contentDOM: HTMLElement;
    update(node: PMNode): boolean;
    ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }): boolean;
} {
    let node = initialNode;

    const dom = document.createElement("div");
    dom.className = "callout callout-aside";
    dom.dataset["type"] = "notion-callout";

    const iconSpan = document.createElement("span");
    iconSpan.className = "callout-aside-icon";
    iconSpan.contentEditable = "false";
    iconSpan.setAttribute("aria-hidden", "true");

    const content = document.createElement("div");
    content.className = "callout-body callout-aside-body";

    dom.append(iconSpan, content);

    const render = (): void => {
        dom.dataset["kind"] = (node.attrs["kind"] as string) ?? "note";
        const icon = (node.attrs["icon"] as string) ?? "";
        iconSpan.textContent = icon;
        iconSpan.style.display = icon === "" ? "none" : "";
    };
    render();

    return {
        dom,
        contentDOM: content,
        update(updated: PMNode): boolean {
            if (updated.type !== node.type) return false;
            node = updated;
            render();
            return true;
        },
        ignoreMutation(mutation): boolean {
            if (mutation.type === "selection") return false;
            return !content.contains(mutation.target as Node) && mutation.target !== content;
        },
    };
}

export function createCalloutView(
    initialNode: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
): CalloutView {
    let node = initialNode;

    const dom = document.createElement("div");
    dom.className = "callout";
    dom.dataset["type"] = "callout";

    const titleBar = document.createElement("div");
    titleBar.className = "callout-title";
    titleBar.contentEditable = "false";

    // ── Kind button: the icon itself, click/Enter/Space → kind menu ─────────
    const kindButton = document.createElement("button");
    kindButton.type = "button";
    kindButton.className = "callout-kind";
    kindButton.title = t("Change callout type");
    kindButton.setAttribute("aria-label", t("Change callout type"));
    kindButton.setAttribute("aria-haspopup", "menu");
    kindButton.setAttribute("aria-expanded", "false");

    // ── Title: an inline plain-text editor committing to the marker attr ────
    const titleSpan = document.createElement("span");
    titleSpan.className = "callout-title-text";
    titleSpan.setAttribute("role", "textbox");
    titleSpan.setAttribute("aria-label", t("Callout title"));
    titleSpan.spellcheck = false;
    try {
        // Chromium/Electron; jsdom throws on unknown values.
        titleSpan.contentEditable = "plaintext-only";
    } catch {
        titleSpan.contentEditable = "true";
    }

    // ── Collapsed `…` (MAR-110): the NodeView mount of the shared fold
    //    ellipsis. Visible only while the host carries the `collapsed`
    //    class (a node decoration from the fold plugin); clicking expands
    //    by dispatching the shared fold meta — zero steps, no history.
    const ellipsis = createFoldEllipsis(initialNode.childCount, () => {
        const pos = getPos();
        if (pos === undefined) return;
        view.dispatch(
            view.state.tr
                .setMeta(foldPluginKey, { type: "set", pos, folded: false } satisfies FoldMeta)
                .setMeta("addToHistory", false),
        );
        view.focus();
    });
    ellipsis.dom.classList.add("callout-fold-ellipsis");

    titleBar.append(kindButton, titleSpan, ellipsis.dom);

    const content = document.createElement("div");
    content.className = "callout-body";

    dom.append(titleBar, content);

    const dispatchMarker = (marker: string): void => {
        const pos = getPos();
        if (pos === undefined) return;
        view.dispatch(
            view.state.tr.setNodeMarkup(
                pos,
                null,
                attrsFromMarker(marker, node.attrs["attached"] as boolean),
            ),
        );
    };

    // ── Kind picker menu ────────────────────────────────────────────────────
    let menu: HTMLElement | null = null;
    /** Escape-layer unregister handle (null while the menu is closed). */
    let escapeLayerOff: (() => void) | null = null;
    /** Outside-click detach handle (null while the menu is closed). */
    let outsideOff: (() => void) | null = null;
    const closeMenu = (refocus = false): void => {
        if (!menu) return;
        escapeLayerOff?.();
        escapeLayerOff = null;
        menu.remove();
        menu = null;
        kindButton.setAttribute("aria-expanded", "false");
        outsideOff?.();
        outsideOff = null;
        if (refocus) kindButton.focus();
    };
    const menuItems = (): HTMLButtonElement[] =>
        menu ? Array.from(menu.querySelectorAll("button")) : [];
    const openMenu = (): void => {
        if (menu) {
            closeMenu();
            return;
        }
        menu = document.createElement("div");
        menu.className = "callout-menu";
        menu.setAttribute("role", "menu");
        for (const kind of CALLOUT_KINDS) {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "callout-menu-item";
            item.dataset["kind"] = kind;
            item.setAttribute("role", "menuitem");
            item.innerHTML = CALLOUT_ICONS[kind];
            const name = document.createElement("span");
            name.textContent = kind.charAt(0).toUpperCase() + kind.slice(1);
            item.appendChild(name);
            if (kind === (node.attrs["kind"] as string)) {
                item.classList.add("active");
            }
            item.addEventListener("mousedown", (e) => e.preventDefault());
            item.addEventListener("click", () => {
                closeMenu(true);
                dispatchMarker(markerWithKind((node.attrs["marker"] as string) ?? "[!NOTE]", kind));
            });
            menu.appendChild(item);
        }
        menu.addEventListener("keydown", (e) => {
            const items = menuItems();
            const at = items.indexOf(document.activeElement as HTMLButtonElement);
            if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                e.preventDefault();
                const delta = e.key === "ArrowDown" ? 1 : -1;
                items[(at + delta + items.length) % items.length]?.focus();
            } else if (e.key === "Escape") {
                e.preventDefault();
                e.stopPropagation();
                closeMenu(true);
            }
        });
        titleBar.appendChild(menu);
        // Escape layer: the focused menu's own keydown wins first; this
        // covers an editor-focused Escape while the menu is open.
        escapeLayerOff = registerEscapeLayer(() => closeMenu());
        // The kindButton exclusion is by target IDENTITY (not contains),
        // matching the original handler: a mousedown on the button element
        // itself defers to its click toggle instead of dismissing here.
        outsideOff = onOutsideClick([menu], (e) => {
            if (e.target !== kindButton) closeMenu();
        });
        kindButton.setAttribute("aria-expanded", "true");
        (menu.querySelector(".active") as HTMLButtonElement | null ?? menuItems()[0])?.focus();
    };
    kindButton.addEventListener("mousedown", (e) => e.preventDefault());
    kindButton.addEventListener("click", () => openMenu());
    kindButton.addEventListener("keydown", (e) => {
        if (e.key === "ArrowDown" && !menu) {
            e.preventDefault();
            openMenu();
        }
    });

    // ── Title editing ────────────────────────────────────────────────────────
    const commitTitle = (): void => {
        const typed = (titleSpan.textContent ?? "").trim();
        if (typed === calloutLabel(node)) return; // untouched → zero churn
        dispatchMarker(markerWithTitle((node.attrs["marker"] as string) ?? "[!NOTE]", typed));
    };
    titleSpan.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            titleSpan.blur(); // blur commits
        } else if (e.key === "Escape") {
            e.preventDefault();
            titleSpan.textContent = calloutLabel(node); // revert, then leave
            titleSpan.blur();
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
            // Keep select-all inside the title island — the native behavior
            // escapes into the surrounding contenteditable and selects the
            // whole document.
            e.preventDefault();
            const range = document.createRange();
            range.selectNodeContents(titleSpan);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
        }
    });
    titleSpan.addEventListener("blur", commitTitle);

    const render = (): void => {
        const kind = (node.attrs["kind"] as CalloutKind) ?? "note";
        dom.dataset["kind"] = kind;
        kindButton.innerHTML = CALLOUT_ICONS[kind] ?? IconPencil;
        // Never clobber the text mid-edit; commit/Escape settle it on blur.
        if (document.activeElement !== titleSpan) {
            titleSpan.textContent = calloutLabel(node);
        }
        titleSpan.classList.toggle(
            "placeholder",
            ((node.attrs["title"] as string) ?? "") === "",
        );
        ellipsis.setCount(node.childCount);
    };
    render();

    return {
        dom,
        contentDOM: content,
        update(updated: PMNode): boolean {
            if (updated.type !== node.type) return false;
            node = updated;
            render();
            return true;
        },
        stopEvent(event: Event): boolean {
            // Chrome interactions (title typing, menu keys, buttons) never
            // reach ProseMirror's keymaps/selection handling.
            return titleBar.contains(event.target as Node);
        },
        ignoreMutation(mutation): boolean {
            if (mutation.type === "selection") return false;
            return !content.contains(mutation.target as Node) && mutation.target !== content;
        },
        destroy(): void {
            closeMenu();
        },
    };
}
