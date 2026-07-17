/**
 * Structural consistency of the markdown FormatModule (MAR-41): the module
 * is assembled by hand from independently maintained pieces (presets,
 * NodeViews, the minimal-diff profile), so this suite pins the
 * cross-references that nothing else checks — a NodeView naming a node the
 * presets don't define would silently render nothing, and a presets'
 * serializer missing its whole-document post-pass (baked into
 * `pureCommonmark`, see webview/serialization.ts) would silently diverge
 * from the bytes production writes.
 */
import { describe, it, expect } from "vitest";
import { schemaCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { markdownFormat } from "../format/markdown";
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

    it("the presets' serializer should apply the org-cookie post-pass", async () => {
        // An org-mode priority cookie: the serializer escapes the `[` in
        // prose, and only the whole-document post-pass (unescapeOrgCookies,
        // MAR-131) restores it. The pass has no member on the FormatModule —
        // the presets are its single source of truth (bound via
        // `createFidelitySerializerPlugin` inside `pureCommonmark`,
        // webview/serialization.ts) — so this behavioral round trip is what
        // pins that the module's presets actually carry it.
        const editor = await makeCorpusEditor("TODO [#A] write the seam", [], markdownFormat);
        const out = editor.action(getMarkdown());
        expect(out).toContain("[#A]");
        expect(out).not.toContain("\\[#A]");
        await editor.destroy();
    });

    it("its presets and profile should be populated, not empty stubs", () => {
        expect(markdownFormat.presets.length).toBeGreaterThan(0);
        // The profile must key exactly one line per input line — the engine
        // contract (@birta/minimal-diff FormatProfile).
        const keys = markdownFormat.formatProfile.keyLines(["# a", "", "b"]);
        expect(keys).toHaveLength(3);
    });
});
