// refractor's exports map: "./*" → "./lang/*.js", so import paths omit "lang/"
import { refractor } from "refractor/core";
import { normalizeCodeLanguage } from "./codeLanguages";

// The bundled Prism grammars (~155 KB) are split into a lazily-loaded chunk
// (highlighterLanguages.ts) instead of being registered synchronously at boot,
// so a launch no longer parses them for documents with no code.
let grammarsPromise: Promise<void> | null = null;

/**
 * Load and register the bundled syntax grammars, once (cached). Until this
 * resolves, `highlight()` returns escaped plaintext and the prism plugin skips
 * unregistered languages (it warns and leaves them undecorated), so code renders
 * unstyled but correct. Call sites bring highlighting up to date once grammars
 * are ready: editor.ts awaits this before create when the initial document has a
 * code fence; the code-block NodeView triggers it for code added later (prism
 * re-decorates on the next edit inside the block).
 */
export function ensureGrammars(): Promise<void> {
    if (!grammarsPromise) {
        grammarsPromise = import("./highlighterLanguages").then(
            ({ registerGrammars }) => {
                registerGrammars(refractor);
            },
        );
    }
    return grammarsPromise;
}

// ── Custom Mermaid syntax highlighting ─────────────────────────────────
// Kept eager (it is tiny, and the code-block lightbox highlights mermaid source
// directly via highlight(), independent of the lazy grammar chunk).
if (!refractor.registered('mermaid')) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const mermaidSyntax: any = function (Prism: any) {
        Prism.languages['mermaid'] = {
            comment: { pattern: /%%[^\r\n]*/, greedy: true },
            string:  { pattern: /"[^"]*"/, greedy: true },
            label:   { pattern: /\|[^|]*\|/, greedy: true },
            bracket: { pattern: /\[(?:[^\[\]]|\[[^\[\]]*\])*\]|\{[^{}]*\}|\([^()]*\)|\(\([^()]*\)\)/, greedy: true },
            keyword: /\b(?:graph|flowchart|sequenceDiagram|classDiagram|stateDiagram|stateDiagram-v2|erDiagram|gantt|pie|showData|mindmap|timeline|gitGraph|quadrantChart|xychart-beta|sankey-beta|block-beta|architecture-beta|LR|RL|TD|TB|BT|subgraph|end|participant|actor|Note|note|over|loop|opt|alt|else|critical|break|par|and|rect|activate|deactivate|title|section|class|state|direction|as|autonumber|link|style|classDef|fill|stroke|color)\b/i,
            arrow:   /(?:-->|-->>|->>|--[ox*]|<-->|<-->>|<<-->|o--o|\*--\*|\.->|==>|==|--)/,
            number:  /\b\d+(?:\.\d+)?\b/,
            punctuation: /[[\]{}()]/,
        };
    };
    mermaidSyntax.displayName = 'mermaid';
    mermaidSyntax.aliases = [];
    refractor.register(mermaidSyntax);
}

// ── HAST → HTML string (only handles token spans; no hast-util-to-html needed) ──
function escapeHtml(str: string): string {
    return str
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type HastNode = { type: string; value?: string; properties?: { className?: string[] }; children?: HastNode[] };

function hastToHtml(node: HastNode): string {
    if (node.type === "text") return escapeHtml(node.value ?? "");
    if (node.type === "element") {
        const cls = (node.properties?.className)?.join(" ") || "";
        const inner = node.children?.map(hastToHtml).join("") ?? "";
        return cls ? `<span class="${cls}">${inner}</span>` : inner;
    }
    if (node.type === "root")
        return node.children?.map(hastToHtml).join("") ?? "";
    return "";
}

/**
 * Syntax-highlight code with refractor, returning an HTML string with token spans.
 * If the language is unsupported or highlighting fails, returns HTML-escaped plain text.
 */
export function highlight(code: string, lang: string): string {
    const normalizedLang = normalizeCodeLanguage(lang);
    if (!normalizedLang || !refractor.registered(normalizedLang)) return escapeHtml(code);
    try {
        const tree = refractor.highlight(code, normalizedLang);
        return hastToHtml(tree);
    } catch {
        return escapeHtml(code);
    }
}

export { refractor };
