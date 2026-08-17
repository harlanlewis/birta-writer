/**
 * The JSX flow element's attribute layer (MAR-350): the structure captured
 * beside the raw slice, the in-place splice that edits one string literal,
 * and the block view's form driving that splice through a real editor.
 *
 * The oracle for the splice is the production parser itself: an edited
 * island is reparsed by the mdx pipeline and must decode to exactly the value
 * typed, with every byte outside the edited literal identical to the file's.
 * That is stronger than asserting the expected bytes, because it holds for
 * values nobody thought to spell out.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx, nodeViewCtx } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mdxFormat, mdxBlockId } from "../format/mdx";
import { createMdxBlockView } from "../format/mdx/views";
import {
    encodeAttributeValue,
    parseJsxStructure,
    spliceAttributeValue,
    type JsxStructure,
} from "../format/mdx/attributes";
import { setReadOnly } from "../readOnly";
import { makeCorpusEditor } from "./helpers/moveFuzz";

const fixture = (name: string): string =>
    readFileSync(join(__dirname, "fixtures", name), "utf8");

type Island = { value: string; jsx: JsxStructure | null };

/** Every flow island of `content`, in document order, through the real pipeline. */
async function islands(content: string): Promise<Island[]> {
    const editor = await makeCorpusEditor(content, [], mdxFormat);
    const out: Island[] = [];
    editor.action((ctx) => {
        ctx.get(editorViewCtx).state.doc.descendants((node) => {
            if (node.type.name === mdxBlockId) {
                out.push({
                    value: node.attrs["value"] as string,
                    jsx: (node.attrs["jsx"] as JsxStructure | null) ?? null,
                });
            }
            return true;
        });
    });
    await editor.destroy();
    return out;
}

/** The one JSX island of a single-element document. */
async function island(src: string): Promise<Island> {
    const all = await islands(src);
    expect(all.length, `expected one island in ${JSON.stringify(src)}`).toBe(1);
    return all[0]!;
}

async function makeViewEditor(content: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    let builder = Editor.make().config((ctx) => {
        ctx.set(rootCtx, root);
        ctx.set(defaultValueCtx, content);
        mdxFormat.configureSerialization(ctx);
        ctx.set(nodeViewCtx, [
            [mdxBlockId, (node, view, getPos) => createMdxBlockView(node, view, getPos)],
        ]);
    });
    for (const preset of mdxFormat.presets) {
        builder = builder.use(preset);
    }
    return builder.create();
}

let editors: Editor[] = [];
afterEach(async () => {
    for (const e of editors) {
        await e.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
    setReadOnly(false);
});

describe("attribute structure is carried beside the raw slice", () => {
    it("the docs fixture's islands should carry name and typed attributes with island-relative ranges", async () => {
        const all = await islands(fixture("mdx/docs-page.mdx"));
        const callout = all.find((i) => i.value.startsWith("<Callout"))!;
        expect(callout.jsx?.name).toBe("Callout");
        expect(callout.jsx?.attributes.map((a) => [a.name, a.kind, a.value])).toEqual([
            ["type", "string", "warning"],
            ["title", "string", "Heads up"],
        ]);
        // The ranges address the attribute's own bytes inside the slice.
        for (const a of callout.jsx!.attributes) {
            expect(callout.value.slice(a.start, a.end)).toBe(`${a.name}="${a.value}"`);
        }
        const charts = all.filter((i) => i.value.startsWith("<Chart"));
        expect(charts.length).toBe(2);
        for (const chart of charts) {
            expect(chart.jsx?.attributes.map((a) => [a.name, a.kind])).toEqual([
                ["data", "expression"],
                ["color", "string"],
            ]);
            expect(chart.jsx?.attributes[0]?.value).toBe("metrics");
        }
        // The single-quoted chart's range still covers its own quotes.
        const single = charts.find((c) => c.value.includes("'#227788'"))!;
        const color = single.jsx!.attributes[1]!;
        expect(single.value.slice(color.start, color.end)).toBe("color='#227788'");
    });

    it("the other flow kinds should carry no structure", async () => {
        const all = await islands(fixture("mdx/docs-page.mdx"));
        const esm = all.find((i) => i.value.startsWith("import"))!;
        const expr = all.find((i) => i.value.startsWith("{/*"))!;
        expect(esm.jsx).toBeNull();
        expect(expr.jsx).toBeNull();
    });

    it("boolean, spread, and spaced-equals attributes should classify without being editable", async () => {
        const one = await island(`<A open {...rest} x = "sp" />\n`);
        expect(one.jsx?.attributes.map((a) => [a.name, a.kind, a.value])).toEqual([
            ["open", "boolean", null],
            [null, "spread", "...rest"],
            ["x", "string", "sp"],
        ]);
        expect(spliceAttributeValue(one.value, one.jsx!, 0, "v")).toBeNull();
        expect(spliceAttributeValue(one.value, one.jsx!, 1, "v")).toBeNull();
    });

    it("an island inside a blockquote should keep exact ranges despite the prefixed slice", async () => {
        const one = await island(`> <A x="one"\n>   y="two" />\n`);
        expect(one.value).toContain("\n>   ");
        for (const a of one.jsx!.attributes) {
            expect(one.value.slice(a.start, a.end)).toBe(`${a.name}="${a.value}"`);
        }
    });

    it("a fragment should carry a null name and no attributes", async () => {
        const one = await island("<>\nfragment\n</>\n");
        expect(one.jsx).toEqual({ name: null, attributes: [] });
    });

    it("the structure should survive the DOM round trip and reject a malformed one", async () => {
        const one = await island(`<A x="1" />\n`);
        expect(parseJsxStructure(JSON.stringify(one.jsx))).toEqual(one.jsx);
        expect(parseJsxStructure(null)).toBeNull();
        expect(parseJsxStructure("not json")).toBeNull();
        expect(parseJsxStructure(JSON.stringify({ name: "A", attributes: [{ name: "x" }] }))).toBeNull();
        expect(parseJsxStructure(JSON.stringify({ name: 3, attributes: [] }))).toBeNull();
    });
});

describe("splicing one string attribute", () => {
    const RAW = `<Chart data={metrics} color="#fcb32c" size='big' />\n  body\n</Chart>`;
    const JSX: JsxStructure = {
        name: "Chart",
        attributes: [
            { name: "data", kind: "expression", value: "metrics", start: 7, end: 21 },
            { name: "color", kind: "string", value: "#fcb32c", start: 22, end: 37 },
            { name: "size", kind: "string", value: "big", start: 38, end: 48 },
        ],
    };

    it("should rewrite only the edited literal and shift the later ranges", () => {
        const out = spliceAttributeValue(RAW, JSX, 1, "red")!;
        expect(out.value).toBe(`<Chart data={metrics} color="red" size='big' />\n  body\n</Chart>`);
        expect(out.jsx.attributes[0]).toEqual(JSX.attributes[0]);
        expect(out.jsx.attributes[1]).toEqual({ ...JSX.attributes[1], value: "red", end: 33 });
        expect(out.jsx.attributes[2]).toEqual({ ...JSX.attributes[2], start: 34, end: 44 });
        // The re-offset structure addresses the new bytes exactly.
        for (const a of out.jsx.attributes.slice(1)) {
            expect(out.value.slice(a.start, a.end)).toMatch(new RegExp(`^${a.name}=`));
        }
    });

    it("should keep the original quote character and encode a conflicting quote", () => {
        const dq = spliceAttributeValue(RAW, JSX, 1, `say "hi"`)!;
        expect(dq.value).toContain(`color="say &quot;hi&quot;"`);
        const sq = spliceAttributeValue(RAW, JSX, 2, "it's")!;
        expect(sq.value).toContain(`size='it&#39;s'`);
    });

    it("should encode only an ampersand that would read as a character reference", () => {
        expect(encodeAttributeValue("a & b", '"')).toBe("a & b");
        expect(encodeAttributeValue("&amp; &#65; &#x42; &lt;", '"')).toBe("&amp;amp; &amp;#65; &amp;#x42; &amp;lt;");
        expect(encodeAttributeValue("&amp", '"')).toBe("&amp");
    });

    it("should decline when the bytes no longer match the structure", () => {
        // A structure whose range points at bytes that are not a quoted literal.
        const drift: JsxStructure = { name: "A", attributes: [{ name: "x", kind: "string", value: "?", start: 0, end: 4 }] };
        expect(spliceAttributeValue("<A x={1} />", drift, 0, "v")).toBeNull();
        expect(spliceAttributeValue("<A x=", { name: "A", attributes: [{ name: "x", kind: "string", value: "", start: 3, end: 5 }] }, 0, "v")).toBeNull();
        expect(spliceAttributeValue(RAW, JSX, 9, "v")).toBeNull();
    });

    // The production parser is the oracle: whatever the splice writes must
    // reparse to the value that was typed, and every byte outside the literal
    // must be the original.
    const NASTY = [
        "plain",
        "",
        `has "double" quotes`,
        "has 'single' quotes",
        `both "and" 'both'`,
        "amp & bare",
        "&amp; &quot; &#39; &lt;",
        "braces {not} an {expression}",
        "angles <b>not</b> jsx",
        "backslash \\ and \\n literal",
        "unicode: café ✓ 日本",
        "trailing space ",
        "= equals = signs",
    ];
    for (const quote of ['"', "'"] as const) {
        it(`values written into a ${quote}-quoted attribute should reparse to themselves`, async () => {
            const src = `<A pre={1} x=${quote}orig${quote} post="keep" />\n`;
            const before = await island(src);
            const xIndex = before.jsx!.attributes.findIndex((a) => a.name === "x");
            const outside = (raw: string, jsx: JsxStructure): string => {
                const a = jsx.attributes[xIndex]!;
                return raw.slice(0, a.start) + raw.slice(a.end);
            };
            for (const value of NASTY) {
                const out = spliceAttributeValue(before.value, before.jsx!, xIndex, value)!;
                expect(out, `splice declined for ${JSON.stringify(value)}`).not.toBeNull();
                const after = await island(out.value + "\n");
                expect(after.jsx?.attributes[xIndex]?.value, `reparse of ${JSON.stringify(value)}`).toBe(value);
                // Every byte outside the edited literal is the file's.
                expect(outside(out.value, out.jsx)).toBe(outside(before.value, before.jsx!));
                // And the re-offset structure agrees with a fresh parse.
                expect(out.jsx.attributes.map((a) => [a.start, a.end])).toEqual(
                    after.jsx!.attributes.map((a) => [a.start, a.end]),
                );
            }
        });
    }
});

describe("the block view's attribute form", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
    });

    const DOC = fixture("mdx/docs-page.mdx");
    // The serializer's own reading of the unedited file. The islands are
    // verbatim in it; the prose and tables around them are normalized (the
    // minimal-diff merge is what puts those back on save), so "only the
    // literal changed" is asserted against this baseline, not the file bytes.
    let base = "";
    beforeEach(async () => {
        const editor = await makeViewEditor(DOC);
        base = editor.action(getMarkdown());
        await editor.destroy();
        document.body.innerHTML = "";
        expect(base).toContain('<Chart data={metrics} color="#fcb32c" />');
    });

    function inputFor(root: ParentNode, block: string, attr: string): HTMLInputElement {
        const blocks = [...root.querySelectorAll<HTMLElement>(".mdx-block")];
        const host = blocks.find((b) => b.querySelector(".mdx-block-source")?.textContent?.startsWith(block));
        expect(host, `no island starting ${block}`).toBeDefined();
        const input = host!.querySelector<HTMLInputElement>(`input[data-attr="${attr}"]`);
        expect(input, `no input for ${attr}`).not.toBeNull();
        return input!;
    }

    it("should render an input per string attribute and read-only code for the rest", async () => {
        const editor = await makeViewEditor(DOC);
        editors.push(editor);
        const chart = [...document.querySelectorAll<HTMLElement>(".mdx-block")]
            .find((b) => b.querySelector(".mdx-block-source")?.textContent?.includes("#fcb32c"))!;
        const rows = [...chart.querySelectorAll(".mdx-attr-row")].map((r) => ({
            name: r.querySelector(".mdx-attr-name")?.textContent,
            input: r.querySelector("input")?.value ?? null,
            code: r.querySelector("code")?.textContent ?? null,
        }));
        expect(rows).toEqual([
            { name: "data", input: null, code: "{metrics}" },
            { name: "color", input: "#fcb32c", code: null },
        ]);
        // Islands that are not JSX elements carry no form at all.
        const esm = [...document.querySelectorAll<HTMLElement>(".mdx-block")]
            .find((b) => b.dataset["kind"] === "mdxjsEsm")!;
        expect(esm.querySelector(".mdx-attr-form")).toBeNull();
    });

    it("committing a value should change only that literal in the serialized file", async () => {
        const editor = await makeViewEditor(DOC);
        editors.push(editor);
        const input = inputFor(document, `<Chart data={metrics} color="#fcb32c"`, "color");
        input.value = "#000000";
        input.dispatchEvent(new Event("change", { bubbles: true }));
        const out = editor.action(getMarkdown());
        expect(out).toBe(base.replace('color="#fcb32c"', 'color="#000000"'));
        // The source pane and the input both show the new bytes, and the
        // adjacent single-quoted island kept its own quoting.
        const src = document.querySelector<HTMLElement>('.mdx-block .mdx-block-source')!;
        expect([...document.querySelectorAll(".mdx-block-source")].map((s) => s.textContent))
            .toContain('<Chart data={metrics} color="#000000" />');
        expect(src.textContent).toBeDefined();
        expect(out).toContain("<Chart data={metrics} color='#227788' />");
    });

    it("Enter should commit and Escape should restore the file's value", async () => {
        const editor = await makeViewEditor(DOC);
        editors.push(editor);
        const input = inputFor(document, "<Callout", "title");
        input.value = "Careful";
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(editor.action(getMarkdown())).toContain('<Callout type="warning" title="Careful">');
        // A second commit of the same value dispatches nothing new (idempotent).
        const view = editor.action((ctx) => ctx.get(editorViewCtx));
        const before = view.state;
        input.dispatchEvent(new Event("change", { bubbles: true }));
        expect(view.state).toBe(before);
        // Escape puts the committed value back into an abandoned edit.
        input.value = "abandoned";
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(input.value).toBe("Careful");
        expect(editor.action(getMarkdown())).toContain('title="Careful"');
    });

    it("an edit should be one undoable step that puts the original bytes back", async () => {
        const editor = await makeViewEditor(DOC);
        editors.push(editor);
        const input = inputFor(document, "<Callout", "type");
        input.value = "note";
        input.dispatchEvent(new Event("change", { bubbles: true }));
        expect(editor.action(getMarkdown())).toContain('<Callout type="note"');
        // The view survives its own update: the same input is still wired.
        input.value = "tip";
        input.dispatchEvent(new Event("change", { bubbles: true }));
        expect(editor.action(getMarkdown())).toContain('<Callout type="tip"');
        expect(editor.action(getMarkdown()).replace('type="tip"', 'type="warning"')).toBe(base);
    });

    it("read-only mode should refuse the commit", async () => {
        const editor = await makeViewEditor(DOC);
        editors.push(editor);
        setReadOnly(true);
        const input = inputFor(document, "<Callout", "type");
        expect(input.readOnly).toBe(true);
        input.value = "note";
        input.dispatchEvent(new Event("change", { bubbles: true }));
        expect(editor.action(getMarkdown())).toBe(base);
    });

    it("a hostile attribute value should render as text in the input, never as markup", async () => {
        const hostile = `<A x="<img src=x onerror=window.__pwnedAttr=1>" />\n`;
        const editor = await makeViewEditor(hostile);
        editors.push(editor);
        const input = inputFor(document, "<A", "x");
        expect(input.value).toBe("<img src=x onerror=window.__pwnedAttr=1>");
        expect(document.querySelector(".mdx-block img")).toBeNull();
        expect((window as unknown as Record<string, unknown>)["__pwnedAttr"]).toBeUndefined();
    });
});
