/**
 * Grammar-set guard.
 *
 * The webview bundle rebinds the bare `refractor` specifier to `refractor/core`
 * (the `refractor-singleton` plugin in esbuild.mjs), so refractor's own `common`
 * entry — which registers 35 grammars onto the shared instance at import time —
 * never loads in production. `@milkdown/plugin-prism` used to pull it in and so
 * highlighted those languages for free; our lazy set now has to be a strict
 * SUPERSET of common or a language silently loses highlighting.
 *
 * Nothing in the type system enforces that; a refractor upgrade adding a
 * language to `common` would break it quietly. This test compares the two sets
 * for real, on one shared instance: register ours, snapshot, then let common
 * register onto the same instance and see whether it added anything new.
 */
import { describe, it, expect } from "vitest";
import { refractor } from "refractor/core";
import { registerGrammars } from "../highlighterLanguages";

describe("registerGrammars", () => {
    it("our grammar set should be a superset of refractor's common set", async () => {
        // Arrange: register only our own languages on the shared core instance
        registerGrammars(refractor);
        const ours = new Set(refractor.listLanguages());

        // Act: refractor's bare entry registers its common set on that same
        // instance, so anything new it adds is a language we are missing
        await import("refractor");
        const missing = refractor.listLanguages().filter((lang) => !ours.has(lang));

        // Assert
        expect(missing).toEqual([]);
    });
});

describe("refractorSingleton", () => {
    it("the bare-specifier shim should re-export the core instance", async () => {
        // Arrange / Act
        const { refractor: shimmed } = await import("../refractorSingleton");
        // Assert: the shim swaps the payload, never the instance — everything
        // registered by highlighter.ts must stay visible to plugin-prism
        expect(shimmed).toBe(refractor);
    });
});
