/**
 * Container-directive NodeView — chrome for `container_directive` nodes
 * (plugins/directives.ts): a header with the directive name (mono badge) and
 * an editable title, above an editable body. Known admonition names
 * (note/tip/info/warning/danger/…) get callout-style accent colors via
 * data-name in directive.css; anything else renders neutrally.
 *
 * The fences never appear in the editing surface — they live in the node
 * attrs and serialize back verbatim. Editing the title re-synthesizes the
 * opening fence through openFenceWithTitle (name, colon count, and any
 * trailing `{attrs}` block preserved; risky punctuation sanitized, because
 * fence bytes cannot carry escapes — see plugins/directives.ts).
 */
import "./directive.css";
import type { Node as PMNode } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";
import { t } from "@/i18n";
import { attrsFromFences, openFenceWithTitle } from "@/plugins/directives";

interface DirectiveView {
    dom: HTMLElement;
    contentDOM: HTMLElement;
    update(node: PMNode): boolean;
    stopEvent(event: Event): boolean;
    ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Element }): boolean;
}

export function createDirectiveView(
    initialNode: PMNode,
    view: EditorView,
    getPos: () => number | undefined,
): DirectiveView {
    let node = initialNode;

    const dom = document.createElement("div");
    dom.className = "container-directive";
    dom.dataset["type"] = "container-directive";

    const header = document.createElement("div");
    header.className = "directive-header";
    header.contentEditable = "false";

    const badge = document.createElement("span");
    badge.className = "directive-name";

    const title = document.createElement("span");
    title.className = "directive-title";
    title.setAttribute("role", "textbox");
    title.setAttribute("aria-label", t("Directive title"));
    title.spellcheck = false;
    try {
        title.contentEditable = "plaintext-only";
    } catch {
        title.contentEditable = "true";
    }

    header.append(badge, title);

    const content = document.createElement("div");
    content.className = "directive-body";

    dom.append(header, content);

    const commitTitle = (): void => {
        const typed = (title.textContent ?? "").trim();
        if (typed === ((node.attrs["title"] as string) ?? "")) return; // untouched
        const pos = getPos();
        if (pos === undefined) return;
        const openFence = openFenceWithTitle(
            (node.attrs["openFence"] as string) ?? ":::note",
            typed,
        );
        view.dispatch(
            view.state.tr.setNodeMarkup(
                pos,
                null,
                attrsFromFences(
                    openFence,
                    (node.attrs["closeFence"] as string) ?? ":::",
                    node.attrs["openAttached"] as boolean,
                    node.attrs["closeAttached"] as boolean,
                ),
            ),
        );
    };
    title.addEventListener("keydown", (e) => {
        if (e.key === "Enter") {
            e.preventDefault();
            title.blur(); // blur commits
        } else if (e.key === "Escape") {
            e.preventDefault();
            title.textContent = (node.attrs["title"] as string) ?? ""; // revert
            title.blur();
        } else if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "a") {
            // Keep select-all inside the title island — the native behavior
            // escapes into the surrounding contenteditable and selects the
            // whole document.
            e.preventDefault();
            const range = document.createRange();
            range.selectNodeContents(title);
            const sel = window.getSelection();
            sel?.removeAllRanges();
            sel?.addRange(range);
        }
    });
    title.addEventListener("blur", commitTitle);

    const render = (): void => {
        const name = (node.attrs["name"] as string) ?? "";
        dom.dataset["name"] = name.toLowerCase();
        badge.textContent = name;
        if (document.activeElement !== title) {
            title.textContent = (node.attrs["title"] as string) ?? "";
        }
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
