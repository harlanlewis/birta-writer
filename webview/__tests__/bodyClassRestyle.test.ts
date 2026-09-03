/**
 * No stylesheet rule keyed on a body state class may restyle the whole
 * document when the class flips.
 *
 * Two shapes do that, and both were on the block drag until 2026-09-02. A
 * selector whose subject is `*` under a body class (`body.x *`, and equally
 * `body.x :is(.a, .b) *`: the browser builds its invalidation from the
 * rightmost compound, so any universal subject invalidates every element).
 * And an INHERITED property written on the body itself or on the editor
 * root: `cursor`, `pointer-events` and `user-select` propagate to every
 * descendant, so changing one at the root recomputes every descendant's
 * style. A gesture flips these classes on its start and again on its end,
 * and on a long document each flip was a stall the count gates could not
 * see, because it is the browser's work rather than the bundle's.
 *
 * What a gesture wants from the page under the pointer lives on the
 * interaction shield instead (ui/interactionShield.ts), a transparent layer
 * that carries those properties itself. A body class may still exist for
 * the code that reads it, and may still style a NARROW subject (`.toc-item`
 * under it recalcs the rows and nothing else).
 *
 * Scanned wherever CSS is authored (`helpers/cssSources.ts` says what that
 * covers), the way the chrome guards are.
 */
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { cssSourcesInTypeScript } from "./helpers/cssSources";

const WEBVIEW_DIR = join(__dirname, "..");

function cssFiles(dir: string): string[] {
    const out: string[] = [];
    for (const name of readdirSync(dir)) {
        if (name === "__tests__" || name === "node_modules") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) out.push(...cssFiles(full));
        else if (name.endsWith(".css")) out.push(full);
    }
    return out;
}

/** A selector keyed on a body or root class whose subject is `*`. */
const UNIVERSAL_UNDER_BODY_CLASS = /(?:^|[,{}\s])(?:body|html)(?:\.[\w-]+)+(?:\([^)]*\)|[^,{}])*?\*(?::[\w-]+(?:\([^)]*\))?)*\s*(?=[,{])/g;

/**
 * A rule keyed on a body or root class, with a BROAD subject (the body
 * itself, or the editor root), whose block sets an inherited property.
 * Nesting is covered by the `&` form (`body.x & { cursor }` inside another
 * rule) only when that outer rule is itself a broad subject, which the
 * regex cannot see; the universal check above and the drag's own shield are
 * what stop the common case, and a narrow nested subject is allowed.
 */
const INHERITED_ON_ROOT =
    /(?:^|[,{}\s])(?:body|html)(?:\.[\w-]+)+(?::[\w-]+(?:\([^)]*\))?)*(?:\s+(?:\.milkdown|#editor|\.editor|\.ProseMirror|\.milkdown \.editor))?\s*\{[^{}]*?\b(?:cursor|pointer-events|user-select)\s*:/g;

const INHERITED_PROPS = /\b(?:cursor|pointer-events|user-select)\s*:/;

describe("body state classes never restyle the whole document", () => {
    const units = [
        ...cssFiles(WEBVIEW_DIR).map((f) => ({
            label: relative(WEBVIEW_DIR, f).split(sep).join("/"),
            text: readFileSync(f, "utf8"),
        })),
        ...cssSourcesInTypeScript(WEBVIEW_DIR).map((s) => ({ label: s.file, text: s.text })),
    ];

    it("should have CSS to scan", () => {
        expect(units.length).toBeGreaterThan(10);
        expect(units.some((u) => u.label === "style.css")).toBe(true);
    });

    it("the patterns should recognise the shapes they forbid and pass the shapes they allow", () => {
        const universal = "body.block-dragging,\nbody.block-dragging * {\n    cursor: grabbing;\n}\n";
        expect([...universal.matchAll(UNIVERSAL_UNDER_BODY_CLASS)].length).toBe(1);
        const isUniversal = "body.block-dragging :is(.editor-topbar, .toc-panel) * {\n    cursor: grabbing;\n}\n";
        expect([...isUniversal.matchAll(UNIVERSAL_UNDER_BODY_CLASS)].length).toBe(1);
        const onBody = "body.block-dragging {\n    cursor: grabbing;\n}\n";
        expect([...onBody.matchAll(INHERITED_ON_ROOT)].length).toBe(1);
        // A pseudo-class on either end changes nothing about the reach.
        const pseudoBody = "body.block-dragging:not(.x) {\n    cursor: grabbing;\n}\n";
        expect([...pseudoBody.matchAll(INHERITED_ON_ROOT)].length).toBe(1);
        const pseudoUniversal = "body.block-dragging *:not(.drop-line) {\n    cursor: grabbing;\n}\n";
        expect([...pseudoUniversal.matchAll(UNIVERSAL_UNDER_BODY_CLASS)].length).toBe(1);
        const onEditor = "body.block-dragging .milkdown .editor,\nbody.block-marqueeing .milkdown .editor {\n    pointer-events: none;\n}\n";
        expect([...onEditor.matchAll(INHERITED_ON_ROOT)].length).toBeGreaterThan(0);
        // Allowed: a narrow subject under the class, and a non-inherited
        // property on the body.
        const narrow = "body.block-dragging .toc-item:hover {\n    background: transparent;\n}\nbody.block-dragging .toc-item {\n    cursor: grabbing;\n}\n";
        expect([...narrow.matchAll(UNIVERSAL_UNDER_BODY_CLASS)].length).toBe(0);
        expect([...narrow.matchAll(INHERITED_ON_ROOT)].length).toBe(0);
        const nonInherited = "body.toolbar-hidden {\n    --editor-topbar-height: 0px;\n}\n";
        expect([...nonInherited.matchAll(INHERITED_ON_ROOT)].length).toBe(0);
        expect(INHERITED_PROPS.test("cursor: grab")).toBe(true);
    });

    it("no selector keyed on a body class should have a universal subject", () => {
        const hits: string[] = [];
        for (const unit of units) {
            for (const match of unit.text.matchAll(UNIVERSAL_UNDER_BODY_CLASS)) {
                const line = unit.text.slice(0, match.index).split("\n").length;
                hits.push(`${unit.label}:${line}: ${match[0].trim()}`);
            }
        }
        expect(hits).toEqual([]);
    });

    it("no rule keyed on a body class should set an inherited property on the body or the editor root", () => {
        const hits: string[] = [];
        for (const unit of units) {
            for (const match of unit.text.matchAll(INHERITED_ON_ROOT)) {
                const line = unit.text.slice(0, match.index).split("\n").length;
                hits.push(`${unit.label}:${line}: ${match[0].trim().split("\n")[0]}`);
            }
        }
        expect(hits).toEqual([]);
    });
});
