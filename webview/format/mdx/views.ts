/**
 * webview/format/mdx/views.ts — the inert renderings of MDX's structural
 * islands (MAR-42).
 *
 * Every mdx node is an opaque, read-only chip or block: the document's code is
 * NEVER executed and never reaches innerHTML — all source text lands via
 * textContent, so a hostile document can render only its own bytes as inert
 * text. Attribute-editor affordances for allowlisted components are a later
 * layer; with the descriptor registry empty, every JSX element takes the
 * labeled-block rendering below.
 *
 * The styles are injected on first use (the findBar/highlightStyles.ts
 * pattern) rather than authored in the eager stylesheet: a markdown document
 * must not carry mdx bytes, and this whole module only loads for `.mdx`
 * documents. `noColorLiterals.test.ts` and `chromeTokens.test.ts` extract CSS
 * from `.ts` template literals, so the repo-wide color and chrome-token rules
 * apply to the string below with no per-file guard.
 */

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

/**
 * Flow-level mdx island: a labeled, read-only block showing the exact source
 * bytes it will serialize back as.
 */
export function createMdxBlockView(node: AttrsNode) {
    ensureMdxStyles();
    const kind = String(node.attrs["kind"] ?? "");
    const value = String(node.attrs["value"] ?? "");
    const dom = document.createElement("div");
    dom.className = "mdx-block";
    dom.dataset["type"] = "mdx_block";
    dom.dataset["kind"] = kind;
    dom.contentEditable = "false";
    dom.title = "MDX code — never executed, preserved as written. Edit it in the text editor.";
    const label = document.createElement("span");
    label.className = "mdx-block-label";
    label.textContent = mdxBlockLabel(kind, value);
    const source = document.createElement("pre");
    source.className = "mdx-block-source";
    source.textContent = value;
    dom.append(label, source);
    return {
        dom,
        ignoreMutation: () => true,
        stopEvent: () => false,
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
