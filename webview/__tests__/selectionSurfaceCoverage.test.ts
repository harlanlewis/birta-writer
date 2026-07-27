/**
 * Exhaustiveness guard: EVERY selection surface can hand off a mode switch.
 *
 * sourceLineCoverage.test.ts guards the mapping layer (which source line a
 * position means). This guards the layer ABOVE it: where a user's selection
 * can LIVE. A NodeView can create a selection island — an editable
 * `role="textbox"` span (a callout/directive title), or read-only chrome
 * made selectable with `user-select: text` (the calc ledger) — where the
 * live selection exists only in the DOM and ProseMirror's own selection is
 * parked elsewhere, stale. getSwitchTarget must read such islands through
 * domChromeTarget (webview/index.ts), or a switch silently drops the user's
 * selection; the calc ledger and the title islands each shipped that bug.
 *
 * Any NEW island site found by these sweeps must be registered here with its
 * mapping story: how domChromeTarget reads it, or why it is out of a
 * switch's scope (mounted outside view.dom). Then pin the behavior in
 * e2e/modeSwitchSelection.
 */
import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const WEBVIEW = path.join(REPO_ROOT, "webview");

/**
 * Every file allowed to create a selection island, with the story of how a
 * mode switch reads selections made there.
 */
const ISLAND_REGISTRY: Record<string, string> = {
    "components/callout/index.ts":
        "title textbox → domChromeTarget's [role=\"textbox\"] path aligns onto the marker line",
    "components/directive/index.ts":
        "title textbox → domChromeTarget's [role=\"textbox\"] path aligns onto the marker line",
    "components/codeBlock/codeBlock.css":
        "calc ledger rows (user-select: text) → domChromeTarget's .calc-row path maps row → interior line",
    "components/linkPopup/linkPopup.css":
        "link popup URL text — mounted on document.body, OUTSIDE view.dom; not a switch surface",
};

/** Source patterns that create a selection island. */
const ISLAND_PATTERNS: Array<{ kind: string; re: RegExp; ext: string }> = [
    { kind: "editable textbox", re: /setAttribute\("role", "textbox"\)/, ext: ".ts" },
    { kind: "contentEditable island", re: /contentEditable = "(true|plaintext-only)"/, ext: ".ts" },
    { kind: "selectable chrome", re: /user-select:\s*text/, ext: ".css" },
];

const walk = (dir: string, files: string[] = []): string[] => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.name === "__tests__" || entry.name === "node_modules") continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full, files);
        else files.push(full);
    }
    return files;
};

describe("every selection island has a mode-switch story", () => {
    it("island-creating sites are registered with a mapping story", () => {
        const unregistered: string[] = [];
        const found = new Set<string>();
        for (const full of walk(WEBVIEW)) {
            const rel = path.relative(WEBVIEW, full);
            for (const { kind, re, ext } of ISLAND_PATTERNS) {
                if (!full.endsWith(ext)) continue;
                if (!re.test(fs.readFileSync(full, "utf8"))) continue;
                found.add(rel);
                if (!(rel in ISLAND_REGISTRY)) {
                    unregistered.push(`${rel} (${kind})`);
                }
            }
        }
        expect(
            unregistered,
            "Selection islands with NO mode-switch story. A selection made there " +
                "exists only in the DOM — ProseMirror's selection is parked and stale — " +
                "so getSwitchTarget must read it via domChromeTarget (webview/index.ts). " +
                "Map it there (or establish it's outside view.dom), register the file in " +
                "ISLAND_REGISTRY with the story, and pin it in e2e/modeSwitchSelection.",
        ).toEqual([]);
        // Sanity: the sweep still finds the known islands — if these move, the
        // registry (and this guard's patterns) must move with them.
        expect(found).toContain("components/callout/index.ts");
        expect(found).toContain(path.join("components", "codeBlock", "codeBlock.css"));
        // No registry entry goes stale: every registered file still trips a pattern.
        expect([...Object.keys(ISLAND_REGISTRY)].filter((rel) => !found.has(rel))).toEqual([]);
    });

    it("domChromeTarget still handles the selectors the registry's stories cite", () => {
        // Renaming .calc-row or dropping the textbox path in webview/index.ts
        // would silently orphan the registry's "mapped" stories.
        const indexSource = fs.readFileSync(path.join(WEBVIEW, "index.ts"), "utf8");
        expect(indexSource).toContain('closest(".calc-row")');
        expect(indexSource).toContain("closest('[role=\"textbox\"]')");
        expect(indexSource).toContain("closest('[contenteditable=\"false\"]')");
    });
});
