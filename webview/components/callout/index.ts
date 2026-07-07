/**
 * Callout NodeView (MAR-27) — the visual chrome for `callout` nodes
 * (plugins/callouts.ts): kind icon + accent color, title bar, optional
 * fold chevron, and a kind-picker dropdown.
 *
 * Two invariants:
 *   - Folding is VISUAL ONLY. Collapsing/expanding toggles a class; the
 *     document (and the `[!type]-` marker) is never touched, so reading a
 *     file can never dirty it.
 *   - Changing the kind IS a document edit: the marker attr is re-synthesized
 *     (fold + raw title bytes preserved, case convention kept) and dispatched
 *     as a setNodeMarkup transaction.
 */
import "./callout.css";
import type { Node as PMNode } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";
import { t } from "@/i18n";
import {
    CALLOUT_KINDS,
    attrsFromMarker,
    markerWithKind,
    type CalloutKind,
} from "@/plugins/callouts";
import {
    IconAlertTriangle,
    IconBug,
    IconCheck,
    IconCheckCircle,
    IconChevronDown,
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
 * The title-bar label: the explicit title when present, else the raw type
 * capitalized (`[!note]` → "Note"), preserving an all-caps type as typed.
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
    ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Element }): boolean;
    destroy(): void;
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

    const kindButton = document.createElement("button");
    kindButton.type = "button";
    kindButton.className = "callout-kind";
    kindButton.title = t("Change callout type");

    const iconSpan = document.createElement("span");
    iconSpan.className = "callout-icon";
    const labelSpan = document.createElement("span");
    labelSpan.className = "callout-label";
    kindButton.append(iconSpan, labelSpan);

    const foldButton = document.createElement("button");
    foldButton.type = "button";
    foldButton.className = "callout-fold";
    foldButton.innerHTML = IconChevronDown;
    foldButton.title = t("Collapse / expand");

    titleBar.append(kindButton, foldButton);

    const content = document.createElement("div");
    content.className = "callout-body";

    dom.append(titleBar, content);

    // ── Fold (visual only — never rewrites the marker) ──────────────────────
    let collapsed = ((node.attrs["fold"] as string) ?? "") === "-";
    const renderCollapsed = (): void => {
        dom.classList.toggle("collapsed", collapsed);
        foldButton.setAttribute("aria-expanded", String(!collapsed));
    };
    foldButton.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        collapsed = !collapsed;
        renderCollapsed();
    });

    // ── Kind picker ─────────────────────────────────────────────────────────
    let menu: HTMLElement | null = null;
    const closeMenu = (): void => {
        menu?.remove();
        menu = null;
        document.removeEventListener("mousedown", onOutside, true);
    };
    const onOutside = (e: MouseEvent): void => {
        if (menu && !menu.contains(e.target as Node) && e.target !== kindButton) {
            closeMenu();
        }
    };
    const openMenu = (): void => {
        if (menu) {
            closeMenu();
            return;
        }
        menu = document.createElement("div");
        menu.className = "callout-menu";
        for (const kind of CALLOUT_KINDS) {
            const item = document.createElement("button");
            item.type = "button";
            item.className = "callout-menu-item";
            item.dataset["kind"] = kind;
            item.innerHTML = CALLOUT_ICONS[kind];
            const name = document.createElement("span");
            name.textContent = kind.charAt(0).toUpperCase() + kind.slice(1);
            item.appendChild(name);
            if (kind === (node.attrs["kind"] as string)) {
                item.classList.add("active");
            }
            item.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeMenu();
                const pos = getPos();
                if (pos === undefined) return;
                const marker = markerWithKind(
                    (node.attrs["marker"] as string) ?? "[!NOTE]",
                    kind,
                );
                view.dispatch(
                    view.state.tr.setNodeMarkup(
                        pos,
                        null,
                        attrsFromMarker(marker, node.attrs["attached"] as boolean),
                    ),
                );
            });
            menu.appendChild(item);
        }
        titleBar.appendChild(menu);
        document.addEventListener("mousedown", onOutside, true);
    };
    kindButton.addEventListener("mousedown", (e) => {
        e.preventDefault();
        e.stopPropagation();
        openMenu();
    });

    const render = (): void => {
        const kind = (node.attrs["kind"] as CalloutKind) ?? "note";
        dom.dataset["kind"] = kind;
        iconSpan.innerHTML = CALLOUT_ICONS[kind] ?? IconPencil;
        labelSpan.textContent = calloutLabel(node);
        const hasFold = ((node.attrs["fold"] as string) ?? "") !== "";
        foldButton.style.display = hasFold ? "" : "none";
    };
    render();
    renderCollapsed();

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
        destroy(): void {
            closeMenu();
        },
    };
}
