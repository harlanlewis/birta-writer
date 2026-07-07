/**
 * Container-directive NodeView — chrome for `container_directive` nodes
 * (plugins/directives.ts): a header with the directive name (mono badge) and
 * optional title, above an editable body. Known admonition names
 * (note/tip/info/warning/danger/…) get callout-style accent colors via
 * data-name in directive.css; anything else renders neutrally.
 *
 * The fences themselves never appear in the editing surface — they live in
 * the node attrs and serialize back verbatim.
 */
import "./directive.css";
import type { Node as PMNode } from "@milkdown/prose/model";

interface DirectiveView {
    dom: HTMLElement;
    contentDOM: HTMLElement;
    update(node: PMNode): boolean;
    ignoreMutation(mutation: MutationRecord | { type: "selection"; target: Element }): boolean;
}

export function createDirectiveView(initialNode: PMNode): DirectiveView {
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
    header.append(badge, title);

    const content = document.createElement("div");
    content.className = "directive-body";

    dom.append(header, content);

    const render = (): void => {
        const name = (node.attrs["name"] as string) ?? "";
        dom.dataset["name"] = name.toLowerCase();
        badge.textContent = name;
        title.textContent = (node.attrs["title"] as string) ?? "";
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
