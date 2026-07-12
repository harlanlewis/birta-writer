/**
 * The heading gutter shows an `H1`..`H6` badge — the same identity the slash
 * menu's heading rows show in their icon slot (2026-07: replaced the literal
 * `#` hashes when the whole gutter moved to slash-menu iconography; the
 * hashes remain visible as each slash row's hint).
 */
import { describe, it, expect, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx } from "@milkdown/core";
import { gfm } from "@milkdown/preset-gfm";
import { configureSerialization, pureCommonmark } from "../serialization";
import { headingFoldPlugin } from "../plugins/headingFold";

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
        .use(headingFoldPlugin)
        .create();
    editors.push(editor);
    return editor;
}

afterEach(async () => {
    for (const editor of editors) {
        await editor.destroy();
    }
    editors = [];
    document.body.innerHTML = "";
});

describe("heading gutter badge", () => {
    it("each heading level should render its slash-menu H-badge", async () => {
        await makeEditor("# One\n\n## Two\n\n### Three\n\n###### Six");
        const badges = Array.from(
            document.querySelectorAll(".heading-fold-marker:not(.heading-fold-marker--block)"),
        ).map((el) => el.textContent);
        expect(badges).toEqual(["H1", "H2", "H3", "H6"]);
    });

    it("the badge should update live when the heading level changes", async () => {
        const editor = await makeEditor("## Title");
        const view = (await import("@milkdown/core")).editorViewCtx;
        const v = editor.action((ctx) => ctx.get(view));
        const { setHeadingLevelAt } = await import("../plugins/headingFold");
        expect(setHeadingLevelAt(v, 0, 3)).toBe(true);
        const badge = document.querySelector(
            ".heading-fold-marker:not(.heading-fold-marker--block)",
        );
        expect(badge?.textContent).toBe("H3");
    });
});
