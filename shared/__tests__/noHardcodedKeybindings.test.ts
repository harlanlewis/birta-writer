/**
 * Policy guard: no NEW hardcoded keyboard shortcuts in the webview.
 *
 * Editor shortcuts must be contributed (user-rebindable) VS Code keybindings
 * routed through commands (shared/editorCommands.ts + package.json), not
 * keydown handlers that match modifier chords by hand — a hardcoded chord is
 * invisible to the user's keybinding configuration.
 *
 * Two scans enforce this, each against an explicit allowlist:
 *   1. Files reading `metaKey`/`ctrlKey`: every current use is either the
 *      key-leak guard, a typing-level ProseMirror scope check, an
 *      input-local key, or a mouse-modifier check. A new file matching
 *      modifiers fails here until it is consciously allowlisted (with a
 *      reason) or — almost always the right fix — rewritten as a
 *      contributed keybinding.
 *   2. ProseMirror keymap chord literals ("Mod-b" etc.) and kbd() tooltip
 *      labels: pinned per file, so adding a chord to a keymap (or printing
 *      a shortcut in a tooltip, which must never name a rebindable command's
 *      key) is a deliberate, reviewed change.
 *
 * The behavioral complement lives in keyboardShortcuts.test.ts: the
 * claimed-set exhaustiveness tests fail when the key-leak guard starts
 * claiming a chord that should stay visible to the workbench.
 */
import { describe, it, expect } from "vitest";
import * as path from "path";
import * as fs from "fs";
import { walkFiles } from "./cjkScanner";

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
        "webview/plugins/headingEmptyDelete.ts":
            "bails out when modifiers are held — typing-level Backspace handling, not a chord",
        "webview/plugins/blockKeys.ts":
            "bails out when modifiers are held — plain-Escape guard before the transient-surface layer check, not a chord",
        "webview/plugins/mathInlineEdit.ts":
            "bails out when modifiers are held — typing-level arrow/Backspace boundary handling at a formula's edge, not a chord",
        "webview/plugins/codeBlockSelectAll.ts":
            "scopes the editor's Mod+A inside code blocks — typing-level, must run synchronously",
        "webview/components/callout/index.ts":
            "scopes Mod+A inside the title's contenteditable island — native select-all escapes into the document",
        "webview/components/directive/index.ts":
            "scopes Mod+A inside the title's contenteditable island — native select-all escapes into the document",
        "webview/plugins/tableCellClickFix.ts":
            "mouse-modifier check (Ctrl/Cmd+click), not a keybinding",
        "webview/components/codeBlock/index.ts":
            "plain-key bail in a keydown scope check, Ctrl+wheel pinch-zoom, mouse modifiers",
        "webview/components/linkPopup/index.ts":
            "Cmd/Ctrl+click to open a link (mouse), not a keybinding",
        "webview/components/pathLink/index.ts":
            "Cmd/Ctrl+click to open a link (mouse), not a keybinding",
    };

    it("only allowlisted files may read metaKey/ctrlKey", () => {
        const found = webviewSources().filter((rel) =>
            /\b(metaKey|ctrlKey)\b/.test(read(rel)),
        );
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
     */
    const CHORD_ALLOWLIST: Record<string, string[]> = {
        // typing-level ProseMirror keymaps (see keyboardShortcuts.ts)
        // blockKeys: selection-state-conditional bindings — Shift+arrows
        // extend block-wise ONLY when the selection already spans whole
        // blocks and must fall through (return false) to native text
        // selection otherwise, which a contributed keybinding cannot do;
        // the Alt/Mod-Shift move chords share the same command layer and
        // stay PM-level with them. Mod-a is the escalation ladder (block
        // text → block → all blocks) and must fall through to baseKeymap's
        // selectAll in tables. Only the Shift-Alt duplicate chords are
        // claimed by the key-leak guard (content-scoped — they mutate the
        // document); the rest stay unclaimed: VS Code's own Alt+arrow /
        // Cmd+Shift+arrow defaults are editorTextFocus-scoped and inert
        // while a webview has focus.
        "webview/plugins/blockKeys.ts": [
            "Alt-ArrowDown",
            "Alt-ArrowUp",
            "Mod-Shift-ArrowDown",
            "Mod-Shift-ArrowUp",
            "Mod-a",
            "Shift-Alt-ArrowDown",
            "Shift-Alt-ArrowUp",
            "Shift-ArrowDown",
            "Shift-ArrowUp",
        ],
        "webview/plugins/formatKeymap.ts": ["Mod-Shift-x", "Mod-b", "Mod-e", "Mod-i"],
        "webview/plugins/history.ts": ["Mod-Shift-z", "Mod-y", "Mod-z"],
        // insertParagraph: Mod-Enter must beat the preset's exit-code-block
        // binding synchronously (registered before the presets, returning
        // false in those contexts); claimed by the key-leak guard.
        "webview/plugins/insertParagraph.ts": ["Mod-Enter", "Mod-Shift-Enter"],
        // smartSelect: chords collide with native contenteditable selection
        // extension and need synchronous default-suppression; platform-split
        // to mirror the built-in editor; claimed by the key-leak guard.
        "webview/plugins/smartSelect.ts": [
            "Ctrl-Shift-Cmd-ArrowLeft",
            "Ctrl-Shift-Cmd-ArrowRight",
            "Shift-Alt-ArrowLeft",
            "Shift-Alt-ArrowRight",
        ],
        "webview/plugins/tableKeymap.ts": ["Shift-Tab"],
        // kbd() tooltip labels naming fixed local keys only
        "webview/components/findBar/index.ts": ["Mod-Enter", "Shift-Enter"],
        "webview/components/selectionToolbar/index.ts": ["Mod-Shift-x", "Mod-b", "Mod-e", "Mod-i"],
        "webview/components/toolbar/index.ts": ["Mod-Shift-x", "Mod-b", "Mod-e", "Mod-i"],
    };

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
                "Update the allowlist only for typing-level ProseMirror keymaps.",
        ).toEqual(CHORD_ALLOWLIST);
    });
});
