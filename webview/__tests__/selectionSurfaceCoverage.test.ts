/**
 * Exhaustiveness guard: EVERY selection surface can hand off a mode switch.
 *
 * sourceLineCoverage.test.ts guards the mapping layer (which source line a
 * position means). This guards the layer ABOVE it: where a user's selection
 * can LIVE. A NodeView can create a selection island — an editable
 * `role="textbox"` span (a callout/directive title), read-only chrome
 * made selectable with `user-select: text` (the calc ledger), or a
 * `<textarea>`, which is one by construction — where the
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
    "readOnly.ts":
        "creates NO island of its own — it is the shared primitive the real island " +
        "creators call (markEditableIsland, MAR-53), so the contentEditable write the " +
        "sweep sees here lands on elements owned by callout, directive and frontmatter, " +
        "whose stories are the three entries below. Those files still trip the sweep on " +
        "their own role=\"textbox\" writes, so moving the write here did not narrow the " +
        "guard's reach; this entry exists so the primitive itself is accounted for " +
        "rather than silently exempt",
    "components/callout/index.ts":
        "title textbox → domChromeTarget's [role=\"textbox\"] path aligns onto the marker line",
    "components/directive/index.ts":
        "title textbox → domChromeTarget's [role=\"textbox\"] path aligns onto the marker line",
    "components/codeBlock/codeBlock.css":
        "calc ledger rows (user-select: text) → domChromeTarget's .calc-row path maps row → interior line",
    "components/linkPopup/linkPopup.css":
        "link popup URL text — mounted on document.body, OUTSIDE view.dom; not a switch surface",
    "components/frontmatter/index.ts":
        "metadata table cells and list chips (role=\"textbox\" + contenteditable), plus the raw-YAML " +
        "textarea (createRawEditor → panel.appendChild) — the panel is " +
        "inserted BEFORE #editor (renderFmContent's insertBefore(panel, editorEl)), so it lives " +
        "OUTSIDE view.dom and domChromeTarget bails at its view.dom.contains check; not a switch surface",
    "components/htmlView/index.ts":
        "the HTML source textarea (MAR-14) — a textarea's internal caret is invisible to " +
        "document.getSelection() by construction, and the panel only ever opens off a " +
        "NodeSelection ON the html atom itself (the opening click parks one; the Mod-Enter " +
        "opener requires one), so the parked ProseMirror selection IS the island's node and " +
        "a switch maps to the atom's own line; getSwitchTarget blurs an open panel before " +
        "reading (webview/index.ts), so the switch leaves on committed bytes even on the " +
        "in-webview chord path, where no natural blur precedes it. Pinned in e2e/htmlEdit.",
    "components/blockSource/index.ts":
        "the block source textarea (MAR-20) — a textarea's internal caret is invisible to " +
        "document.getSelection() by construction, and the panel only ever opens off a caret or " +
        "selection INSIDE the block it stands in for, so the parked ProseMirror selection is " +
        "still in that block and a switch maps to the block's own line; getSwitchTarget banks " +
        "an open panel before reading (webview/index.ts), as does the save flush " +
        "(messageHandlers.ts flushSave), so both leave on committed bytes even on the " +
        "in-webview command path, where no natural blur precedes them. Pinned in e2e/blockSource.",
    "ui/clipboard.ts":
        "the execCommand copy fallback's hidden textarea — created on document.body, focused, " +
        "copied and removed synchronously inside one call, so no selection outlives it; " +
        "not a switch surface",
    "components/codeBlock/nodeView.ts":
        "the copy button's execCommand fallback textarea — the same transient document.body " +
        "pattern as ui/clipboard.ts; not a switch surface",
    "components/codeBlock/lightbox.ts":
        "the fullscreen code editor's textarea, and the diagram lightbox's code-pane twin — both " +
        "live in an overlay mounted by document.body.appendChild(overlay), OUTSIDE view.dom, so " +
        "domChromeTarget bails at its view.dom.contains check; not a switch surface",
};

/**
 * Source patterns that create a selection island.
 *
 * These match SOURCE TEXT, so they must not be pinned to one quote style or
 * one spelling of the same DOM write — that is not a stricter rule, it is a
 * hole. Both `role="textbox"` sites in components/frontmatter/index.ts were
 * invisible to this guard for exactly that reason: the file uses single
 * quotes, and the old patterns hardcoded double ones. The guard read green
 * while two live islands went unregistered.
 */
const ISLAND_PATTERNS: Array<{ kind: string; re: RegExp; ext: string }> = [
    {
        kind: "editable textbox",
        re: /setAttribute\(\s*(['"])role\1\s*,\s*(['"])textbox\2\s*\)/,
        ext: ".ts",
    },
    {
        kind: "contentEditable island",
        // Both the property write and the attribute write — jsdom does not
        // reflect the property, so files that need focusability under test set
        // the attribute too (see bindFmCell).
        re: /contentEditable\s*=\s*(['"])(?:true|plaintext-only)\1|setAttribute\(\s*(['"])contenteditable\2\s*,\s*(['"])(?:true|plaintext-only)\3\s*\)/,
        ext: ".ts",
    },
    {
        kind: "textarea island",
        // A <textarea> is a selection island by construction: the live
        // selection is native and held by the element, and ProseMirror's own
        // selection is parked elsewhere. No pattern above can see one — a
        // textarea sets no role, no contentEditable, and needs no
        // `user-select` — so all five creation sites went unregistered while
        // this guard read green (MAR-262).
        re: /createElement\(\s*(['"])textarea\1\s*\)/,
        ext: ".ts",
    },
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
    // The sweep is only as wide as its patterns, and a pattern pinned to one
    // quote style is a silent hole (see the ISLAND_PATTERNS header). Prove each
    // spelling of the same DOM write is seen, and that read-only chrome is not.
    it("the island patterns should match both quote styles, both contenteditable spellings, and a textarea", () => {
        const textbox = ISLAND_PATTERNS[0]!.re;
        expect(textbox.test('el.setAttribute("role", "textbox");')).toBe(true);
        expect(textbox.test("el.setAttribute('role', 'textbox');")).toBe(true);
        expect(textbox.test('el.setAttribute("role", "button");')).toBe(false);

        const editable = ISLAND_PATTERNS[1]!.re;
        expect(editable.test('td.contentEditable = "true";')).toBe(true);
        expect(editable.test("td.contentEditable = 'true';")).toBe(true);
        expect(editable.test('td.contentEditable = "plaintext-only";')).toBe(true);
        expect(editable.test('td.setAttribute("contenteditable", "true");')).toBe(true);
        expect(editable.test("td.setAttribute('contenteditable', 'true');")).toBe(true);
        // Read-only chrome (contenteditable="false") is not a selection island.
        expect(editable.test('el.contentEditable = "false";')).toBe(false);
        expect(editable.test("el.setAttribute('contenteditable', 'false');")).toBe(false);

        const textarea = ISLAND_PATTERNS[2]!.re;
        expect(textarea.test('const ta = document.createElement("textarea");')).toBe(true);
        expect(textarea.test("const ta = document.createElement('textarea');")).toBe(true);
        // Other elements are not selection islands of their own accord.
        expect(textarea.test('document.createElement("input");')).toBe(false);
        expect(textarea.test('document.createElement("div");')).toBe(false);
    });

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
        // Single-quoted island writes are seen too — the case the patterns missed.
        expect(found).toContain(path.join("components", "frontmatter", "index.ts"));
        // …and textareas, which no other pattern can see (MAR-262).
        expect(found).toContain(path.join("ui", "clipboard.ts"));
        expect(found).toContain(path.join("components", "codeBlock", "lightbox.ts"));
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
