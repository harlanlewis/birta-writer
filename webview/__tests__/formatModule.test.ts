/**
 * Structural consistency of the markdown FormatModule (MAR-41): the module
 * is assembled by hand from independently maintained pieces (presets,
 * NodeViews, registries, the minimal-diff profile, the serializer
 * post-pass), so this suite pins the cross-references that nothing else
 * checks — a NodeView naming a node the presets don't define would silently
 * render nothing, and a post-pass declared on the module but not wired into
 * the presets' serializer would silently diverge from production output.
 */
import { describe, it, expect } from "vitest";
import { schemaCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { markdownFormat } from "../format/markdown";
import { unescapeOrgCookies } from "../utils/minimalDiff";
import { makeCorpusEditor } from "./helpers/moveFuzz";

describe("markdown FormatModule", () => {
    it("every NodeView it declares should name a node in the schema its presets build", async () => {
        const editor = await makeCorpusEditor("hello", [], markdownFormat);
        const schema = editor.action((ctx) => ctx.get(schemaCtx));
        for (const [nodeId] of markdownFormat.nodeViews) {
            expect(
                schema.nodes[nodeId],
                `nodeViews registers "${nodeId}" but the presets build no such node`,
            ).toBeDefined();
        }
        await editor.destroy();
    });

    it("the presets' serializer should apply the module's declared postSerialize pass", async () => {
        // An org-mode priority cookie: the serializer escapes the `[` in
        // prose, and only the injected post-pass (unescapeOrgCookies)
        // restores it. If the module declared the pass but the preset's
        // fidelity serializer were not instantiated with it, the output
        // would keep the escape.
        const editor = await makeCorpusEditor("TODO [#A] write the seam", [], markdownFormat);
        const out = editor.action(getMarkdown());
        expect(out).toContain("[#A]");
        expect(out).not.toContain("\\[#A]");
        // And the declared pass is exactly the one production bakes in.
        expect(markdownFormat.postSerialize).toBe(unescapeOrgCookies);
        await editor.destroy();
    });

    it("its UI registries and profile should be populated re-exports, not empty stubs", () => {
        expect(markdownFormat.presets.length).toBeGreaterThan(0);
        expect(markdownFormat.slashItems.length).toBeGreaterThan(0);
        expect(markdownFormat.toolbarItems.length).toBeGreaterThan(0);
        expect(markdownFormat.selectionToolbarItems.length).toBeGreaterThan(0);
        // The profile must key exactly one line per input line — the engine
        // contract (@birta/minimal-diff FormatProfile).
        const keys = markdownFormat.formatProfile.keyLines(["# a", "", "b"]);
        expect(keys).toHaveLength(3);
    });
});
