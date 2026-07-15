/**
 * Exhaustiveness guard: EVERY kind of content gets a gutter grabber.
 *
 * Two sweeps, both against explicit allowlists — adding a new block node
 * (preset upgrade or a new plugin) fails here until it is either given a
 * MarkerSpec or consciously allowlisted with a reason. This is the
 * anti-whack-a-mole test: coverage omissions surface at build time, not
 * when a user hovers the one block type nobody tried.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, schemaCtx } from "@milkdown/core";
import * as path from "path";
import * as fs from "fs";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { blockMarkerSpec } from "../plugins/headingFold";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Block node types that deliberately have NO gutter marker. Every entry
 * needs a reason — this list is the single place "no grabber" is allowed.
 */
const NO_MARKER_ALLOWLIST: Record<string, string> = {
    "doc": "the document itself",
    "hr": "leaf atom (nodeSize 1) — no content position for the in-block widget; needs an overlay handle (tracked with MAR-19's leftovers)",
    "link_definition": "leaf atom like hr; orphaned definitions only — most are stripped by the remark transform",
    "bullet_list": "per-ITEM markers (emitItemGutters) — the items are the units, not the list",
    "ordered_list": "per-ITEM markers — same",
    "list_item": "covered by emitItemGutters (itemMarkerSpec), not blockMarkerSpec",
    "heading": "covered by createHeadingFoldGutter (level badge + fold chevron), not blockMarkerSpec",
    "table_row": "table interior — the table's marker + its own grips are the handles",
    "table_header_row": "table interior",
    "table_cell": "table interior",
    "table_header": "table interior",
    "footnote_reference": "inline atom despite isBlock quirks in some presets",
};

let editors: Editor[] = [];

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

describe("every block type has a grabber", () => {
    it("preset schema: each block node is covered or consciously allowlisted", async () => {
        const root = document.createElement("div");
        document.body.appendChild(root);
        const editor = await Editor.make()
            .config((ctx) => {
                ctx.set(rootCtx, root);
                ctx.set(defaultValueCtx, "seed");
                configureSerialization(ctx);
            })
            .use(pureCommonmark)
            .use(gfmFidelity)
            .create();
        editors.push(editor);
        const schema = editor.action((ctx) => ctx.get(schemaCtx));

        const uncovered: string[] = [];
        for (const [name, type] of Object.entries(schema.nodes)) {
            if (!type.isBlock || name in NO_MARKER_ALLOWLIST) {
                continue;
            }
            const node = type.createAndFill();
            if (!node) {
                uncovered.push(`${name} (could not instantiate — allowlist it with a reason if intentional)`);
                continue;
            }
            if (blockMarkerSpec(node) === null) {
                uncovered.push(name);
            }
        }
        expect(
            uncovered,
            "Block node types with NO gutter marker. Give each a MarkerSpec in " +
                "blockMarkerSpec (webview/plugins/headingFold.ts) or add it to " +
                "NO_MARKER_ALLOWLIST here with a reason.",
        ).toEqual([]);
    });

    it("plugin schemas: every $nodeSchema id is covered or allowlisted", () => {
        // Static sweep: node ids registered by our own plugins (the preset
        // editor above doesn't load them all). Any NEW $nodeSchema call
        // must either be covered by blockMarkerSpec's switch, be inline
        // (listed here), or join the allowlist.
        const INLINE_OR_COVERED: Record<string, string> = {
            "callout": "covered: blockMarkerSpec case",
            "notion_callout": "covered: blockMarkerSpec case",
            "container_directive": "covered: blockMarkerSpec case",
            "footnote_definition": "covered: blockMarkerSpec case",
            "footnote_reference": "inline atom",
            "math_inline": "inline atom",
            "wiki_link": "inline atom",
            "image_ref": "inline atom (![alt][ref] chip)",
            "link_definition": "allowlisted leaf atom (see NO_MARKER_ALLOWLIST)",
        };
        // Walk ALL of webview/ (not just plugins/) so a node schema defined
        // anywhere fails the guard.
        const files: string[] = [];
        const walk = (dir: string): void => {
            for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
                if (entry.name === "__tests__" || entry.name === "node_modules") continue;
                const full = path.join(dir, entry.name);
                if (entry.isDirectory()) walk(full);
                else if (entry.name.endsWith(".ts")) files.push(full);
            }
        };
        walk(path.join(REPO_ROOT, "webview"));
        const ids: string[] = [];
        for (const full of files) {
            const source = fs.readFileSync(full, "utf8");
            for (const match of source.matchAll(/\$nodeSchema[(<][^)]*?["']([\w-]+)["']/g)) {
                ids.push(match[1]!);
            }
            // $nodeSchema(directiveId, ...) style — resolve exported id consts
            for (const match of source.matchAll(/const (\w+Id) = ["']([\w-]+)["']/g)) {
                if (source.includes(`$nodeSchema(${match[1]}`)) {
                    ids.push(match[2]!);
                }
            }
        }
        expect(ids.length).toBeGreaterThanOrEqual(4); // sanity: the sweep found the known ones
        const unexplained = [...new Set(ids)].filter(
            (id) => !(id in INLINE_OR_COVERED) && !(id in NO_MARKER_ALLOWLIST),
        );
        expect(
            unexplained,
            "New plugin node types with no gutter-marker decision. Cover them in " +
                "blockMarkerSpec or record them in this test with a reason.",
        ).toEqual([]);
    });
});
