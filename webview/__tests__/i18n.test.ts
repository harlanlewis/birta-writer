/**
 * i18n t() tests: the translation map is read from window.__i18n at module
 * load time, so vi.resetModules + dynamic import is used to vary it per test.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("t", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        delete window.__i18n;
    });

    it("an empty translations map should fall back to the key itself", async () => {
        // Arrange
        window.__i18n = { translations: {}, isMac: false };
        // Act
        const { t } = await import("../i18n");
        // Assert
        expect(t("Click to select row · drag to reorder")).toBe("Click to select row · drag to reorder");
    });

    it("a missing window.__i18n should fall back to the key itself", async () => {
        // Arrange: window.__i18n deleted in beforeEach
        // Act
        const { t } = await import("../i18n");
        // Assert
        expect(t("Some untranslated key")).toBe("Some untranslated key");
    });

    it("a key present in the translations map should return the translated value", async () => {
        // Arrange
        window.__i18n = { translations: { Hello: "Bonjour" }, isMac: false };
        // Act
        const { t } = await import("../i18n");
        // Assert
        expect(t("Hello")).toBe("Bonjour");
    });
});

/**
 * kbd() rendering. Both cases here are keys a menu binds and no tooltip had
 * printed before: the hyphen is Zoom Out's key, and Control is what Join Lines
 * is bound with. Each was rendered wrong by a function every shortcut label
 * goes through, and neither was reachable until a host declared a key that
 * used it.
 */
describe("kbd", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        vi.resetModules();
        delete window.__i18n;
    });

    it("a chord whose key is the hyphen should render the key rather than lose it", async () => {
        // Arrange: Zoom Out is Mod plus the hyphen, and the notation spells
        // the separator the same way.
        window.__i18n = { translations: {}, isMac: true };
        // Act
        const { kbd } = await import("../i18n");
        // Assert
        expect(kbd("Mod--")).toBe("⌘-");
    });

    it("a hyphen key on Windows should render as a chain part like any other key", async () => {
        window.__i18n = { translations: {}, isMac: false };
        const { kbd } = await import("../i18n");
        expect(kbd("Mod--")).toBe("Ctrl+-");
    });

    it("the Control modifier should render as its own mac glyph, not as the word", async () => {
        window.__i18n = { translations: {}, isMac: true };
        const { kbd } = await import("../i18n");
        expect(kbd("Ctrl-j")).toBe("⌃J");
    });

    it("the Control modifier on Windows should render as Ctrl", async () => {
        window.__i18n = { translations: {}, isMac: false };
        const { kbd } = await import("../i18n");
        expect(kbd("Ctrl-j")).toBe("Ctrl+J");
    });

    it("an ordinary chord should be unchanged by the separator rule", async () => {
        window.__i18n = { translations: {}, isMac: true };
        const { kbd } = await import("../i18n");
        expect(kbd("Mod-Shift-x")).toBe("⌘⇧X");
        expect(kbd("Mod-Alt-1")).toBe("⌘⌥1");
        expect(kbd("Mod-[")).toBe("⌘[");
    });
});
