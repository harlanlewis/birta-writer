/**
 * keymapChords.ts — every hardcoded chord in the webview, recorded ONCE as
 * data, with the key-leak guard's claim decision for each.
 *
 * THE CLAIM RULE ITSELF IS STATED IN ONE PLACE: the header of
 * `webview/keyboardShortcuts.ts`. Read it before editing this table — the
 * short form is "claimed iff the webview owns the chord outright, with no
 * state in which we deliberately hand the key back to the platform".
 *
 * Two tests derive from this table, so a chord cannot be added, removed, or
 * misclassified without one of them failing:
 *   - `shared/__tests__/noHardcodedKeybindings.test.ts` uses it as the
 *     source-scan allowlist (a new chord literal in webview source fails
 *     until it is listed here, which forces the claim decision);
 *   - `webview/__tests__/keyboardShortcuts.test.ts` drives the real guard
 *     with one synthesized event per chord per platform, so the recorded
 *     decision is checked against what the guard actually does.
 *
 * This is a test fixture, not product code: the guard stays a flat runtime
 * table (`CLAIMED_SHORTCUTS`) rather than deriving itself from the keymaps,
 * because the claim decision is NOT a property of a keymap table — it
 * depends on whether the bound command deliberately returns false in some
 * state, which lives in the command body. Deriving would mean annotating
 * every binding with claim metadata and shipping that metadata in the launch
 * bundle, to relocate a judgement rather than remove it.
 */

/**
 * The guard's decision for one chord.
 * `claimed: "mac" | "win"` is for the platform-split chords (the chord
 * itself only exists on that platform); `false` requires naming the state in
 * which the binding hands the key back.
 */
export type ChordClaim =
    | { readonly claimed: "always" | "mac" | "win" }
    | { readonly claimed: false; readonly fallsThrough: string };

/**
 * ProseMirror keymap chords, per file. Every entry here is hardcoded rather
 * than contributed because it must be handled synchronously at the keydown —
 * see each file's header, and the parity audit in `keyboardShortcuts.ts`.
 */
export const KEYMAP_CHORDS: Readonly<Record<string, Readonly<Record<string, ChordClaim>>>> = {
    "webview/plugins/blockKeys.ts": {
        // Move / duplicate the block range: owned outright, and the comment
        // in blockKeys' keymap spells out why (a refused move still consumes,
        // so the chord's native default never fires mid-gesture).
        "Alt-ArrowUp": { claimed: "always" },
        "Alt-ArrowDown": { claimed: "always" },
        "Shift-Alt-ArrowUp": { claimed: "always" },
        "Shift-Alt-ArrowDown": { claimed: "always" },
        // The Mod+A escalation ladder. Claimed by the guard's own content
        // scope check, not by CLAIMED_SHORTCUTS: inside content the key is
        // always handled (ladder, table select-all, or codeBlockSelectAll),
        // and letting it leak fires the host's execCommand('selectAll').
        "Mod-a": { claimed: "always" },
        "Shift-ArrowUp": {
            claimed: false,
            fallsThrough:
                "a plain text selection — extendBlockSelection returns false so " +
                "native character-wise extension runs",
        },
        "Shift-ArrowDown": {
            claimed: false,
            fallsThrough:
                "a plain text selection — extendBlockSelection returns false so " +
                "native character-wise extension runs",
        },
        "Mod-Shift-ArrowUp": {
            claimed: false,
            fallsThrough:
                "a caret or text selection — selectToDocEdge returns false so the " +
                "platform's native select-to-document-edge runs",
        },
        "Mod-Shift-ArrowDown": {
            claimed: false,
            fallsThrough:
                "a caret or text selection — selectToDocEdge returns false so the " +
                "platform's native select-to-document-edge runs",
        },
    },
    "webview/plugins/formatKeymap.ts": {
        "Mod-b": { claimed: "always" },
        "Mod-i": { claimed: "always" },
        "Mod-e": { claimed: "always" },
        "Mod-Shift-x": { claimed: "always" },
    },
    "webview/plugins/history.ts": {
        "Mod-z": { claimed: "always" },
        "Mod-Shift-z": { claimed: "always" },
        "Mod-y": { claimed: "always" },
    },
    // headingFold's reveal guard shares insertParagraph's chord: it never
    // consumes the key (it only unfolds first), so it changes nothing about
    // the claim — Mod-Enter is owned outright either way.
    "webview/plugins/headingFold/foldCommands.ts": {
        "Mod-Enter": { claimed: "always" },
    },
    "webview/plugins/insertParagraph.ts": {
        "Mod-Enter": { claimed: "always" },
        "Mod-Shift-Enter": { claimed: "always" },
    },
    "webview/plugins/htmlLivePairs.ts": {
        // Opens the HTML source panel when the selection is a NodeSelection
        // on an html atom; declines everywhere else, falling through to
        // insertParagraph's binding above — which owns the chord's claim
        // decision, so the recorded claim matches its entry.
        "Mod-Enter": { claimed: "always" },
    },
    "webview/plugins/list.ts": {
        "Mod-Backspace": {
            claimed: false,
            fallsThrough:
                "anywhere but the start of a list item — backspaceAtItemStart " +
                "returns false so the DOM's own delete-to-line-start runs",
        },
    },
    // Platform-split by design (mirroring the built-in editor), so each chord
    // is claimed only on the platform where it exists.
    "webview/plugins/smartSelect.ts": {
        "Ctrl-Shift-Cmd-ArrowLeft": { claimed: "mac" },
        "Ctrl-Shift-Cmd-ArrowRight": { claimed: "mac" },
        "Shift-Alt-ArrowLeft": { claimed: "win" },
        "Shift-Alt-ArrowRight": { claimed: "win" },
    },
    "webview/plugins/tableKeymap.ts": {
        "Shift-Tab": {
            claimed: false,
            fallsThrough:
                "outside a table — the binding returns false so Shift+Tab keeps " +
                "native focus traversal",
        },
    },
};

/**
 * `kbd()` tooltip / cheatsheet labels: chord literals that are DISPLAYED,
 * never bound. A label may only name a fixed local key — the webview cannot
 * query the user's effective binding, so printing a rebindable command's
 * default could simply be wrong.
 */
export const LABEL_CHORDS: Readonly<Record<string, readonly string[]>> = {
    // Bar-local keys inside the find bar's own inputs.
    "webview/components/findBar/index.ts": ["Mod-Enter", "Shift-Enter"],
    // Panel-local keys inside the block source textarea, and the hint that
    // names them. Mod-/ is the CONTRIBUTED birta.editor.editBlockSource
    // chord, accepted here only as a second way to close a panel that is
    // already open; the hint never prints it, because the user may have
    // rebound the command and the webview cannot read their binding.
    "webview/components/blockSource/index.ts": ["Mod-Enter"],
    // The cheatsheet overlay prints ONLY the fixed typing-level grammar
    // above; rebindable commands are listed by name with no keys.
    "webview/components/shortcutsHelp/index.ts": [
        "Alt-ArrowDown",
        "Alt-ArrowUp",
        "Ctrl-Shift-Cmd-ArrowLeft",
        "Ctrl-Shift-Cmd-ArrowRight",
        "Mod-Enter",
        "Mod-Shift-Enter",
        "Mod-Shift-x",
        "Mod-Shift-z",
        "Mod-a",
        "Mod-b",
        "Mod-e",
        "Mod-i",
        "Mod-y",
        "Mod-z",
        "Shift-Alt-ArrowDown",
        "Shift-Alt-ArrowLeft",
        "Shift-Alt-ArrowRight",
        "Shift-Alt-ArrowUp",
        "Shift-ArrowDown",
        "Shift-ArrowUp",
        "Shift-Tab",
    ],
    "webview/components/selectionToolbar/index.ts": ["Mod-Shift-x", "Mod-b", "Mod-e", "Mod-i"],
    "webview/components/toolbar/index.ts": ["Mod-Shift-x", "Mod-b", "Mod-e", "Mod-i"],
};

/** Every chord literal allowed in webview source, per file, sorted. */
export function chordAllowlist(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [file, chords] of Object.entries(KEYMAP_CHORDS)) {
        out[file] = [...(out[file] ?? []), ...Object.keys(chords)];
    }
    for (const [file, chords] of Object.entries(LABEL_CHORDS)) {
        out[file] = [...(out[file] ?? []), ...chords];
    }
    for (const file of Object.keys(out)) {
        out[file] = [...new Set(out[file])].sort();
    }
    return out;
}
