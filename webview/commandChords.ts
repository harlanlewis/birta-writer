/**
 * webview/commandChords.ts
 *
 * THE one answer to "what key runs this command on this surface", for every
 * piece of chrome that prints one.
 *
 * The rule it exists to apply uniformly: a printed key must be one that
 * cannot be wrong. The webview cannot query VS Code's effective keybindings,
 * so a rebindable command's default is a guess, and a tooltip that names a
 * key the user has rebound is worse than one that names none. Only two
 * sources answer that test, and both are here:
 *
 *   1. the HOST's own bindings, which it declares (shared/hostProfile.ts).
 *      A standalone app whose MENU is the binding knows its keys exactly, so
 *      Birta Writer Jot's ⌘K is printable where VS Code's is not.
 *   2. the editor's own fixed ProseMirror keymap, which is the same on every
 *      surface and is not rebindable anywhere.
 *
 * Everything else resolves to null, and a caller prints the plain label. That
 * is the CONSISTENCY this module is for: before it, four tooltips carried a
 * chord and thirty did not, because each site made the judgement separately
 * and only the four obvious ones got made. One resolver means a site cannot
 * make a different call than its neighbour, and a host that grows a binding
 * lights up every surface at once.
 *
 * Guarded twice. No chord literal is spelled here at all: the editor's own are
 * `shared/fixedChords.ts`, so `noHardcodedKeybindings.test.ts` now expects NO
 * chord literal anywhere under `webview/` outside the keymaps themselves, and a
 * hand-written `kbd("Mod-…")` back in a component fails it.
 * `webview/__tests__/commandChords.test.ts` holds the resolution order and the
 * never-guess rule.
 */
import type { EditorCommandId } from "../shared/editorCommands";
import { FIXED_COMMAND_CHORDS } from "../shared/fixedChords";
import { hostShortcuts } from "../shared/hostProfile";
import { kbd } from "@/i18n";

/**
 * The chord for `id` in ProseMirror notation, or null where no source can
 * answer without guessing.
 *
 * The host is asked FIRST, because its binding is the one that actually
 * fires: where a host's menu carries a key equivalent, AppKit hands it to the
 * menu before the page ever sees the keydown, so the host's answer is the
 * true one even when the editor also binds the same chord.
 */
export function commandChord(id: EditorCommandId): string | null {
    const declared = hostShortcuts().find((s) => s.command === id);
    if (declared !== undefined) {
        return declared.keys;
    }
    return FIXED_COMMAND_CHORDS[id] ?? null;
}

/**
 * `label` with the command's chord in parentheses after it, or `label` alone
 * where there is no printable chord. The tooltip form every chrome surface
 * uses, so the spacing and the omission rule are decided once.
 *
 * Parenthesised for a reason that is not typographic: `createButton` derives an
 * icon button's `aria-label` from its tooltip and strips a trailing
 * parenthesised run (`webview/ui/dom.ts`), so this form gives a screen reader
 * "Bold" where the bare-space form gave it "Bold ⌘B" — a glyph run read out as
 * part of the name. The find bar's two labelled buttons already used this
 * shape; the four marks used the other one, which is how the difference stayed
 * invisible while only four controls printed anything.
 */
export function withChord(label: string, id: EditorCommandId): string {
    const chord = commandChord(id);
    return chord === null ? label : `${label} (${kbd(chord)})`;
}
