/**
 * Type-creep insurance for the block-conversion capability registry
 * (webview/blockCapabilities.ts, MAR-109):
 *
 *   1. Exhaustiveness — every schema node type must carry a capability
 *      declaration, and every declaration must name a real schema type, so
 *      "new node type, no conversion decision" is a red build (the
 *      gutterCoverage.test.ts pattern).
 *   2. A golden derived matrix over a fixture containing every source kind —
 *      a capability edit that flips any cell shows up as a reviewable diff
 *      (the slashToolbarParity.test.ts drift-guard idea).
 *   3. The fidelity gate — `canConvert` must agree with the legacy
 *      hand-written `canTurnInto` for every (block, kind) pair including
 *      the diagonal. Proves the refactor preserved behavior; delete it
 *      together with `canTurnInto` once the registry has bedded in.
 *
 * Drives the REAL Milkdown editor (real parser, real schema, the production
 * serialization config), like blockMenu.test.ts.
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, schemaCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import type { EditorView } from "@milkdown/prose/view";
import * as fs from "fs";
import * as path from "path";
import { configureSerialization, pureCommonmark } from "../serialization";
import {
    ALL_KINDS,
    BLOCK_CAPABILITIES,
    canConvert,
    contentEffectOf,
    conversionKindAt,
} from "../blockCapabilities";
import { canTurnInto } from "../components/blockMenu/turnInto";
import { contentGuardPlugin } from "../plugins/contentGuard";

const REPO_ROOT = path.resolve(__dirname, "..", "..");

let editors: Editor[] = [];

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfm)
        // Real guard in the loop (MAR-108): these suites exercise guarded ops.
        .use(contentGuardPlugin)
        .create();
    editors.push(editor);
    return editor;
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

/** One fixture block per convertible source kind, plus the never-convertible
 * shapes (leaf, composite, visual paragraphs, kind-less wrappers). */
const FIXTURE = [
    "plain text",
    "",
    "## Title",
    "",
    "- bullet",
    "",
    "1. ordered",
    "",
    "- [ ] task",
    "",
    "> quote",
    "",
    "> [!NOTE]",
    "> callout body",
    "",
    "> - nested one",
    "> - nested two",
    "",
    "```js",
    "code",
    "```",
    "",
    "---",
    "",
    "![img](data:,x)",
    "",
    "<div>raw</div>",
    "",
    "| a | b |",
    "| --- | --- |",
    "| c | d |",
    "",
    ":::note",
    "directive body",
    ":::",
    "",
    "prose with a footnote[^1]",
    "",
    "[^1]: the definition",
    "",
].join("\n");

describe("capability coverage", () => {
    it("every schema node type should have a capability declaration", async () => {
        const editor = await makeEditor("# h\n\ntext");
        const nodeNames = Object.keys(editor.action((ctx) => ctx.get(schemaCtx)).nodes);
        const undeclared = nodeNames.filter((name) => !(name in BLOCK_CAPABILITIES));
        expect(
            undeclared,
            `New node type(s) without a conversion policy: ${undeclared.join(", ")}. ` +
                `Add a BLOCK_CAPABILITIES entry (webview/blockCapabilities.ts) — ` +
                `"not convertible" is spelled ` +
                `{ shape, content, kind: null, source: false, target: false }, not an omission.`,
        ).toEqual([]);
    });

    it("no capability declaration should name a node type the schema lacks", async () => {
        const editor = await makeEditor("# h\n\ntext");
        const schema = editor.action((ctx) => ctx.get(schemaCtx));
        const stale = Object.keys(BLOCK_CAPABILITIES).filter((name) => !(name in schema.nodes));
        expect(
            stale,
            `BLOCK_CAPABILITIES entries for node type(s) the schema no longer has: ` +
                `${stale.join(", ")}. Remove them so the registry mirrors the real schema.`,
        ).toEqual([]);
    });

    it("the test editor's plugin stack should register every $nodeSchema id in webview sources", async () => {
        // Harness parity (design doc §8 caveat): this suite uses
        // pureCommonmark + gfm, which covers every schema-bearing plugin only
        // because serialization.ts bundles them inside pureCommonmark. A new
        // $nodeSchema plugin .use()'d only in editor.ts would be invisible
        // here — and to the exhaustiveness test above. This sweep (the
        // gutterCoverage.test.ts idiom) derives the expected node ids from
        // the SOURCE, not a hand-copied list.
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
        const ids = new Set<string>();
        for (const full of files) {
            const source = fs.readFileSync(full, "utf8");
            for (const match of source.matchAll(/\$nodeSchema[(<][^)]*?["']([\w-]+)["']/g)) {
                ids.add(match[1]!);
            }
            for (const match of source.matchAll(/const (\w+Id) = ["']([\w-]+)["']/g)) {
                if (source.includes(`$nodeSchema(${match[1]}`)) {
                    ids.add(match[2]!);
                }
            }
        }
        expect(ids.size).toBeGreaterThanOrEqual(4); // sanity: the sweep found the known ones
        const editor = await makeEditor("seed");
        const schema = editor.action((ctx) => ctx.get(schemaCtx));
        const missing = [...ids].filter((id) => !(id in schema.nodes));
        expect(
            missing,
            `$nodeSchema node type(s) not registered by this suite's plugin stack: ` +
                `${missing.join(", ")}. Add the defining plugin to pureCommonmark ` +
                `(webview/serialization.ts) or to makeEditor here, or the coverage ` +
                `tests above can't see it.`,
        ).toEqual([]);
    });
});

describe("derived conversion matrix", () => {
    it("the fixture's derived matrix should match the golden table", async () => {
        const editor = await makeEditor(FIXTURE);
        const v = view(editor);
        const rows: Array<{ block: string; kind: string | null; convertsTo: string[] }> = [];
        v.state.doc.forEach((node, offset) => {
            rows.push({
                block: node.type.name,
                kind: conversionKindAt(v, offset),
                convertsTo: ALL_KINDS.filter((kind) => canConvert(v, offset, kind)),
            });
        });
        // The golden table — the shipped Turn-into matrix. A capability or
        // derivation-rule edit that flips any cell must show up here as a
        // reviewable diff.
        const EVERY_KIND = [...ALL_KINDS];
        // Quote/callout → list needs all-paragraph content (rule 5's
        // instance predicate); a quote holding a nested list loses exactly
        // the three list targets.
        const EVERY_KIND_BUT_LISTS = EVERY_KIND.filter(
            (kind) => !["bulletList", "orderedList", "taskList"].includes(kind),
        );
        const NOTHING: string[] = [];
        expect(rows).toEqual([
            { block: "paragraph", kind: "paragraph", convertsTo: EVERY_KIND },
            { block: "heading", kind: "h2", convertsTo: EVERY_KIND },
            { block: "bullet_list", kind: "bulletList", convertsTo: EVERY_KIND },
            { block: "ordered_list", kind: "orderedList", convertsTo: EVERY_KIND },
            { block: "bullet_list", kind: "taskList", convertsTo: EVERY_KIND },
            { block: "blockquote", kind: "blockquote", convertsTo: EVERY_KIND },
            { block: "callout", kind: "callout", convertsTo: EVERY_KIND },
            { block: "blockquote", kind: "blockquote", convertsTo: EVERY_KIND_BUT_LISTS },
            // Code blocks convert only via their own fence until MAR-20
            // flips `code_block.source` (the diagonal is the filled row).
            { block: "code_block", kind: "codeBlock", convertsTo: ["codeBlock"] },
            { block: "hr", kind: null, convertsTo: NOTHING },
            { block: "paragraph", kind: null, convertsTo: NOTHING }, // image-only (MAR-79)
            { block: "paragraph", kind: null, convertsTo: NOTHING }, // html-only
            { block: "table", kind: null, convertsTo: NOTHING },
            { block: "container_directive", kind: null, convertsTo: NOTHING }, // MAR-115
            { block: "paragraph", kind: "paragraph", convertsTo: EVERY_KIND },
            { block: "footnote_definition", kind: null, convertsTo: NOTHING },
        ]);
    });

    it("every legal pair on the fixture should declare a content effect", async () => {
        const editor = await makeEditor(FIXTURE);
        const v = view(editor);
        const missing: string[] = [];
        v.state.doc.forEach((node, offset) => {
            const source = conversionKindAt(v, offset);
            for (const target of ALL_KINDS) {
                if (!canConvert(v, offset, target)) continue;
                if (source === null || contentEffectOf(source, target) === null) {
                    missing.push(`${node.type.name}(${source}) -> ${target}`);
                }
            }
        });
        expect(missing).toEqual([]);
    });
});

describe("fidelity gate: canConvert vs the legacy canTurnInto", () => {
    it("every (block, kind) pair including the diagonal should agree with the legacy predicate", async () => {
        const editor = await makeEditor(FIXTURE);
        const v = view(editor);
        const disagreements: string[] = [];
        v.state.doc.forEach((node, offset) => {
            for (const target of ALL_KINDS) {
                const derived = canConvert(v, offset, target);
                const legacy = canTurnInto(v, offset, target);
                if (derived !== legacy) {
                    disagreements.push(
                        `${node.type.name}@${offset} -> ${target}: derived=${derived} legacy=${legacy}`,
                    );
                }
            }
        });
        expect(disagreements).toEqual([]);
    });
});
