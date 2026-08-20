/**
 * Guard for the ui-* chrome PRIMITIVES: every one a component names has a rule
 * behind it.
 *
 * The sibling guard (chromeTokens.test.ts) judges values that are present and
 * wrong. This one judges a rule that is ABSENT, which nothing else can see:
 * a class name that resolves to no rule is not an error in CSS, in TypeScript,
 * or at runtime. The element simply arrives with no ground, no border and no
 * shadow, and every check written about it still passes, because placement,
 * hit-testing and z-order are all unaffected by a surface being invisible.
 *
 * That shipped. The `/date` calendar was created with `className = "ui-card
 * date-picker"` and its own stylesheet composed the recipe by not restating
 * it, on the strength of a `.ui-card` class that did not exist. The picker
 * drew as a bare grid of numbers over the prose, and its e2e suite, which
 * hit-tests the popup's corner with `elementFromPoint`, passed: a transparent
 * element is still the element at that point.
 *
 * Scope is the `ui-` prefix and nothing wider. Those names are a published
 * vocabulary with one definition site, so "does this resolve" has an answer;
 * a component's own classes are local and prove nothing by being absent from
 * a shared file.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const WEBVIEW_DIR = join(__dirname, "..");

function walk(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === "__tests__" || name === "node_modules") { continue; }
        const path = join(dir, name);
        if (statSync(path).isDirectory()) { walk(path, out); } else { out.push(path); }
    }
    return out;
}

const FILES = walk(WEBVIEW_DIR);

/** Every `ui-*` class named anywhere in a source file, with where it was named. */
function namedPrimitives(): Map<string, string[]> {
    const found = new Map<string, string[]>();
    for (const file of FILES.filter((f) => f.endsWith(".ts"))) {
        const text = readFileSync(file, "utf8");
        // Any string literal holding ui- names, which covers `className =`,
        // `classList.add(...)`, a `class="..."` inside an HTML template, and
        // the arrays some components build their class lists from. Broad on
        // purpose: a name is worth checking wherever it is written down, and
        // a false positive here is a class that exists anyway.
        for (const literal of text.matchAll(/["'`]([^"'`\n]*\bui-[a-z0-9-]+[^"'`\n]*)["'`]/g)) {
            for (const cls of literal[1].split(/\s+/)) {
                if (!/^ui-[a-z0-9-]+$/.test(cls)) { continue; }
                const where = found.get(cls) ?? [];
                where.push(relative(WEBVIEW_DIR, file));
                found.set(cls, where);
            }
        }
    }
    return found;
}

/** CSS with its comments removed, so a name mentioned in prose is not a rule. */
function withoutComments(css: string): string {
    return css.replace(/\/\*[\s\S]*?\*\//g, " ");
}

/** Every `ui-*` class a rule in webview CSS actually selects. */
function definedPrimitives(): Set<string> {
    const defined = new Set<string>();
    for (const file of FILES.filter((f) => f.endsWith(".css"))) {
        // A SELECTOR, which means a `{` has to follow, and outside a comment.
        // Neither is pedantry: the fix this guard was written for added a doc
        // block naming `.ui-card`, and a bare `\.(ui-[a-z0-9-]+)` match over
        // raw text counted that sentence as the rule. Deleting the real rule
        // then left the guard green, which is the guard failing at the one
        // job it has.
        for (const hit of withoutComments(readFileSync(file, "utf8"))
            .matchAll(/\.(ui-[a-z0-9-]+)[^{};]*\{/g)) {
            defined.add(hit[1]);
        }
    }
    // Stylesheets parked in a template literal are CSS too; the token guard
    // reads them for the same reason.
    for (const file of FILES.filter((f) => f.endsWith(".ts"))) {
        const text = readFileSync(file, "utf8");
        if (!/`[^`]*\{[^`]*:[^`]*\}/s.test(text)) { continue; }
        for (const hit of withoutComments(text).matchAll(/\.(ui-[a-z0-9-]+)[^{};]*\{/g)) {
            defined.add(hit[1]);
        }
    }
    return defined;
}

describe("chrome primitives", () => {
    const named = namedPrimitives();
    const defined = definedPrimitives();

    it("a ui- class a component composes should have a rule behind it", () => {
        const orphans = [...named.entries()]
            .filter(([cls]) => !defined.has(cls))
            .map(([cls, where]) => `${cls} (named in ${[...new Set(where)].join(", ")})`);
        expect(orphans).toEqual([]);
    });

    // The hole the first version of this guard had. A name is defined by a
    // RULE; the doc block above `.ui-card` in chrome.css names it in prose,
    // and counting that made the guard unable to see the very class it was
    // written for going missing.
    it("a ui- class named only in a CSS comment should not count as defined", () => {
        const commented = withoutComments(`
            /* .ui-imaginary is described here and nowhere else */
            .ui-real { color: red; }
        `);
        const found = new Set(
            [...commented.matchAll(/\.(ui-[a-z0-9-]+)[^{};]*\{/g)].map((m) => m[1]),
        );
        expect(found.has("ui-real")).toBe(true);
        expect(found.has("ui-imaginary")).toBe(false);
    });

    // The sweep has to have reached something, or it reports on a vocabulary
    // it never found. A regex that matched nothing passes the assertion above
    // with an empty list, which reads exactly like a clean tree.
    it("the sweep should have found the primitives it exists to check", () => {
        expect(named.size).toBeGreaterThanOrEqual(8);
        expect(defined.size).toBeGreaterThanOrEqual(8);
        for (const known of ["ui-btn", "ui-card", "ui-menu-row", "ui-heading"]) {
            expect(defined).toContain(known);
            expect([...named.keys()]).toContain(known);
        }
    });
});
