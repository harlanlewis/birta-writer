/**
 * `<details>` NodeView — chrome for `details` nodes (plugins/details.ts): a
 * summary row holding a disclosure toggle and the editable summary, above an
 * editable body.
 *
 * The tags never appear in the editing surface. The opener's bytes live in
 * the node's `opener` attr and serialize back verbatim; editing the summary
 * rewrites only the `<summary>` element in them (openerWithSummary), with the
 * text escaped, so a typed `<` cannot become markup.
 *
 * Open and closed are the fold layer's, as for a callout: the toggle and the
 * `…` dispatch the shared fold meta, the `collapsed` class arrives as a node
 * decoration, and neither touches the document, so reading a file by opening
 * and closing its disclosures never dirties it. Where the fold layer refuses
 * a fold (inside a list item, an empty body, folding turned off) the toggle
 * is not drawn, because it could do nothing there.
 */
import "./details.css";
import type { Node as PMNode } from "@/pm";
import type { EditorView } from "@/pm";
import { t } from "@/i18n";
import { isBareEscape } from "@/ui/escapeLayers";
import { markEditableIsland } from "@/readOnly";
import { createFoldEllipsis } from "@/ui/foldEllipsis";
import { foldPluginKey, type FoldMeta } from "@/plugins/foldState";
import { IconChevronRight } from "@/ui/icons";
// foldModel directly rather than the headingFold index, for the load-order
// reason editing/wrapBlocks.ts gives.
import { foldHiddenRange } from "@/plugins/headingFold/foldModel";
import { attrsFromOpener, openerWithSummary } from "@/plugins/details";

interface DetailsView {
    dom: HTMLElement;
    contentDOM: HTMLElement;
    update(node: PMNode): boolean;
    stopEvent(event: Event): boolean;
    ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Node }): boolean;
}

export function createDetailsView(
    initialNode: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
): DetailsView {
    let node = initialNode;

    const dom = document.createElement("div");
    dom.className = "details-block";
    dom.dataset["type"] = "details";

    const header = document.createElement("div");
    header.className = "details-summary";
    header.contentEditable = "false";

    const setFold = (meta: FoldMeta): void => {
        view.dispatch(view.state.tr.setMeta(foldPluginKey, meta).setMeta("addToHistory", false));
    };

    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "details-toggle";
    toggle.innerHTML = IconChevronRight;
    toggle.setAttribute("aria-label", t("Show or hide details"));
    toggle.addEventListener("mousedown", (e) => e.preventDefault());
    toggle.addEventListener("click", () => {
        const pos = getPos();
        if (pos === undefined) return;
        setFold({ type: "toggle", pos });
    });

    const summary = document.createElement("span");
    summary.className = "details-summary-text";
    summary.setAttribute("role", "textbox");
    summary.setAttribute("aria-label", t("Details summary"));
    // The browser's own label for a details with no summary, so an unnamed
    // disclosure reads here the way it will everywhere else.
    summary.dataset["placeholder"] = t("Details");
    summary.spellcheck = false;
    markEditableIsland(summary);

    const ellipsis = createFoldEllipsis(initialNode.childCount, () => {
        const pos = getPos();
        if (pos === undefined) return;
        setFold({ type: "set", pos, folded: false });
        view.focus();
    });
    ellipsis.dom.classList.add("details-fold-ellipsis");

    header.append(toggle, summary, ellipsis.dom);

    const content = document.createElement("div");
    content.className = "details-body";

    dom.append(header, content);

    const commitSummary = (): void => {
        const typed = (summary.textContent ?? "").trim();
        if (typed === ((node.attrs["summary"] as string) ?? "")) return; // untouched
        const pos = getPos();
        if (pos === undefined) return;
        const opener = openerWithSummary((node.attrs["opener"] as string) ?? "<details>", typed);
        view.dispatch(view.state.tr.setNodeMarkup(pos, null, attrsFromOpener(opener)));
    };
    summary.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            summary.blur(); // blur commits
        } else if (isBareEscape(e)) {
            e.preventDefault();
            summary.textContent = (node.attrs["summary"] as string) ?? ""; // revert
            summary.blur();
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
            // Keep select-all inside the island; natively it escapes into the
            // surrounding contenteditable and selects the whole document.
            e.preventDefault();
            const range = document.createRange();
            range.selectNodeContents(summary);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
        }
    });
    summary.addEventListener("blur", commitSummary);

    const render = (): void => {
        dom.dataset["open"] = String(node.attrs["open"] === true);
        const pos = getPos();
        const enabled = foldPluginKey.getState(view.state)?.enabled ?? true;
        toggle.hidden = !enabled || pos === undefined
            || foldHiddenRange(view.state.doc, pos, node) === null;
        if (document.activeElement !== summary) {
            summary.textContent = (node.attrs["summary"] as string) ?? "";
        }
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
            return header.contains(event.target as Node);
        },
        ignoreMutation(mutation): boolean {
            if (mutation.type === "selection") return false;
            return !content.contains(mutation.target as Node) && mutation.target !== content;
        },
    };
}
