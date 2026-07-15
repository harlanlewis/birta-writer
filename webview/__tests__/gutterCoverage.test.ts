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
import { Editor, rootCtx, defaultValueCtx, schemaCtx, editorViewCtx } from "@milkdown/core";
import type { EditorView } from "@milkdown/prose/view";
import * as path from "path";
import * as fs from "fs";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { blockMarkerSpec, nestedChildSpec, headingFoldPlugin } from "../plugins/headingFold";

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

/**
 * Nesting POSITION coverage (MAR-88). The type sweeps above only ask "does
 * this node TYPE get a marker somewhere" — they never checked a block by its
 * nesting POSITION, which is exactly how the MAR-88 hole (a container block
 * under a list item had no grabber at all) stayed green. These two guards
 * close that: the pure sweep asserts every block type has a nested-child
 * marker decision (nestedChildSpec drives BOTH the container-child and the
 * list-item-child emit paths), and the rendering matrix proves each grabbable
 * kind actually paints a marker at every position.
 */

/**
 * Block types with NO marker when nested inside a container or list item.
 * Distinct from NO_MARKER_ALLOWLIST: a nested HEADING gets a badge marker
 * (nestedChildSpec), so it is covered here, not allowlisted; a nested text
 * paragraph is the container's/item's prose and is allowlisted here.
 */
const NESTED_NO_MARKER_ALLOWLIST: Record<string, string> = {
    "doc": "the document itself — never a nested child",
    "paragraph": "text paragraph is the container's/item's own prose — its marker is the handle (nestedChildSpec returns null for P); image/HTML paragraphs still get a marker via blockMarkerSpec",
    "hr": "leaf atom (nodeSize 1) — needs an overlay handle (MAR-19 leftovers)",
    "link_definition": "leaf atom; orphaned definitions only",
    "bullet_list": "routed to emitItemGutters before nestedChildSpec — per-item markers",
    "ordered_list": "per-item markers — same",
    "list_item": "only ever inside a list; covered by emitItemGutters",
    "table_row": "table interior — the table's own marker/grips are the handles",
    "table_header_row": "table interior",
    "table_cell": "table interior",
    "table_header": "table interior",
    "footnote_reference": "inline atom despite isBlock quirks in some presets",
};

describe("every block type has a grabber at every nesting position", () => {
    it("nested position: each block node has a nested-child marker or is allowlisted", async () => {
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
            if (!type.isBlock || name in NESTED_NO_MARKER_ALLOWLIST) {
                continue;
            }
            const node = type.createAndFill();
            if (!node) {
                uncovered.push(`${name} (could not instantiate — allowlist it with a reason if intentional)`);
                continue;
            }
            if (nestedChildSpec(node) === null) {
                uncovered.push(name);
            }
        }
        expect(
            uncovered,
            "Block node types with NO nested-child marker. Give each a MarkerSpec " +
                "(via blockMarkerSpec/nestedChildSpec) or add it to " +
                "NESTED_NO_MARKER_ALLOWLIST with a reason.",
        ).toEqual([]);
    });

    // The emit-wiring guard: a container block placed at each nesting position
    // must actually PAINT its marker. Without the list-item row, MAR-88's hole
    // (emitItemGutters never emitting for the item's own block children) is
    // invisible to the pure sweep — nestedChildSpec is right, but nothing calls
    // it for item children.
    // `pill` is the nested-marker label; `topPill` (when it differs) is the
    // top-level label — a top-level heading paints an H-badge marker ("H1")
    // via createHeadingFoldGutter, while nested it paints a "Heading" badge
    // via createBlockGutter.
    const KINDS: { name: string; inner: string[]; pill: string; topPill?: string }[] = [
        { name: "blockquote", inner: ["> quoted"], pill: "Blockquote" },
        { name: "code block", inner: ["```js", "code", "```"], pill: "Code Block" },
        { name: "heading", inner: ["# Heading"], pill: "Heading", topPill: "H1" },
        { name: "table", inner: ["| a | b |", "| - | - |", "| 1 | 2 |"], pill: "Table" },
        { name: "callout", inner: ["> [!NOTE]", "> body"], pill: "Callout" },
    ];

    async function makeFolding(md: string): Promise<Editor> {
        const root = document.createElement("div");
        document.body.appendChild(root);
        const editor = await Editor.make()
            .config((ctx) => {
                ctx.set(rootCtx, root);
                ctx.set(defaultValueCtx, md);
                configureSerialization(ctx);
            })
            .use(pureCommonmark)
            .use(gfmFidelity)
            .use(headingFoldPlugin)
            .create();
        editors.push(editor);
        editor.action((ctx) => ctx.get(editorViewCtx) as EditorView);
        return editor;
    }

    // All markers (block glyphs AND heading badges) so a top-level heading's
    // H-badge is seen alongside every nested block's --block glyph.
    function pills(): string[] {
        return Array.from(document.querySelectorAll<HTMLElement>(".heading-fold-marker"))
            .map((el) => el.dataset["pill"] ?? "");
    }

    for (const kind of KINDS) {
        it(`${kind.name} paints its marker at top-level, in a callout, and in a list item`, async () => {
            // Top-level.
            let editor = await makeFolding(kind.inner.join("\n"));
            expect(pills(), `${kind.name} top-level`).toContain(kind.topPill ?? kind.pill);
            await editor.destroy();
            editors.pop();
            document.body.innerHTML = "";

            // Container child (inside a callout body).
            const inCallout = ["> [!TIP]", ...kind.inner.map((l) => `> ${l}`)].join("\n");
            editor = await makeFolding(inCallout);
            expect(pills(), `${kind.name} in callout`).toContain(kind.pill);
            await editor.destroy();
            editors.pop();
            document.body.innerHTML = "";

            // List-item child (the MAR-88 position: a continuation block under
            // an item, indented two spaces).
            const inItem = ["- item", "", ...kind.inner.map((l) => `  ${l}`)].join("\n");
            editor = await makeFolding(inItem);
            expect(pills(), `${kind.name} in list item`).toContain(kind.pill);
        });
    }

    it("a list inside a callout offsets its item markers clear of the accent bar (MAR-89)", async () => {
        const editor = await makeFolding("> [!NOTE]\n> - alpha\n> - beta");
        editors; // keep referenced
        const itemGutters = Array.from(
            document.querySelectorAll<HTMLElement>("li.block-gutter-host--item > .heading-fold-gutter--block"),
        );
        expect(itemGutters.length).toBeGreaterThan(0);
        // Every item marker inside the callout carries a non-zero container
        // depth, so the CSS steps it one inset clear of the accent bar.
        for (const gutter of itemGutters) {
            expect(gutter.style.getPropertyValue("--item-container-depth")).toBe("1");
        }
        await editor.destroy();
    });

    it("a top-level list leaves its item markers at the near-ink depth (0) (MAR-89)", async () => {
        await makeFolding("- alpha\n- beta");
        const itemGutters = Array.from(
            document.querySelectorAll<HTMLElement>("li.block-gutter-host--item > .heading-fold-gutter--block"),
        );
        expect(itemGutters.length).toBeGreaterThan(0);
        for (const gutter of itemGutters) {
            // Depth 0 sets no custom property — the near-ink base offset stands.
            expect(gutter.style.getPropertyValue("--item-container-depth")).toBe("");
        }
    });
});
