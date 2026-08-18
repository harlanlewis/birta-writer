/**
 * Policy guard: no NEW hardcoded keyboard shortcuts in the webview.
 *
 * Editor shortcuts must be contributed (user-rebindable) VS Code keybindings
 * routed through commands (shared/editorCommands.ts + package.json), not
 * keydown handlers that match modifier chords by hand — a hardcoded chord is
 * invisible to the user's keybinding configuration.
 *
 * Two scans enforce this, each against an explicit allowlist:
 *   1. Files reading `metaKey`/`ctrlKey`/`altKey`: every current use is either the
 *      key-leak guard, a typing-level ProseMirror scope check, an
 *      input-local key, or a mouse-modifier check. A new file matching
 *      modifiers fails here until it is consciously allowlisted (with a
 *      reason) or — almost always the right fix — rewritten as a
 *      contributed keybinding.
 *   2. ProseMirror keymap chord literals ("Mod-b" etc.) and kbd() tooltip
 *      labels: pinned per file against `keymapChords.ts`, so adding a chord
 *      to a keymap (or printing a shortcut in a tooltip, which must never
 *      name a rebindable command's key) is a deliberate, reviewed change —
 *      and, for a keymap chord, one that also records whether the key-leak
 *      guard claims it.
 *
 * The behavioral complement lives in keyboardShortcuts.test.ts: it drives the
 * real guard with one event per chord in that same table, so a recorded claim
 * decision can never drift from what the guard does, and the claimed-set
 * exhaustiveness tests fail when the guard starts claiming a chord that
 * should stay visible to the workbench.
 */
import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import { walkFiles } from "./cjkScanner";
import { chordAllowlist } from "./keymapChords";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

/** webview/**\/*.ts, tests excluded, as repo-relative posix paths. */
function webviewSources(): string[] {
    return walkFiles(path.join(REPO_ROOT, "webview"), [".ts"], ["__tests__"])
        .map((f) => path.relative(REPO_ROOT, f).split(path.sep).join("/"))
        .sort();
}

function read(rel: string): string {
    return fs.readFileSync(path.join(REPO_ROOT, rel), "utf8");
}

/** Strip block comments and whitespace-preceded line comments. */
function stripComments(source: string): string {
    return source
        .replace(/\/\*[\s\S]*?\*\//g, "")
        .replace(/(^|\s)\/\/.*$/gm, "$1");
}

describe("no hardcoded keybindings (modifier-chord scan)", () => {
    /**
     * Files allowed to read metaKey/ctrlKey, and why. Everything here is
     * NOT a rebindable-shortcut candidate; before extending this list,
     * check whether the change should be a contributed keybinding instead.
     */
    const MODIFIER_ALLOWLIST: Record<string, string> = {
        "webview/keyboardShortcuts.ts":
            "the workbench key-leak guard itself (claims typing-level ProseMirror combos)",
        "webview/utils/inputUndo.ts":
            "local undo/redo inside overlay inputs — VS Code intercepts Cmd+Z before native inputs see it",
        "webview/components/findBar/index.ts":
            "bar-local input keys (Mod+Enter = replace all inside the replace input)",
        "webview/components/htmlView/index.ts":
            "panel-local input keys (Mod+Enter = commit, Mod+/ = commit and hand off to the block " +
            "source panel, inside the HTML source textarea) — findBar's idiom",
        "webview/components/blockSource/index.ts":
            "panel-local input keys (Mod+Enter and Mod+/ = commit inside the block source textarea) — " +
            "htmlView's idiom; the OPENING chord is the contributed birta.editor.editBlockSource keybinding",
        "webview/plugins/headingEmptyDelete.ts":
            "bails out when modifiers are held — typing-level Backspace handling, not a chord",
        "webview/ui/escapeLayers.ts":
            "bails out when modifiers are held — isBareEscape, the one plain-Escape guard every transient and input-owned surface calls (blockKeys, the findings popup, the image dialog, titles, front matter), so none of them acts on modifier-Escape; not a chord",
        "webview/plugins/mathInlineEdit.ts":
            "bails out when modifiers are held — typing-level arrow/Backspace boundary handling at a formula's edge, not a chord",
        "webview/plugins/wikiLinkEdit.ts":
            "bails out when modifiers are held — typing-level arrow/Backspace boundary handling at a wikilink's edge, not a chord",
        "webview/plugins/codeBlockSelectAll.ts":
            "scopes the editor's Mod+A inside code blocks — typing-level, must run synchronously",
        "webview/components/callout/index.ts":
            "scopes Mod+A inside the title's contenteditable island — native select-all escapes into the document",
        "webview/components/directive/index.ts":
            "scopes Mod+A inside the title's contenteditable island — native select-all escapes into the document",
        "webview/plugins/tableCellClickFix.ts":
            "mouse-modifier check (Ctrl/Cmd+click), not a keybinding",
        "webview/components/codeBlock/langPicker.ts":
            "plain-key bail in the language-search keydown scope check, not a chord",
        "webview/components/codeBlock/diagramPane.ts":
            "Ctrl+wheel pinch-zoom on the inline diagram (mouse modifier), not a keybinding",
        "webview/components/codeBlock/lightbox.ts":
            "Ctrl+wheel pinch-zoom on the fullscreen diagram (mouse modifier), not a keybinding",
        "webview/components/linkPopup/index.ts":
            "Cmd/Ctrl+click to open a link (mouse), not a keybinding",
        "webview/components/pathLink/index.ts":
            "Cmd/Ctrl+click to open a link (mouse), not a keybinding",
        "webview/plugins/embed.ts":
            "Cmd/Ctrl+click on a card body to open the link it draws (mouse), not a keybinding",
        "webview/plugins/headingFold/foldGutter.ts":
            "Alt+click recursive fold (mouse modifier), not a keybinding",
        "webview/plugins/headingSticky.ts":
            "Alt+click recursive fold on the pinned heading's chevron (mouse modifier), not a keybinding",
    };

    // `getModifierState("Meta"|"Control")` is the same read by another name and
    // was invisible here: a chord matched that way is just as unrebindable.
    // `altKey` is here for the same reason, and its absence was a real hole
    // rather than a decision: `getModifierState("Alt")` was already caught
    // while the direct property read was not, so a file reading ONLY `altKey`
    // passed a guard that never looked at it. Every reader in the tree was
    // allowlisted for `metaKey`/`ctrlKey` anyway, which is why the hole stayed
    // invisible until one arrived that reads Alt alone.
    const MODIFIER_READ_RE = /\b(metaKey|ctrlKey|altKey|getModifierState)\b/;

    it("the modifier matcher should flag every way a chord modifier is read", () => {
        expect(MODIFIER_READ_RE.test("if (e.metaKey || e.ctrlKey) {")).toBe(true);
        expect(MODIFIER_READ_RE.test('e.getModifierState("Meta")')).toBe(true);
        // The read that used to slip through: Alt alone, as a property.
        expect(MODIFIER_READ_RE.test("if (e.altKey) {")).toBe(true);
        expect(MODIFIER_READ_RE.test('if (e.key === "Escape") {')).toBe(false);
    });

    it("only allowlisted files may read metaKey/ctrlKey", () => {
        const found = webviewSources().filter((rel) => MODIFIER_READ_RE.test(read(rel)));
        expect(
            found,
            "A webview module started reading keyboard modifiers. Hardcoded " +
                "chords are invisible to the user's keybinding configuration — " +
                "contribute a keybinding (shared/editorCommands.ts + " +
                "package.json) instead, or allowlist the file here with a reason.",
        ).toEqual(Object.keys(MODIFIER_ALLOWLIST).sort());
    });
});

describe("no hardcoded keybindings (chord-literal scan)", () => {
    /**
     * Chord string literals allowed per file — ProseMirror keymap bindings
     * that must be handled synchronously in the webview, plus kbd() tooltip
     * labels for exactly those fixed keys. Tooltips must never print a
     * rebindable command's default (the webview cannot query the user's
     * effective binding, so it could be wrong).
     *
     * Derived from `keymapChords.ts`, which is also where each keymap chord's
     * key-leak-guard claim decision is recorded — so allowlisting a new chord
     * is the same edit as deciding whether the guard claims it, and
     * keyboardShortcuts.test.ts then checks that decision against the real
     * guard. Why each chord is hardcoded rather than contributed lives in the
     * owning plugin's header; the claim rule itself lives in exactly one
     * place, `webview/keyboardShortcuts.ts`.
     */
    const CHORD_ALLOWLIST = chordAllowlist();

    const CHORD_RE = /["'](?:Mod|Ctrl|Cmd|Meta|Alt|Shift)-[\w-]+["']/g;

    it("only allowlisted chord literals may appear in webview source", () => {
        const found: Record<string, string[]> = {};
        for (const rel of webviewSources()) {
            const matches = stripComments(read(rel)).match(CHORD_RE);
            if (matches) {
                found[rel] = [...new Set(matches.map((m) => m.slice(1, -1)))].sort();
            }
        }
        expect(
            found,
            "A chord literal (keymap binding or tooltip shortcut label) was " +
                "added or removed. New shortcuts should be contributed " +
                "keybindings; tooltip labels may only name fixed local keys. " +
                "Only for a typing-level ProseMirror keymap, add it to " +
                "keymapChords.ts — which also forces the key-leak guard's " +
                "claim decision (see the rule in webview/keyboardShortcuts.ts).",
        ).toEqual(CHORD_ALLOWLIST);
    });
});
