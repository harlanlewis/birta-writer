/**
 * Finds the CSS that lives in `.ts` files, so the repo-wide CSS guards
 * (`chromeTokens.test.ts`, `noColorLiterals.test.ts`) can scan it with the same
 * rules they apply to `.css`. Not a test file — Vitest only collects `*.test.ts`.
 *
 * **Why this exists (MAR-260).** Both guards walked `.css` only, so the identical
 * value set from TypeScript passed untouched: `el.style.borderRadius = "7px"`,
 * `el.style.fontSize = "11px"` and `el.style.color = "#ff0000"` were all green
 * while each fails immediately in a stylesheet. That is a scan-scope gap, not a
 * threshold one, and it is not hypothetical — two whole stylesheets already live
 * in template literals (`components/findBar/highlightStyles.ts`,
 * `components/lineNumbers/styles.ts`), moved there for measured launch-cost
 * reasons, and moving them silently took them out of both guards. Each grew a
 * bespoke per-file re-imposition test instead, every one a fresh hand-rolled
 * regex weaker than the rule it stood in for. The third one would not have.
 *
 * **Two shapes are extracted, and the boundary is deliberate:**
 *
 * 1. `stylesheet` — a template literal holding CSS rule blocks, i.e. the text
 *    that reaches a `<style>` element. Scanned verbatim, with real line numbers.
 * 2. `inline` — a *literal* value written to a style property:
 *    `el.style.<prop> = "…"`, `el.style.cssText = "…"`, and
 *    `el.style.setProperty("<prop>", "…")`. Synthesized into a one-line rule so
 *    the CSS scanners read it unchanged.
 *
 * **What is deliberately NOT extracted**, each because the rule genuinely does
 * not apply rather than because it was hard:
 *
 * - **A value that is not a literal.** `sticky.style.fontSize = style.fontSize`
 *   (copied from a computed style) and `el.style.fontSize = \`${pct}%\``
 *   (an interpolated template) mint nothing — the guard cannot know the value
 *   and has no business guessing. Only a string literal or a template literal
 *   with no substitutions is read.
 * - **`setProperty` on a custom property.** `style.setProperty("--ui-radius-s", …)`
 *   is composing a token, not minting a value, and falls out naturally: the
 *   radius rule asks about `border-radius` declarations, which that is not.
 * - **`style="fill:#c09553"` inside an SVG/HTML string.** The file-type icons
 *   (`components/pathLink/fileIcons.ts`) are brand marks — TypeScript blue,
 *   JavaScript yellow — and are theme-independent by nature, the same category
 *   as the always-dark lightbox scrims the CSS guard exempts by annotation.
 *   Sweeping ~30 of them in would buy annotations, not safety. Chrome icons
 *   (`ui/icons.ts`) already carry no literal at all: they paint `currentColor`.
 *
 * **Parsing is done with the TypeScript AST, not a regex**, and that is load
 * bearing. The first cut of this scanner matched template literals with
 * ``/`([^`]*)`/g`` and produced 60 KB of garbage: backticks inside comments and
 * prose pair up with real ones, so it "found" template literals spanning half of
 * `blockCapabilities.ts`. A regex cannot tell a template literal from a comment
 * that mentions one.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import ts from "typescript";

export interface CssSource {
    /** Path relative to `webview/`, POSIX-separated. */
    file: string;
    /** CSS text, ready to hand to a scanner. */
    text: string;
    /** 1-based line in the source file that `text`'s first line occupies. */
    startLine: number;
    kind: "stylesheet" | "inline";
}

/**
 * A CSS rule block: a brace pair enclosing at least one `prop: value`. This is
 * what separates an injected stylesheet from every other template literal in the
 * tree (SQL-ish strings, HTML fragments, prose). Nested braces are not required
 * to match — one flat block anywhere in the literal is enough to classify it.
 */
const RULE_BLOCK_RE = /\{[^{}]*[\w-]+\s*:[^{}]*[;}]/;

/** `borderTopLeftRadius` → `border-top-left-radius`. */
function kebab(prop: string): string {
    return prop.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
}

/** The literal text of a string / substitution-free template, else null. */
function literalText(node: ts.Node): string | null {
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
        return node.text;
    }
    return null;
}

function tsFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === "node_modules" || name === "__tests__" || name.startsWith(".")) continue;
        const path = join(dir, name);
        if (statSync(path).isDirectory()) tsFiles(path, out);
        else if (name.endsWith(".ts")) out.push(path);
    }
    return out;
}

/**
 * The `color-literal-ok:` escape hatch, spelled as a line comment on the
 * assignment. Carried through as the CSS annotation the scanners already
 * understand, rather than teaching them a second exemption mechanism. The
 * reason stays required — an empty one exempts nothing, exactly as in CSS.
 */
function annotationOn(line: string): string {
    const m = /\/\/\s*(color-literal-ok:\s*\S[^\n]*?)\s*$/.exec(line);
    return m ? ` /* ${m[1]} */` : "";
}

/** Extract every chunk of CSS authored inside one TypeScript source. */
export function cssSourcesInFile(text: string, file: string): CssSource[] {
    const found: CssSource[] = [];
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.ES2020, true);
    const lines = text.split("\n");
    const lineOf = (pos: number) => sf.getLineAndCharacterOfPosition(pos).line;

    /** Synthesize a one-line rule from a declaration written in TypeScript. */
    const inline = (decls: string, pos: number): void => {
        const line = lineOf(pos);
        found.push({
            file,
            text: `a { ${decls} }${annotationOn(lines[line] ?? "")}`,
            startLine: line + 1,
            kind: "inline",
        });
    };

    const visit = (node: ts.Node): void => {
        // 1. An injected stylesheet: a substitution-free template holding rules.
        if (ts.isNoSubstitutionTemplateLiteral(node) && RULE_BLOCK_RE.test(node.text)) {
            // `node.text` begins one character after the opening backtick, so
            // its first line is the backtick's own line.
            found.push({
                file,
                text: node.text,
                startLine: lineOf(node.getStart(sf)) + 1,
                kind: "stylesheet",
            });
        }

        // 2. `<expr>.style.<prop> = "<literal>"`.
        if (
            ts.isBinaryExpression(node)
            && node.operatorToken.kind === ts.SyntaxKind.EqualsToken
            && ts.isPropertyAccessExpression(node.left)
            && ts.isPropertyAccessExpression(node.left.expression)
            && node.left.expression.name.text === "style"
        ) {
            const value = literalText(node.right);
            const prop = node.left.name.text;
            if (value !== null) {
                // `cssText` already IS a declaration list; anything else is one
                // property's value.
                inline(prop === "cssText" ? value : `${kebab(prop)}: ${value};`, node.getStart(sf));
            }
        }

        // 3. `<expr>.style.setProperty("<prop>", "<literal>")`.
        if (
            ts.isCallExpression(node)
            && ts.isPropertyAccessExpression(node.expression)
            && node.expression.name.text === "setProperty"
            && ts.isPropertyAccessExpression(node.expression.expression)
            && node.expression.expression.name.text === "style"
            && node.arguments.length >= 2
        ) {
            const prop = literalText(node.arguments[0]);
            const value = literalText(node.arguments[1]);
            if (prop !== null && value !== null) {
                inline(`${prop}: ${value};`, node.getStart(sf));
            }
        }

        ts.forEachChild(node, visit);
    };
    visit(sf);
    return found;
}

/** Every chunk of CSS authored inside the `.ts` under `webviewRoot`. */
export function cssSourcesInTypeScript(webviewRoot: string): CssSource[] {
    const out: CssSource[] = [];
    for (const path of tsFiles(webviewRoot)) {
        const text = readFileSync(path, "utf8");
        // Cheap prefilter: parsing every webview module costs far more than the
        // two substring tests that rule most of them out.
        if (!text.includes(".style.") && !text.includes("`")) continue;
        out.push(...cssSourcesInFile(text, relative(webviewRoot, path).split(sep).join("/")));
    }
    return out;
}
