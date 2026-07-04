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
