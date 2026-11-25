/**
 * Template directives drawn as source (utils/templateDirectives.ts, the
 * recognizer; plugins/templateDirectives.ts, the decoration layer).
 *
 * Three layers: the grammar over plain strings, including the prose and code
 * it must refuse; the textblock reading against the REAL editor's parse, which
 * is where code spans, html atoms and soft breaks come from; and the plugin,
 * that it builds nothing on the mount path, redoes only what an edit touched,
 * and leaves the serialized bytes exactly as they were.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Editor } from "@milkdown/core";
import { getMarkdown } from "@milkdown/utils";
import type { EditorView, Node as ProseNode } from "../pm";
import { findDirectives, blockDirectives, type BlockDirectives } from "../utils/templateDirectives";
import { templateDirectivesKey, templateDirectivesPlugin } from "../plugins/templateDirectives";
import { applyMinimalChanges, computeRoundTripProtection } from "../utils/minimalDiff";
import { PROGRESSIVE_APPEND_META } from "../plugins/docChange";
import { editorView, loadCorpusFixtures, makeCorpusEditor } from "./helpers/moveFuzz";

const spans = (text: string): string[] => findDirectives(text).map((s) => text.slice(s.from, s.to));

describe("findDirectives: the delimiter grammar", () => {
    beforeEach(() => { vi.clearAllMocks(); });

    it("each delimiter family should be recognized whole", () => {
        expect(spans("{{< shots >}}")).toEqual(["{{< shots >}}"]);
        expect(spans("{{% notice tip %}}")).toEqual(["{{% notice tip %}}"]);
        expect(spans("{{</* ref \"x\" */>}}")).toEqual(["{{</* ref \"x\" */>}}"]);
        expect(spans("{% include note.html %}")).toEqual(["{% include note.html %}"]);
        expect(spans("{%- if x -%}")).toEqual(["{%- if x -%}"]);
        expect(spans("{{ site.title | escape }}")).toEqual(["{{ site.title | escape }}"]);
        expect(spans("{# a comment #}")).toEqual(["{# a comment #}"]);
        expect(spans("{{#each people}}{{/each}}")).toEqual(["{{#each people}}", "{{/each}}"]);
        expect(spans("{{> byline }}")).toEqual(["{{> byline }}"]);
        expect(spans("{{ . }}")).toEqual(["{{ . }}"]);
    });

    it("a triple-stache should be one directive, never a double inside it", () => {
        expect(spans("{{{ this.bio }}}")).toEqual(["{{{ this.bio }}}"]);
        expect(spans("a {{{ raw }}} b {{ x }}")).toEqual(["{{{ raw }}}", "{{ x }}"]);
    });

    it("several directives on one line should each be found, in order", () => {
        expect(spans("{% raw %}{{ not expanded }}{% endraw %}"))
            .toEqual(["{% raw %}", "{{ not expanded }}", "{% endraw %}"]);
    });

    it("braces that name nothing should not be directives", () => {
        expect(spans("{{}}")).toEqual([]);
        expect(spans("{{ }}")).toEqual([]);
        expect(spans("{% %}")).toEqual([]);
        expect(spans("{##}")).toEqual([]);
        expect(spans("{{< >}}")).toEqual([]);
    });

    it("ordinary braces in prose should not be directives", () => {
        expect(spans("a set {a, b} and {x}")).toEqual([]);
        expect(spans("a JSON object {\"a\": {\"b\": 1}} inline")).toEqual([]);
        expect(spans("[{\"a\": 1}, {\"b\": 2}]")).toEqual([]);
        expect(spans("pandoc attributes {#sec-intro .unnumbered}")).toEqual([]);
        expect(spans("an unclosed {{ directive")).toEqual([]);
        expect(spans("a 50% {discount}")).toEqual([]);
    });

    it("a directive should not run across a line break or a placeholder", () => {
        expect(spans("{{ a\nb }}")).toEqual([]);
        expect(spans("{{ a\uFFFCb }}")).toEqual([]);
    });

    it("a double-stache running into a stray brace should be drawn whole, not cut short", () => {
        expect(spans("{{ page.title }}}")).toEqual(["{{ page.title }}}"]);
        expect(spans("{{ x }}}} and {{ y }}")).toEqual(["{{ x }}}}", "{{ y }}"]);
    });

    it("a nested opener should leave the inner directive, not swallow both", () => {
        expect(spans("{{ a {{ b }}")).toEqual(["{{ b }}"]);
    });

    it("text with no brace should cost one scan and find nothing", () => {
        expect(findDirectives("plain prose, nothing to see")).toEqual([]);
    });
});

// ── The textblock reading, against the real parse ──────────────────────────

let editors: Editor[] = [];

async function open(markdown: string, withPlugin = false): Promise<EditorView> {
    const editor = await makeCorpusEditor(markdown, withPlugin ? [templateDirectivesPlugin] : []);
    editors.push(editor);
    return editorView(editor);
}

/** Every textblock's reading, with the matched text and the break neighbours. */
function readAll(doc: ProseNode): Array<{ text: string[]; breaks: number; atoms: string[] }> {
    const out: Array<{ text: string[]; breaks: number; atoms: string[] }> = [];
    doc.descendants((node, pos) => {
        if (!node.isTextblock) return true;
        const r: BlockDirectives = blockDirectives(node, pos + 1);
        if (r.directives.length) {
            out.push({
                text: r.directives.map((d) => doc.textBetween(d.from, d.to, undefined, (n) => String(n.attrs["value"] ?? ""))),
                breaks: r.lineBreaks.length,
                atoms: r.directives.flatMap((d) => d.atoms.map((a) => a.value)),
            });
        }
        return false;
    });
    return out;
}

describe("blockDirectives: a textblock as the editor parsed it", () => {
    beforeEach(() => { vi.clearAllMocks(); });
    afterEach(async () => {
        for (const e of editors) await e.destroy();
        editors = [];
        document.body.innerHTML = "";
    });

    it("a paired shortcode around images should keep both of its lines", async () => {
        const v = await open("{{< shots >}}\n![A box](a.webp)\n![A clip](b.webp)\n{{< /shots >}}\n");
        const [block] = readAll(v.state.doc);
        expect(block?.text).toEqual(["{{< shots >}}", "{{< /shots >}}"]);
        // The break after the opener and the break before the closer; the
        // break between the two images is an ordinary soft break.
        expect(block?.breaks).toBe(2);
        const para = v.state.doc.firstChild!;
        const r = blockDirectives(para, 1);
        const breakNodes = r.lineBreaks.map((p) => v.state.doc.nodeAt(p)?.type.name);
        expect(breakNodes).toEqual(["hardbreak", "hardbreak"]);
        const leaf = (n: ProseNode): string => (n.type.name === "image" ? "[img]" : "|");
        // Between the two decorated breaks: both images and the ordinary
        // soft break between them.
        expect(v.state.doc.textBetween(r.lineBreaks[0]! + 1, r.lineBreaks[1]!, undefined, leaf)).toBe("[img]|[img]");
    });

    it("a directive sharing its line with prose should not claim the line", async () => {
        const v = await open("See {{< ref \"x.md\" >}} for more\nand a second line\n");
        expect(readAll(v.state.doc)).toEqual([{ text: ["{{< ref \"x.md\" >}}"], breaks: 0, atoms: [] }]);
    });

    it("a line holding two directives and spaces should still be a directive line", async () => {
        const v = await open("prose above\n{% if a %} {% endif %}\nprose below\n");
        expect(readAll(v.state.doc)[0]?.breaks).toBe(2);
    });

    it("an inline code span should never be read as a directive", async () => {
        const v = await open("Use `{{ code }}` and `{% tag %}` here, but {{ real }} counts.\n");
        expect(readAll(v.state.doc)).toEqual([{ text: ["{{ real }}"], breaks: 0, atoms: [] }]);
    });

    it("a directive running into a code span should not be recognized", async () => {
        const v = await open("{{ a `b` c }}\n");
        expect(readAll(v.state.doc)).toEqual([]);
    });

    it("a fenced code block should hold no directives", async () => {
        const v = await open("```liquid\n{% assign x = 1 %}\n{{ x }}\n```\n");
        expect(v.state.doc.firstChild?.type.spec.code).toBe(true);
        expect(readAll(v.state.doc)).toEqual([]);
    });

    it("a shortcode whose middle parses as an html tag should be read whole, through the atom", async () => {
        const v = await open("{{<figure src=\"a.png\">}}\n");
        // The parse this exists for: the middle really is an html atom.
        expect(v.state.doc.firstChild?.content.toJSON()?.map((n: { type: string }) => n.type))
            .toEqual(["text", "html", "text"]);
        expect(readAll(v.state.doc)).toEqual([
            { text: ["{{<figure src=\"a.png\">}}"], breaks: 0, atoms: ["<figure src=\"a.png\">"] },
        ]);
    });

    it("a directive inside an html atom's own bytes should not be decorated", async () => {
        const v = await open("A <span title=\"{{ x }}\">tip</span> here.\n");
        expect(readAll(v.state.doc)).toEqual([]);
    });

    it("headings, list items, quotes and table cells should all be read", async () => {
        const v = await open([
            "## {{ page.title }}",
            "",
            "- {{ item.name }}",
            "",
            "> quoted {{ site.author }}",
            "",
            "| k | v |",
            "| --- | --- |",
            "| t | {{ page.title }} |",
            "",
        ].join("\n"));
        expect(readAll(v.state.doc).map((b) => b.text[0])).toEqual([
            "{{ page.title }}", "{{ item.name }}", "{{ site.author }}", "{{ page.title }}",
        ]);
    });

    it("a hard break should never be decorated, since it already ends its line", async () => {
        const v = await open("prose\\\n{{< x >}}\\\nmore\n");
        expect(readAll(v.state.doc)[0]?.breaks).toBe(0);
    });

    it("plain prose and JSON should produce no reading", async () => {
        const v = await open("A set {a, b}, a JSON object {\"a\": {\"b\": 1}}, and {% %}.\n");
        expect(readAll(v.state.doc)).toEqual([]);
    });
});

// ── The plugin ──────────────────────────────────────────────────────────────

function decorated(v: EditorView): string[] {
    const set = templateDirectivesKey.getState(v.state)?.set;
    if (!set) return [];
    return set.find()
        .filter((d) => (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs["class"] === "tpl-directive")
        .sort((a, b) => a.from - b.from)
        .map((d) => v.state.doc.textBetween(d.from, d.to, undefined, (n) => String(n.attrs["value"] ?? "")));
}

function lineBreakCount(v: EditorView): number {
    const set = templateDirectivesKey.getState(v.state)?.set;
    return (set?.find() ?? [])
        .filter((d) => (d as unknown as { type: { attrs: Record<string, string> } }).type.attrs["class"] === "tpl-line-break")
        .length;
}

describe("templateDirectivesPlugin", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        // Before any editor is made: the idle first pass falls back to
        // setTimeout in jsdom, and a real-clock timer would never be advanced.
        vi.useFakeTimers();
    });
    afterEach(async () => {
        vi.useRealTimers();
        for (const e of editors) await e.destroy();
        editors = [];
        document.body.innerHTML = "";
    });

    /** Let the idle first pass run, its lazy chunk load, and its dispatch land. */
    const settle = async (): Promise<void> => {
        await vi.advanceTimersByTimeAsync(50);
        await import("../plugins/templateDirectiveDecorations");
        await vi.advanceTimersByTimeAsync(0);
    };

    it("nothing should be decorated before the deferred first pass runs", async () => {
        const v = await open("{{< shots >}}\n![A box](a.webp)\n{{< /shots >}}\n", true);
        expect(decorated(v)).toEqual([]);
        await settle();
        expect(decorated(v)).toEqual(["{{< shots >}}", "{{< /shots >}}"]);
        expect(lineBreakCount(v)).toBe(2);
    });

    it("typing into one paragraph should redo that paragraph and keep the rest", async () => {
        const v = await open("{{ a }}\n\nplain\n\n{{ c }}\n", true);
        await settle();
        const before = templateDirectivesKey.getState(v.state)!.set.find();
        const lastDeco = before.find((d) => v.state.doc.textBetween(d.from, d.to) === "{{ c }}")!;

        // Type a directive into the middle paragraph, one character at a time.
        let pos = 0;
        v.state.doc.forEach((n, offset, i) => { if (i === 1) pos = offset + 1 + n.content.size; });
        for (const ch of " {{ b }}") {
            v.dispatch(v.state.tr.insertText(ch, pos));
            pos += 1;
        }
        expect(decorated(v)).toEqual(["{{ a }}", "{{ b }}", "{{ c }}"]);
        // The untouched paragraph's decoration was mapped, not rebuilt: the
        // same spec object survives.
        const after = templateDirectivesKey.getState(v.state)!.set.find();
        const mappedLast = after.find((d) => v.state.doc.textBetween(d.from, d.to) === "{{ c }}")!;
        expect((mappedLast as unknown as { type: unknown }).type).toBe((lastDeco as unknown as { type: unknown }).type);
    });

    it("breaking a directive by typing inside it should withdraw its decoration", async () => {
        const v = await open("{{ a }}\n", true);
        await settle();
        expect(decorated(v)).toEqual(["{{ a }}"]);
        // Delete the closing braces.
        const end = 1 + v.state.doc.firstChild!.content.size;
        v.dispatch(v.state.tr.delete(end - 2, end));
        expect(decorated(v)).toEqual([]);
    });

    it("toggling inline code over a directive should withdraw and restore it", async () => {
        const v = await open("Use {{ site.title }} here\n", true);
        await settle();
        expect(decorated(v)).toEqual(["{{ site.title }}"]);
        const from = 1 + "Use ".length;
        const to = from + "{{ site.title }}".length;
        const code = v.state.schema.marks["inlineCode"]!;
        v.dispatch(v.state.tr.addMark(from, to, code.create()));
        expect(decorated(v)).toEqual([]);
        v.dispatch(v.state.tr.removeMark(from, to, code));
        expect(decorated(v)).toEqual(["{{ site.title }}"]);
    });

    it("a progressive-open chunk landing at the window's end should not widen the window", async () => {
        const v = await open("{{ a }}\n", true);
        await settle();
        const size = v.state.doc.content.size;
        v.dispatch(v.state.tr.setMeta(templateDirectivesKey, { window: { from: 0, to: size } }));
        const chunk = v.state.schema.nodes["paragraph"]!.create(null, v.state.schema.text("{{ b }}"));
        v.dispatch(v.state.tr.insert(size, chunk).setMeta(PROGRESSIVE_APPEND_META, true));
        expect(templateDirectivesKey.getState(v.state)?.window).toEqual({ from: 0, to: size });
        expect(decorated(v)).toEqual(["{{ a }}"]);
        // The control: the same insert at the same place as an ordinary edit
        // is inside the window, and is redone.
        v.dispatch(v.state.tr.insert(size, chunk));
        expect(decorated(v)).toEqual(["{{ a }}", "{{ b }}"]);
    });

    it("an edit to the off-screen part of a block straddling the window's edge should redo that block", async () => {
        const v = await open("{{ a }} and a long paragraph that runs past the window\n\nplain\n", true);
        await settle();
        const first = v.state.doc.firstChild!;
        const mid = 1 + 12; // inside the first paragraph, after "{{ a }}"
        v.dispatch(v.state.tr.setMeta(templateDirectivesKey, { window: { from: 0, to: mid } }));
        expect(decorated(v)).toEqual(["{{ a }}"]);
        // Past window.to, but inside the paragraph the window was built over.
        v.dispatch(v.state.tr.insertText(" {{ b }}", 1 + first.content.size));
        expect(decorated(v)).toEqual(["{{ a }}", "{{ b }}"]);
        // The control: a block wholly past the window is not redone.
        const second = v.state.doc.content.size - 1;
        v.dispatch(v.state.tr.insertText(" {{ c }}", second));
        expect(decorated(v)).toEqual(["{{ a }}", "{{ b }}"]);
    });

    it("a transaction that changes no content should leave the state untouched", async () => {
        const v = await open("{{ a }}\n", true);
        await settle();
        const state = templateDirectivesKey.getState(v.state);
        v.dispatch(v.state.tr.setMeta("probe", true));
        expect(templateDirectivesKey.getState(v.state)).toBe(state);
    });

    it("the plugin should leave the serialized bytes exactly as they are", async () => {
        const fixture = loadCorpusFixtures().find((f) => f.name === "template-directives.md");
        expect(fixture, "the template-directives corpus fixture is missing").toBeDefined();
        const source = fixture!.content;
        const plain = await makeCorpusEditor(source);
        editors.push(plain);
        const editor = await makeCorpusEditor(source, [templateDirectivesPlugin]);
        editors.push(editor);
        await settle();
        // The fixture really was decorated, or this proves nothing.
        expect(decorated(editorView(editor)).length).toBeGreaterThan(15);
        const serialized = editor.action(getMarkdown());
        expect(serialized).toBe(plain.action(getMarkdown()));
        // And the save the page makes from it is the file, byte for byte.
        const protection = computeRoundTripProtection(source, serialized);
        expect(applyMinimalChanges(source, serialized, protection)).toBe(source);
    });
});

// ── Invariants over the whole corpus ───────────────────────────────────────

describe("template directives over the corpus", () => {
    afterEach(async () => {
        for (const e of editors) await e.destroy();
        editors = [];
        document.body.innerHTML = "";
    });

    it("every directive should be bytes that are in the source, outside code", async () => {
        const fixtures = loadCorpusFixtures();
        // The corpus is large enough to matter and this fixture is in it.
        expect(fixtures.length).toBeGreaterThan(20);
        let directives = 0;
        let files = 0;
        for (const f of fixtures) {
            const v = await open(f.content);
            let found = 0;
            v.state.doc.descendants((node, pos) => {
                if (!node.isTextblock) return true;
                const r = blockDirectives(node, pos + 1);
                for (const d of r.directives) {
                    const text = v.state.doc.textBetween(d.from, d.to, undefined, (n) => String(n.attrs["value"] ?? ""));
                    expect(f.content, `${f.name}: ${JSON.stringify(text)} is not in the source`).toContain(text);
                    // No code mark anywhere inside the span.
                    v.state.doc.nodesBetween(d.from, d.to, (n) => {
                        expect(n.marks.some((m) => m.type.spec.code), `${f.name}: code inside ${text}`).toBe(false);
                    });
                    found++;
                }
                for (const p of r.lineBreaks) {
                    const br = v.state.doc.nodeAt(p);
                    expect(br?.type.name === "hardbreak" && br.attrs["isInline"], `${f.name}: line break at ${p}`).toBe(true);
                }
                return false;
            });
            directives += found;
            if (found) files++;
            await editors.pop()!.destroy();
        }
        // The instrument reached something: the dedicated fixture alone holds
        // more than this, and quarto.md holds its shortcodes.
        expect(directives).toBeGreaterThan(20);
        expect(files).toBeGreaterThanOrEqual(2);
    });
});
