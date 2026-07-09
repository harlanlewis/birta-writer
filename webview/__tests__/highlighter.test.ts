/**
 * highlighter tests: syntax grammars are loaded lazily via ensureGrammars()
 * (a code-split chunk) instead of being registered at boot. Until they load,
 * highlight() returns escaped plaintext so code renders correct-but-unstyled;
 * after loading, real token spans appear. The mermaid grammar stays eager.
 *
 * Module state (the shared refractor instance + the cached grammar promise) is
 * reset per test so "before load" starts from a clean, unregistered instance.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

describe("ensureGrammars", () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it("a bundled language should render as escaped plaintext before grammars load", async () => {
        // Arrange
        const { highlight } = await import("../highlighter");
        // Act
        const out = highlight("const x = 1 < 2", "javascript");
        // Assert: no token spans yet, and the < is HTML-escaped
        expect(out).not.toContain('class="token');
        expect(out).toBe("const x = 1 &lt; 2");
    });

    it("loading grammars should enable token highlighting for that language", async () => {
        // Arrange
        const { highlight, ensureGrammars } = await import("../highlighter");
        // Act
        await ensureGrammars();
        const out = highlight("const x = 1", "javascript");
        // Assert
        expect(out).toContain('class="token');
    });

    it("calling ensureGrammars twice should share one load", async () => {
        // Arrange
        const { ensureGrammars } = await import("../highlighter");
        // Act / Assert: same cached promise instance
        expect(ensureGrammars()).toBe(ensureGrammars());
        await ensureGrammars();
    });

    it("mermaid highlighting should be available eagerly, before grammars load", async () => {
        // Arrange
        const { highlight } = await import("../highlighter");
        // Act: mermaid grammar is registered at module load, not in the lazy chunk
        const out = highlight("flowchart LR", "mermaid");
        // Assert
        expect(out).toContain('class="token');
    });
});
