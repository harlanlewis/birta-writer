/**
 * wikiLinkComplete tests: the caret-anchored dropdown that opens while
 * typing inside an unclosed `[[partial` construct, offering Obsidian-style
 * bare names derived from the workspace-file reply, and converting the
 * construct into a real wiki_link atom on pick. Drives the REAL Milkdown
 * editor; only the Extension reply is simulated (setup.ts injects
 * acquireVsCodeApi).
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { TextSelection } from "../pm";
import type { EditorView } from "../pm";
import { getMarkdown } from "@milkdown/utils";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { wikiLinkCompletePlugin, wikiNameOf, rankWikiNames } from "../plugins/wikiLinkComplete";
import { dispatchLinkTargetSuggestions } from "../components/pathLink/linkTargetComplete";

const ITEMS = [
    { relative: "../uber/index.md", rootRelative: "/write/uber/index.md" },
    { relative: "../plans/plan.md", rootRelative: "/notes/plan.md" },
    { relative: "../archive/plan.md", rootRelative: "/archive/2019/plan.md" },
    { relative: "assets/pic.png", rootRelative: "/write/hugo/assets/pic.png" },
];

async function makeEditor(markdown: string): Promise<Editor> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    return Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
            configureSerialization(ctx);
        })
        .use(pureCommonmark)
        .use(gfmFidelity)
        .use(wikiLinkCompletePlugin)
        .create();
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

function placeCursorAtEnd(v: EditorView): void {
    const end = v.state.doc.content.size - 1;
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, end)));
}

function typeText(v: EditorView, text: string): void {
    const { from, to } = v.state.selection;
    v.dispatch(v.state.tr.insertText(text, from, to));
}

function postedRequests(): Array<{ id: string; query: string }> {
    return mockVscodeApi.postMessage.mock.calls
        .map(([msg]) => msg as { type: string; id?: string; query?: string })
        .filter((msg) => msg.type === "getLinkTargetSuggestions")
        .map((msg) => ({ id: msg.id!, query: msg.query! }));
}

function reply(items = ITEMS): void {
    const last = postedRequests().at(-1);
    expect(last).toBeDefined();
    dispatchLinkTargetSuggestions(last!.id, items);
}

function optionTexts(): string[] {
    return Array.from(
        document.querySelectorAll(".fm-suggest-menu .fm-suggest-item"),
    ).map((li) => li.textContent ?? "");
}

describe("wikiNameOf", () => {
    it("derives bare names from markdown paths", () => {
        expect(wikiNameOf("/notes/My Page.md")).toBe("My Page");
        expect(wikiNameOf("/write/uber/index.md")).toBe("uber");
        expect(wikiNameOf("/write/_index.md")).toBe("write");
        expect(wikiNameOf("/pic.png")).toBe(null);
    });
});

describe("rankWikiNames", () => {
    it("dedupes unique names and disambiguates duplicates as paths", () => {
        const rows = rankWikiNames(ITEMS, "");
        const texts = rows.map((r) => r.text);
        expect(texts).toContain("uber");
        expect(texts).toContain("notes/plan");
        expect(texts).toContain("archive/2019/plan");
        expect(texts).not.toContain("plan");
        expect(texts).not.toContain("pic");
    });

    it("filters by case-insensitive substring, prefix matches first", () => {
        const rows = rankWikiNames(
            [
                { relative: "a", rootRelative: "/deep/superuber.md" },
                { relative: "b", rootRelative: "/write/uber/index.md" },
            ],
            "ub",
        );
        expect(rows.map((r) => r.text)).toEqual(["uber", "superuber"]);
    });
});

describe("caret wikilink autocompletion", () => {
    let editor: Editor;
    let v: EditorView;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        delete window.__i18n;
        editor = await makeEditor("x\n");
        v = view(editor);
        placeCursorAtEnd(v);
        vi.useFakeTimers();
    });

    afterEach(async () => {
        vi.useRealTimers();
        await editor.destroy();
    });

    it("typing [[query requests suggestions and shows bare names", async () => {
        typeText(v, " [[ub");
        await vi.advanceTimersByTimeAsync(250);
        reply();

        expect(postedRequests().at(-1)?.query).toBe("ub");
        expect(optionTexts()).toContain("uber");
    });

    it("picking converts the construct into a wiki_link atom", async () => {
        typeText(v, " [[ub");
        await vi.advanceTimersByTimeAsync(250);
        reply();

        const li = Array.from(
            document.querySelectorAll(".fm-suggest-menu .fm-suggest-item"),
        ).find((el) => el.textContent === "uber")!;
        li.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        let raw: string | null = null;
        v.state.doc.descendants((node) => {
            if (node.type.name === "wiki_link") raw = node.attrs["raw"] as string;
        });
        expect(raw).toBe("uber");
        expect(editor.action(getMarkdown())).toBe("x [[uber]]\n");
    });

    it("stops suggesting once the partial contains # or |", async () => {
        typeText(v, " [[plan#");
        await vi.advanceTimersByTimeAsync(250);

        expect(postedRequests()).toHaveLength(0);
    });

    it("a bare [[ requests immediately with an empty query", async () => {
        typeText(v, " [[");
        await vi.advanceTimersByTimeAsync(250);
        reply();

        expect(postedRequests().at(-1)?.query).toBe("");
        // Every markdown file is offered, ranked; non-md files are not.
        expect(optionTexts()).toContain("uber");
        expect(optionTexts()).not.toContain("pic");
    });

    it("is disabled when smartLinks is off", async () => {
        window.__i18n = { translations: {}, isMac: false, smartLinks: false };
        typeText(v, " [[ub");
        await vi.advanceTimersByTimeAsync(250);

        expect(postedRequests()).toHaveLength(0);
    });
});
