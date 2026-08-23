/**
 * The printable-chord resolver (webview/commandChords.ts).
 *
 * What these hold is the rule, not the table: a printed key must be one that
 * cannot be wrong, so the resolver answers from the host's own declaration or
 * from the editor's fixed keymap and NEVER from a contributed default. The
 * never-guess case is asserted against a command that HAS a shipped default
 * (`insertLink` is ⌘K in package.json) and must still resolve to nothing on a
 * host that has not declared it.
 */
import { describe, it, expect, afterEach } from "vitest";
import { commandChord, withChord } from "../commandChords";
import { createButton } from "../ui/dom";

interface HostWindow {
    __i18n?: { host?: { capabilities?: string[]; arrangements?: string[]; shortcuts?: unknown[] } };
}

/** Declare a host profile for one case, the way a shell's bootstrap does. */
function declareShortcuts(shortcuts: unknown[]): void {
    (globalThis as HostWindow).__i18n = {
        host: { capabilities: [], arrangements: [], shortcuts },
    };
}

afterEach(() => {
    delete (globalThis as HostWindow).__i18n;
});

describe("commandChord", () => {
    it("a fixed keymap command should resolve to its chord with no host declaration", () => {
        expect(commandChord("toggleBold")).toBe("Mod-b");
        expect(commandChord("toggleItalic")).toBe("Mod-i");
        expect(commandChord("toggleInlineCode")).toBe("Mod-e");
        expect(commandChord("toggleStrikethrough")).toBe("Mod-Shift-x");
    });

    it("a rebindable command should resolve to nothing where no host declares it", () => {
        // insertLink ships a ⌘K default in package.json. That default is what
        // must NOT come out of here: inside VS Code the user may have rebound
        // it, and the webview cannot read their binding.
        expect(commandChord("insertLink")).toBeNull();
        expect(commandChord("setHeading1")).toBeNull();
        expect(commandChord("toggleBulletList")).toBeNull();
    });

    it("a host-declared command should resolve to the host's key", () => {
        declareShortcuts([{ keys: "Mod-k", label: "Link…", command: "insertLink" }]);
        expect(commandChord("insertLink")).toBe("Mod-k");
    });

    it("a host declaration should win over the fixed keymap", () => {
        // The host's menu takes the key equivalent before the page sees the
        // keydown, so its answer is the true one where both bind the chord.
        declareShortcuts([{ keys: "Mod-Alt-b", label: "Bold", command: "toggleBold" }]);
        expect(commandChord("toggleBold")).toBe("Mod-Alt-b");
    });

    it("a host key that runs no command should not resolve for any command", () => {
        // Save is the host's own gesture and reaches no editor command; it
        // carries no `command`, so nothing can match it.
        declareShortcuts([{ keys: "Mod-s", label: "Save" }]);
        expect(commandChord("insertLink")).toBeNull();
        expect(commandChord("toggleBold")).toBe("Mod-b");
    });
});

describe("withChord", () => {
    it("a command with no printable chord should render the label alone", () => {
        expect(withChord("Insert/Edit Link", "insertLink")).toBe("Insert/Edit Link");
    });

    it("a command with a chord should render the label and the rendered key", () => {
        // kbd() decides the glyphs; what this pins is that the label survives
        // and the chord is appended rather than replacing it.
        const out = withChord("Bold", "toggleBold");
        expect(out.startsWith("Bold (")).toBe(true);
        expect(out.endsWith(")")).toBe(true);
    });

    it("the chord should stay out of the accessible name the button derives", () => {
        // Asked of `createButton` itself rather than of a copy of its stripper:
        // the shape `withChord` returns is only correct if the real derivation
        // removes it, and a regex restated here would agree with a stripper
        // that had stopped matching. An icon-only button is the case that
        // derives a name at all (webview/ui/dom.ts).
        const btn = createButton({
            className: "tb-btn",
            icon: "<svg></svg>",
            title: withChord("Bold", "toggleBold"),
        });
        expect(btn.getAttribute("aria-label")).toBe("Bold");
    });
});
