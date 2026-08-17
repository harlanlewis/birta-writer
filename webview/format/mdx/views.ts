/**
 * webview/format/mdx/views.ts — the inert renderings of MDX's structural
 * islands (MAR-42).
 *
 * Every mdx node is an opaque chip or block: the document's code is NEVER
 * executed and never reaches innerHTML — all source text lands via
 * textContent, so a hostile document can render only its own bytes as inert
 * text. The one editable surface is the JSX flow element's attribute form
 * (MAR-350): a string attribute's value is a text input, and a commit is an
 * in-place splice of that one literal into the island's bytes
 * (attributes.ts). No registry decides which components get it; any element
 * whose structure is known does, and everything that is code (expressions,
 * spreads, the element's children) stays read-only.
 *
 * The styles are injected on first use (the findBar/highlightStyles.ts
 * pattern) rather than authored in the eager stylesheet: a markdown document
 * must not carry mdx bytes, and this whole module only loads for `.mdx`
 * documents. `noColorLiterals.test.ts` and `chromeTokens.test.ts` extract CSS
 * from `.ts` template literals, so the repo-wide color and chrome-token rules
 * apply to the string below with no per-file guard.
 */
import type { EditorView } from "@/pm";
import { t } from "@/i18n";
import { isReadOnly, lockWithDocument } from "@/readOnly";
import { spliceAttributeValue, type JsxAttribute, type JsxStructure } from "./attributes";

/** `id` of the injected style element — also the idempotence key. */
const STYLE_ID = "mdx-node-styles";

export const MDX_NODE_CSS = `
.mdx-block {
    margin: 0.5em 0;
    padding: 0.45em 0.7em;
    border: 1px solid var(--vscode-editorWidget-border);
    border-radius: var(--ui-radius-m);
    background: var(--vscode-textCodeBlock-background);
}

/* No text-transform: a JSX component name is a case-sensitive identifier,
   and a label reading <CHART> for <Chart> misstates the document. */
.mdx-block-label {
    display: block;
    margin-bottom: 0.25em;
    color: var(--vscode-descriptionForeground);
    font-size: 0.75em;
    letter-spacing: 0.04em;
    user-select: none;
}

.mdx-block-source {
    margin: 0;
    color: var(--vscode-editor-foreground);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
}

/* The attribute form: one row per attribute, name then value. Chrome, so it
   takes the chrome type scale rather than the document's em scale. */
.mdx-attr-form {
    display: grid;
    grid-template-columns: max-content minmax(0, 1fr);
    column-gap: 0.6em;
    row-gap: 4px;
    margin: 0 0 0.45em;
    font-size: var(--ui-fs-m);
}

.mdx-attr-row {
    display: contents;
}

.mdx-attr-name {
    align-self: center;
    color: var(--vscode-descriptionForeground);
    font-family: var(--vscode-editor-font-family, monospace);
    user-select: none;
}

.mdx-attr-input {
    box-sizing: border-box;
    min-width: 0;
    height: 24px;
    padding: 0 7px;
    background: var(--vscode-input-background);
    color: var(--vscode-input-foreground);
    border: 1px solid var(--vscode-input-border, var(--vscode-panel-border));
    border-radius: var(--ui-radius-m);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: var(--ui-fs-m);
    outline: none;
}

.mdx-attr-input:focus {
    border-color: var(--vscode-focusBorder);
}

.mdx-attr-code {
    align-self: center;
    color: var(--vscode-textPreformat-foreground);
    font-family: var(--vscode-editor-font-family, monospace);
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
}

.mdx-inline-chip {
    display: inline-block;
    max-width: 100%;
    padding: 0 0.35em;
    border-radius: var(--ui-radius-s);
    background: var(--vscode-textCodeBlock-background);
    color: var(--vscode-textPreformat-foreground);
    font-family: var(--vscode-editor-font-family, monospace);
    font-size: 0.85em;
    white-space: pre;
    overflow: hidden;
    text-overflow: ellipsis;
    vertical-align: baseline;
}

/* Selection state rides the same accent every selected atom uses. */
.ProseMirror-selectednode.mdx-block,
.ProseMirror-selectednode.mdx-inline-chip {
    outline: 2px solid var(--vscode-focusBorder);
    outline-offset: 1px;
}
`;

/** Install the mdx node styles once per document. */
function ensureMdxStyles(): void {
    if (typeof document === "undefined" || !document.head) {
        return;
    }
    if (document.getElementById(STYLE_ID)) {
        return;
    }
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = MDX_NODE_CSS;
    document.head.appendChild(style);
}

/** The human label of a flow-level mdx node, from its kind + source. */
export function mdxBlockLabel(kind: string, value: string): string {
    if (kind === "mdxjsEsm") {
        return "MDX import/export";
    }
    if (kind === "mdxFlowExpression") {
        return "MDX expression";
    }
    // A JSX element: name the component when the source names one.
    const name = /^<\s*([A-Za-z][\w.-]*)/.exec(value)?.[1];
    return name ? `JSX <${name}>` : "JSX";
}

type AttrsNode = { attrs: Record<string, unknown> };

/** Whether an attribute gets a text input rather than read-only code. */
function hasInput(attr: JsxAttribute): boolean {
    return attr.kind === "string" && !attr.value!.includes("\n");
}

/**
 * Whether the two structures describe the same form: same element, same
 * attribute names and kinds in the same order, each with the same control.
 * Values and offsets may differ (that is what an edit changes); anything else
 * means the rows must be rebuilt.
 */
function sameForm(a: JsxStructure | null, b: JsxStructure | null): boolean {
    if (a === null || b === null) {
        return a === b;
    }
    if (a.name !== b.name || a.attributes.length !== b.attributes.length) {
        return false;
    }
    return a.attributes.every((x, i) => {
        const y = b.attributes[i]!;
        return x.name === y.name && x.kind === y.kind && hasInput(x) === hasInput(y);
    });
}

/**
 * The attribute form of a JSX flow element: one row per attribute, in source
 * order. A string literal gets a text input that writes back through
 * `spliceAttributeValue`; every other kind (boolean, expression, spread) is
 * shown as its source and stays read-only, because those are code.
 *
 * A string value containing a newline is shown read-only too: a text input
 * flattens newlines on the way in, so the first keystroke would silently
 * commit the flattened value.
 */
function buildAttributeRows(
    form: HTMLElement,
    jsx: JsxStructure,
    raw: string,
    commit: (index: number, next: string) => void,
    committed: (index: number) => string,
): HTMLInputElement[] {
    form.replaceChildren();
    const inputs: HTMLInputElement[] = [];
    jsx.attributes.forEach((attr, index) => {
        const row = document.createElement("label");
        row.className = "mdx-attr-row";
        const name = document.createElement("span");
        name.className = "mdx-attr-name";
        name.textContent = attr.name ?? "";
        row.appendChild(name);
        if (hasInput(attr)) {
            const input = document.createElement("input");
            input.type = "text";
            input.className = "mdx-attr-input";
            input.value = attr.value ?? "";
            input.spellcheck = false;
            input.setAttribute("aria-label", t("Attribute value"));
            input.dataset["attr"] = attr.name ?? "";
            lockWithDocument(input);
            // Commit on change (blur or Enter). Enter is also caught so the
            // value lands without leaving the field; Escape puts the file's
            // value back.
            input.addEventListener("change", () => commit(index, input.value));
            input.addEventListener("keydown", (e) => {
                if (e.key === "Enter") {
                    e.preventDefault();
                    commit(index, input.value);
                } else if (e.key === "Escape") {
                    e.preventDefault();
                    input.value = committed(index);
                    input.blur();
                }
            });
            row.appendChild(input);
            inputs.push(input);
        } else {
            const code = document.createElement("code");
            code.className = "mdx-attr-code";
            const text = raw.slice(attr.start, attr.end);
            code.textContent = attr.kind === "boolean" ? "" : text.slice(text.indexOf("=") + 1);
            code.title =
                attr.kind === "boolean"
                    ? t("Boolean attribute (present, no value)")
                    : t("Code, never evaluated. Edit it in the text editor.");
            row.appendChild(code);
        }
        form.appendChild(row);
    });
    return inputs;
}

/**
 * Flow-level mdx island: a labeled block showing the exact source bytes it
 * will serialize back as. A JSX flow element whose attribute structure is
 * known (`jsx` attr, from attributes.ts) also gets the attribute form above
 * its source: a string attribute's value can be edited in place, and every
 * other byte of the island is left exactly as written. The trade this makes
 * is stated in attributes.ts; the source `<pre>` stays visible so the bytes
 * the edit produced are always on screen.
 */
export function createMdxBlockView(node: AttrsNode, view?: EditorView, getPos?: () => number | undefined) {
    ensureMdxStyles();
    const kind = String(node.attrs["kind"] ?? "");
    const dom = document.createElement("div");
    dom.className = "mdx-block";
    dom.dataset["type"] = "mdx_block";
    dom.dataset["kind"] = kind;
    dom.contentEditable = "false";
    const label = document.createElement("span");
    label.className = "mdx-block-label";
    const form = document.createElement("div");
    form.className = "mdx-attr-form";
    const source = document.createElement("pre");
    source.className = "mdx-block-source";
    let inputs: HTMLInputElement[] = [];
    let jsx: JsxStructure | null = null;

    const commit = (index: number, next: string): void => {
        if (!view || !getPos || isReadOnly()) {
            return;
        }
        const pos = getPos();
        if (pos == null) {
            return;
        }
        const live = view.state.doc.nodeAt(pos);
        if (!live || live.type.name !== "mdx_block") {
            return;
        }
        const liveJsx = live.attrs["jsx"] as JsxStructure | null;
        if (!liveJsx) {
            return;
        }
        const attr = liveJsx.attributes[index];
        if (!attr || attr.value === next) {
            return;
        }
        const spliced = spliceAttributeValue(String(live.attrs["value"] ?? ""), liveJsx, index, next);
        if (!spliced) {
            return;
        }
        view.dispatch(
            view.state.tr.setNodeMarkup(pos, undefined, {
                ...live.attrs,
                value: spliced.value,
                jsx: spliced.jsx,
            }),
        );
    };

    const render = (n: AttrsNode, rebuild: boolean): void => {
        const value = String(n.attrs["value"] ?? "");
        jsx = (n.attrs["jsx"] as JsxStructure | null) ?? null;
        label.textContent = mdxBlockLabel(kind, value);
        source.textContent = value;
        const editable = jsx !== null && jsx.attributes.length > 0;
        dom.title = editable
            ? t("MDX component. Its code is never executed; string attributes can be edited here, everything else in the text editor.")
            : t("MDX code — never executed, preserved as written. Edit it in the text editor.");
        if (!editable) {
            form.remove();
            inputs = [];
            return;
        }
        if (rebuild) {
            inputs = buildAttributeRows(form, jsx!, value, commit, (i) => jsx?.attributes[i]?.value ?? "");
            if (!form.isConnected) {
                label.after(form);
            }
            return;
        }
        // Same form: refresh only the values, leaving a focused input alone
        // (its own commit is what produced this update).
        let at = 0;
        for (const attr of jsx!.attributes) {
            if (!hasInput(attr)) {
                continue;
            }
            const input = inputs[at++];
            if (input && document.activeElement !== input && input.value !== attr.value) {
                input.value = attr.value ?? "";
            }
        }
    };

    dom.append(label, source);
    render(node, true);

    return {
        dom,
        update(n: AttrsNode & { type?: { name: string } }) {
            if ((n.type && n.type.name !== "mdx_block") || String(n.attrs["kind"] ?? "") !== kind) {
                return false;
            }
            const nextJsx = (n.attrs["jsx"] as JsxStructure | null) ?? null;
            const rebuild = !sameForm(jsx, nextJsx);
            render(n, rebuild);
            return true;
        },
        ignoreMutation: () => true,
        // Events inside the form (typing, clicking an input) belong to the
        // form: ProseMirror must neither swallow the keystroke nor turn the
        // click into a node selection.
        stopEvent: (e: Event) => form.contains(e.target as Node),
    };
}

/**
 * Inline mdx island (`{expr}` / `<Tag>text</Tag>` inside prose): an opaque
 * chip carrying its source bytes.
 */
export function createMdxInlineView(node: AttrsNode) {
    ensureMdxStyles();
    const kind = String(node.attrs["kind"] ?? "");
    const value = String(node.attrs["value"] ?? "");
    const dom = document.createElement("span");
    dom.className = "mdx-inline-chip";
    dom.dataset["type"] = "mdx_inline";
    dom.dataset["kind"] = kind;
    dom.contentEditable = "false";
    dom.title = "MDX code — never executed, preserved as written. Edit it in the text editor.";
    dom.textContent = value;
    return {
        dom,
        ignoreMutation: () => true,
        stopEvent: () => false,
    };
}
