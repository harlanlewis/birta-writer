import { describe, it, expect } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfm } from "@milkdown/preset-gfm";
import { langLabelHtml } from "../components/codeBlock";

/**
 * End-to-end regression test for the code-block language-token XSS.
 *
 * Chain: a fenced code block's info string -> ProseMirror node.attrs.language (document-controlled)
 * -> the language-picker button's innerHTML. This drives the REAL markdown parser
 * (@milkdown/preset-commonmark, as the editor uses) and the REAL render helper (langLabelHtml)
 * against a REAL jsdom DOM — no fakes.
 *
 * Payload note: `<svg/onload=alert(1)>` is space-free, so the parser keeps it whole as the language
 * token (a space-containing payload is truncated at the first word). It was confirmed to actually
 * fire in real Chromium 149 (and the escaped langLabelHtml output confirmed inert there) via an
 * out-of-band headless-browser run; jsdom builds the element but does not dispatch load/error
 * events, so here we assert on element injection, which is parser-robust and catches regressions.
 */

async function parseCodeBlockLanguage(markdown: string): Promise<string> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, markdown);
        })
        .use(commonmark)
        .use(gfm)
        .create();

    let language = "";
    editor.action((ctx) => {
        ctx.get(editorViewCtx).state.doc.descendants((node) => {
            if (node.type.name === "code_block") {
                language = node.attrs["language"] ?? "";
                return false;
            }
            return true;
        });
    });
    await editor.destroy();
    root.remove();
    return language;
}

describe("code-block language-token XSS", () => {
    const PAYLOAD_FENCE = "```<svg/onload=alert(1)>\ncode\n```\n";

    it("the real parser preserves an HTML payload in the code-block language attr (the attack surface)", async () => {
        const language = await parseCodeBlockLanguage(PAYLOAD_FENCE);
        expect(language).toBe("<svg/onload=alert(1)>");
    });

    it("langLabelHtml neutralizes the payload so no live element is created in the real DOM", async () => {
        const language = await parseCodeBlockLanguage(PAYLOAD_FENCE);

        const host = document.createElement("div");
        host.innerHTML = langLabelHtml(language);

        // Scope to the label span: langLabelHtml legitimately appends a chevron <svg> icon as a
        // sibling, so we assert the PAYLOAD produced no element inside the label itself.
        expect(host.querySelector(".lang-picker-label svg")).toBeNull();
        expect(host.querySelector(".lang-picker-label [onload]")).toBeNull();
        // The payload survives only as inert text inside the label span.
        expect(host.querySelector(".lang-picker-label")?.textContent).toContain("<svg");
    });

    it("negative control: WITHOUT escaping, the payload injects a live element (proves the test can catch a regression)", async () => {
        const language = await parseCodeBlockLanguage(PAYLOAD_FENCE);

        const host = document.createElement("div");
        // Deliberately unescaped — what the vulnerable code did before the fix. In a real browser
        // this element's onload also fires (confirmed in Chromium); jsdom only builds the element.
        host.innerHTML = `<span class="lang-picker-label">${language}</span>`;

        expect(host.querySelector("svg")).not.toBeNull();
    });

    it("a normal language token renders a friendly label unchanged", async () => {
        const language = await parseCodeBlockLanguage("```typescript\nconst x = 1;\n```\n");
        expect(language).toBe("typescript");

        const host = document.createElement("div");
        host.innerHTML = langLabelHtml(language);
        expect(host.querySelector(".lang-picker-label")?.textContent).toBe("TypeScript");
    });
});
