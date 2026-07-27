/**
 * Exhaustiveness guard: EVERY block node type has a source-line mapping story.
 *
 * The mode switch, scroll-to-line, and the agent bridge all map positions
 * through utils/sourceCaret.ts, whose anchors must account for every source
 * line a block covers. Each block family found this out the hard way —
 * tables (per-cell anchors mismapped), wrapped paragraphs (collapsed to line
 * one), marker-line containers (callouts/directives shifted a line) — so
 * this sweep makes the NEXT node type fail loudly at build time instead of
 * quietly switching users to the wrong line.
 *
 * A new block type must be one of:
 *  - a textblock (mapped per line via code text / break-leaf segments);
 *  - a table row (`tableRole: "row"` or a `table*_row` name);
 *  - a marker-line container — declare `markerLines: { closer: boolean }`
 *    in its NODE SPEC (see callouts.ts / directives.ts / notionCallouts.ts);
 *  - a container whose body text SHARES its marker's source line (a list, a
 *    blockquote) or a leaf with no text — allowlisted here with the reason.
 * Then add the construct to e2e/modeSwitchSelection's fixture, which is the
 * round-trip zoo for exactly this.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, schemaCtx } from "@milkdown/core";
import * as path from "path";
import * as fs from "fs";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { containerMarkerLines, isTableRow, isLineBreak } from "../utils/sourceCaret";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

/**
 * Block node types that need NO anchors of their own. Every entry carries
 * the reason its source lines are already accounted for.
 */
const COVERED_ELSEWHERE: Record<string, string> = {
    "doc": "the document itself",
    "blockquote": "body text shares the `> ` marker's source line — suffix matching covers it",
    "bullet_list": "item text shares the bullet's source line — suffix matching covers it",
    "ordered_list": "item text shares the number's source line — suffix matching covers it",
    "list_item": "its paragraphs are the line units (textblocks)",
    "table": "its ROWS are the line units (isTableRow)",
    "table_row": "row anchor (isTableRow) — asserted below, listed for the classifier loop",
    "table_header_row": "row anchor (isTableRow) — asserted below",
    "table_cell": "row interior — the row anchor owns its line",
    "table_header": "row interior — the row anchor owns its line",
    "hr": "leaf with no text — the block's own map entry is the whole story",
    "link_definition": "leaf atom; orphaned definitions only",
    "footnote_definition": "`[^1]: ` shares its source line with the body text — suffix matching covers it",
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

describe("every block type has a source-line mapping story", () => {
    it("preset schema: each block node maps or is consciously allowlisted", async () => {
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

        const unmapped: string[] = [];
        for (const [name, type] of Object.entries(schema.nodes)) {
            if (!type.isBlock) { continue; }
            const mapped =
                type.isTextblock ||
                isTableRow(type) ||
                containerMarkerLines(type) !== null ||
                name in COVERED_ELSEWHERE;
            if (!mapped) { unmapped.push(name); }
        }
        expect(
            unmapped,
            "Block node types the source-line mapping (utils/sourceCaret.ts) cannot " +
                "classify. Declare `markerLines: { closer: boolean }` in the node's spec " +
                "if its marker lines carry no text position, or add it to " +
                "COVERED_ELSEWHERE here with the reason its lines are already handled — " +
                "and add the construct to e2e/modeSwitchSelection's fixture.",
        ).toEqual([]);

        // The specific classifications the mapping stands on.
        expect(isTableRow(schema.nodes["table_row"]!)).toBe(true);
        expect(isTableRow(schema.nodes["table_header_row"]!)).toBe(true);
        expect(isLineBreak(schema.nodes["hardbreak"]!)).toBe(true);
    });

    it("plugin schemas: every $nodeSchema id is mapped or allowlisted", () => {
        // Same static sweep as gutterCoverage.test.ts: node ids registered by
        // our own plugins (the preset editor above doesn't load them all).
        // An id claiming `markerLines` must actually declare it in the file
        // that defines the schema.
        const PLUGIN_NODE_STORY: Record<string, string> = {
            "callout": "markerLines",
            "container_directive": "markerLines",
            "notion_callout": "markerLines",
            "footnote_definition": "body shares the `[^1]: ` marker's source line — suffix",
            "footnote_reference": "inline atom",
            "math_inline": "inline node — nested text counts via textBetween",
            "wiki_link": "inline atom",
            "image_ref": "inline atom",
            "link_definition": "leaf atom",
        };
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
        const idFiles = new Map<string, string>();
        for (const full of files) {
            const source = fs.readFileSync(full, "utf8");
            for (const match of source.matchAll(/\$nodeSchema[(<][^)]*?["']([\w-]+)["']/g)) {
                idFiles.set(match[1]!, full);
            }
            for (const match of source.matchAll(/const (\w+Id) = ["']([\w-]+)["']/g)) {
                if (source.includes(`$nodeSchema(${match[1]}`)) {
                    idFiles.set(match[2]!, full);
                }
            }
        }
        expect(idFiles.size).toBeGreaterThanOrEqual(4); // sanity: the sweep works

        const unexplained = [...idFiles.keys()].filter((id) => !(id in PLUGIN_NODE_STORY));
        expect(
            unexplained,
            "Plugin node ids with no source-line mapping story. Add the id to " +
                "PLUGIN_NODE_STORY (and declare `markerLines` in its spec if its marker " +
                "lines carry no text position).",
        ).toEqual([]);

        for (const [id, story] of Object.entries(PLUGIN_NODE_STORY)) {
            if (story !== "markerLines") { continue; }
            const file = idFiles.get(id);
            expect(file, `schema for ${id} not found by the sweep`).toBeDefined();
            expect(
                fs.readFileSync(file!, "utf8").includes("markerLines"),
                `${id} claims a markerLines declaration but ${path.relative(REPO_ROOT, file!)} has none`,
            ).toBe(true);
        }
    });
});
