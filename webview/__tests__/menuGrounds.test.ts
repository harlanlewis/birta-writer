/**
 * CI guard for the two rules that keep floating chrome legible. Both encode a
 * defect that shipped, and neither is visible to the type checker or to a
 * jsdom test, because both are about what a THEME is free to put in a variable.
 *
 * 1. ONE GROUND. A floating surface reads `--ui-card-bg`, never a widget-ground
 *    theme token directly. Four such tokens exist, a theme may give all four
 *    different values, and reading them per surface is how one editor ended up
 *    painting the slash menu, the language picker and the page three different
 *    colors at once (VS Code Dark+: #252526 / #3c3c3c / #1e1e1e).
 *
 * 2. A GROUND NEVER TRAVELS WITHOUT ITS INK. A declaration block that paints a
 *    background from a token a theme may render as a saturated accent must
 *    declare `color` in the same block. The slash menu's focused row took the
 *    suggest-widget selection and kept the resting ink, which is fine while a
 *    theme washes that selection at 8% alpha and is 1.75:1 the moment one
 *    paints it solid (VS Code Light+ paints it #0060C0).
 *
 * Both rules read CSS wherever it is authored — `.css` files and the CSS that
 * lives in `.ts` — through the same extractor the radius and color guards use.
 *
 * Exemption for rule 1 is a same-line `/* menu-ground-ok: <reason> *\/`
 * annotation with a non-empty reason, the idiom `noColorLiterals.test.ts`
 * already established. Rule 2 has no exemption: a block that sets one of those
 * grounds and means to keep the inherited ink can say so in one line
 * (`color: inherit`), and saying so is the point.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, dirname, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { cssSourcesInTypeScript } from "./helpers/cssSources";

const webviewRoot = join(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Theme tokens that name the ground of a FLOATING surface. `--ui-card-bg` is
 * defined from one of them, in chrome.css, and every other surface composes
 * that. Note what is NOT here: `list.hoverBackground` and the selection tokens
 * are row STATES, not grounds, and rule 2 governs those instead.
 */
const WIDGET_GROUND_VARS = [
    "--vscode-editorHoverWidget-background",
    "--vscode-editorSuggestWidget-background",
    "--vscode-editorWidget-background",
    "--vscode-dropdown-background",
];

/**
 * Tokens a theme is free to paint as a saturated fill rather than a wash. Each
 * is a background whose ink cannot be assumed — hence rule 2. `list.hover*` is
 * deliberately absent: our menus mix their own hover wash from the ground
 * (`--ui-menu-hover-bg`), so it can never invert.
 */
const FILL_VARS = [
    "--ui-menu-selected-bg",
    "--vscode-list-activeSelectionBackground",
    "--vscode-editorSuggestWidget-selectedBackground",
    "--vscode-quickInputList-focusBackground",
    "--vscode-menu-selectionBackground",
    "--vscode-button-background",
    "--vscode-button-secondaryBackground",
];

/**
 * Rule 2 asks about MENU ROWS, matched on the last compound of the selector.
 * The same fill tokens legitimately paint things with no text in them at all —
 * a toggle's track, a checkbox's box, a filled button whose resting rule
 * already carries the pair — and demanding a `color` there would be asking for
 * a declaration with nothing to color.
 *
 * Last compound, not the whole selector: `.tb-switch-item--on .tb-switch`
 * paints the switch, not the row, and only the subject of the selector says
 * which.
 */
const ROW_SELECTOR_RE = /-(?:item|row)(?:--[\w-]+)?(?:[:.[]|$)/;

const EXEMPT_RE = /\/\*\s*menu-ground-ok:\s*[^\s*][\s\S]*?\*\//;

function collectFiles(dir: string, out: string[] = []): string[] {
    for (const name of readdirSync(dir)) {
        if (name === "__tests__" || name === "__mocks__") continue;
        const full = join(dir, name);
        if (statSync(full).isDirectory()) collectFiles(full, out);
        else if (/\.(ts|css)$/.test(name)) out.push(full);
    }
    return out;
}

interface Unit {
    file: string;
    text: string;
    startLine: number;
}

/**
 * Every unit both rules scan: `.css` files, plus the CSS authored in `.ts`.
 *
 * Extracted so the sweep's REACH can be asserted. Both rules report by
 * returning an empty array and the tree is clean, so disconnecting either half
 * is entirely silent — a test over the returned violations cannot tell a clean
 * scan from an absent one. A test over the INPUTS can (noColorLiterals.test.ts
 * learned exactly this, MAR-260).
 */
function scanUnits(): Unit[] {
    const units: Unit[] = [];
    for (const file of collectFiles(webviewRoot)) {
        if (!file.endsWith(".css")) continue;
        units.push({
            file: relative(webviewRoot, file).split(/[\\/]/).join("/"),
            text: readFileSync(file, "utf8"),
            startLine: 1,
        });
    }
    for (const source of cssSourcesInTypeScript(webviewRoot)) {
        units.push({ file: source.file, text: source.text, startLine: source.startLine });
    }
    return units;
}

/**
 * The declarations belonging to the block that encloses `index`, excluding any
 * NESTED block's declarations. Native CSS nesting is used throughout the tree,
 * so "everything up to the next `}`" would read a child's declarations as the
 * parent's and vice versa.
 */
function enclosingBlockDeclarations(text: string, index: number): string {
    let depth = 0;
    let start = -1;
    for (let i = index; i >= 0; i--) {
        const ch = text[i];
        if (ch === "}") depth++;
        else if (ch === "{") {
            if (depth === 0) {
                start = i + 1;
                break;
            }
            depth--;
        }
    }
    if (start < 0) return "";
    let own = "";
    depth = 0;
    for (let i = start; i < text.length; i++) {
        const ch = text[i];
        if (ch === "{") depth++;
        else if (ch === "}") {
            if (depth === 0) break;
            depth--;
        } else if (depth === 0) own += ch;
    }
    return own;
}

/** The selector prelude of the block enclosing `index`, comments stripped. */
function enclosingSelector(text: string, index: number): string {
    let depth = 0;
    let open = -1;
    for (let i = index; i >= 0; i--) {
        const ch = text[i];
        if (ch === "}") depth++;
        else if (ch === "{") {
            if (depth === 0) {
                open = i;
                break;
            }
            depth--;
        }
    }
    if (open < 0) return "";
    const start = Math.max(
        text.lastIndexOf("}", open - 1),
        text.lastIndexOf("{", open - 1),
        text.lastIndexOf(";", open - 1),
    );
    return text.slice(start + 1, open).replace(/\/\*[\s\S]*?\*\//g, "").trim();
}

/** True when the selector's subject reads as a menu row. */
function selectsAMenuRow(selector: string): boolean {
    return selector
        .split(",")
        .map((s) => s.trim().split(/\s+|>/).filter(Boolean).pop() ?? "")
        .some((subject) => ROW_SELECTOR_RE.test(subject));
}

function lineOf(source: Unit, index: number): number {
    return source.startLine + source.text.slice(0, index).split("\n").length - 1;
}

function unsharedGrounds(units = scanUnits()): string[] {
    const violations: string[] = [];
    for (const source of units) {
        source.text.split("\n").forEach((line, i) => {
            if (EXEMPT_RE.test(line)) return;
            // The one place a widget ground is read on purpose.
            if (/--ui-card-bg\s*:/.test(line)) return;
            for (const v of WIDGET_GROUND_VARS) {
                if (line.includes(v)) violations.push(`${source.file}:${source.startLine + i}  ${v}`);
            }
        });
    }
    return violations.sort();
}

describe("floating chrome paints one ground", () => {
    it("a widget-ground theme token outside the --ui-card-bg definition should be reported", () => {
        expect(unsharedGrounds()).toEqual([]);
    });

    it("a menu reaching past --ui-card-bg for its own ground should be reported", () => {
        const regressed = [
            {
                file: "probe.css",
                startLine: 1,
                text: ".slash-menu {\n    background: var(--vscode-editorSuggestWidget-background);\n}\n",
            },
        ];
        expect(unsharedGrounds(regressed)).toEqual([
            "probe.css:2  --vscode-editorSuggestWidget-background",
        ]);
    });

    it("an annotated exception with a reason should not be reported", () => {
        const annotated = [
            {
                file: "probe.css",
                startLine: 1,
                text: "select option {\n    background: var(--vscode-dropdown-background); /* menu-ground-ok: drawn by the OS */\n}\n",
            },
        ];
        expect(unsharedGrounds(annotated)).toEqual([]);
    });

    // An empty reason exempts nothing — the annotation carries the "why" or it
    // is not an annotation (the idiom noColorLiterals.test.ts established).
    it("an exemption annotation with no reason should still be reported", () => {
        const bare = [
            {
                file: "probe.css",
                startLine: 1,
                text: "select option {\n    background: var(--vscode-dropdown-background); /* menu-ground-ok: */\n}\n",
            },
        ];
        expect(unsharedGrounds(bare)).toEqual([
            "probe.css:2  --vscode-dropdown-background",
        ]);
    });
});

describe("both rules reach every place CSS is authored", () => {
    // Both rules report by returning an empty array, so silently scanning
    // nothing is indistinguishable from scanning a clean tree. Assert the
    // INPUTS (noColorLiterals.test.ts, MAR-260).
    it("the sweep should cover both .css files and CSS authored in .ts", () => {
        const files = scanUnits().map((u) => u.file);
        expect(files.filter((f) => f.endsWith(".css")).length).toBeGreaterThan(10);
        expect(files.filter((f) => f.endsWith(".ts")).length).toBeGreaterThan(0);
    });
});

function rowFillsWithoutInk(units = scanUnits()): string[] {
    const violations: string[] = [];
    for (const source of units) {
        const text = source.text;
        for (const v of FILL_VARS) {
            const re = new RegExp(`background(?:-color)?\\s*:[^;{}]*${v.replace(/-/g, "\\-")}`, "g");
            for (const m of text.matchAll(re)) {
                if (!selectsAMenuRow(enclosingSelector(text, m.index!))) continue;
                const block = enclosingBlockDeclarations(text, m.index!);
                if (!/(^|[;\s])color\s*:/.test(block)) {
                    violations.push(`${source.file}:${lineOf(source, m.index!)}  ${v}`);
                }
            }
        }
    }
    return violations.sort();
}

describe("a fill ground never travels without its ink", () => {
    it("a menu row filled from an accent-capable token with no color in the same block should be reported", () => {
        expect(rowFillsWithoutInk()).toEqual([]);
    });

    // The rule reports by returning an empty array and the tree is clean, so it
    // passes just as happily when it has stopped matching anything at all. This
    // is the shipped defect, verbatim, fed back through the same scanner.
    it("the slash menu's original unpaired focused row should be reported", () => {
        const regressed = [
            {
                file: "probe.css",
                startLine: 1,
                text: ".slash-menu-item {\n" +
                    "    &.slash-menu-item--focused {\n" +
                    "        background: var(--vscode-editorSuggestWidget-selectedBackground);\n" +
                    "    }\n" +
                    "}\n",
            },
        ];
        expect(rowFillsWithoutInk(regressed)).toEqual([
            "probe.css:3  --vscode-editorSuggestWidget-selectedBackground",
        ]);
    });

    it("the same row WITH its ink should not be reported", () => {
        const paired = [
            {
                file: "probe.css",
                startLine: 1,
                text: ".slash-menu-item--focused {\n" +
                    "    background: var(--ui-menu-selected-bg);\n" +
                    "    color: var(--ui-menu-selected-ink);\n" +
                    "}\n",
            },
        ];
        expect(rowFillsWithoutInk(paired)).toEqual([]);
    });

    // A fill token on something with no text in it is not this rule's business.
    it("a toggle track filled from the button token should not be reported", () => {
        const toggle = [
            {
                file: "probe.css",
                startLine: 1,
                text: ".tb-switch-item--on .tb-switch {\n    background: var(--vscode-button-background);\n}\n",
            },
        ];
        expect(rowFillsWithoutInk(toggle)).toEqual([]);
    });
});
