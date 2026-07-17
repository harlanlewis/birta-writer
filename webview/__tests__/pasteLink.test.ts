import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { TextSelection } from "../pm";
import type { EditorView } from "../pm";
import { configureSerialization, gfmFidelity, pureCommonmark } from "../serialization";
import { detectPastedLinkTarget, pasteLinkPlugin } from "@/plugins/pasteLink";
import * as unfurl from "@/unfurl";
import { findBareLinkRange } from "@/unfurl";
import { mockVscodeApi } from "./setup";

describe("detectPastedLinkTarget", () => {
    describe("scheme URLs", () => {
        it("an https URL should be returned verbatim", () => {
            expect(detectPastedLinkTarget("https://example.com")).toBe("https://example.com");
        });

        it("an http URL with a path and query should be returned verbatim", () => {
            const u = "http://foo.example.com/a/b?c=d&e=f#frag";
            expect(detectPastedLinkTarget(u)).toBe(u);
        });

        it("a mailto: URL should be returned verbatim", () => {
            expect(detectPastedLinkTarget("mailto:a@b.com")).toBe("mailto:a@b.com");
        });

        it("an ftp URL should be returned verbatim", () => {
            expect(detectPastedLinkTarget("ftp://host.tld/file")).toBe("ftp://host.tld/file");
        });

        it("surrounding whitespace should be trimmed before matching", () => {
            expect(detectPastedLinkTarget("  https://example.com \n")).toBe("https://example.com");
        });
    });

    describe("bare web domains", () => {
        it("a bare domain should be returned verbatim (no scheme prepended)", () => {
            expect(detectPastedLinkTarget("example.com")).toBe("example.com");
        });

        it("a www.-prefixed domain with a path should be accepted", () => {
            expect(detectPastedLinkTarget("www.foo.com/path")).toBe("www.foo.com/path");
        });

        it("a multi-label subdomain should be accepted", () => {
            expect(detectPastedLinkTarget("docs.foo.co.uk")).toBe("docs.foo.co.uk");
        });

        it("a domain with a query string (no path) should be accepted verbatim", () => {
            expect(detectPastedLinkTarget("example.com?q=1&r=2")).toBe("example.com?q=1&r=2");
        });

        it("a domain with only a fragment should be accepted verbatim", () => {
            expect(detectPastedLinkTarget("example.com#section")).toBe("example.com#section");
        });

        it("a domain on a popular TLD that doubles as a file extension should link", () => {
            // .io / .sh-style collisions: popular TLDs stay linkable.
            expect(detectPastedLinkTarget("example.io")).toBe("example.io");
        });
    });

    describe("rejected — pastes normally (null)", () => {
        it("empty or whitespace-only input should return null", () => {
            expect(detectPastedLinkTarget("")).toBeNull();
            expect(detectPastedLinkTarget("   ")).toBeNull();
        });

        it("multi-word text should return null", () => {
            expect(detectPastedLinkTarget("see https://example.com now")).toBeNull();
        });

        it("a markdown link payload should return null", () => {
            expect(detectPastedLinkTarget("[text](https://example.com)")).toBeNull();
        });

        it("a wikilink payload should return null", () => {
            expect(detectPastedLinkTarget("[[Page]]")).toBeNull();
        });

        it("a bare filename with a doc extension should return null", () => {
            expect(detectPastedLinkTarget("notes.md")).toBeNull();
            expect(detectPastedLinkTarget("diagram.png")).toBeNull();
            expect(detectPastedLinkTarget("data.json")).toBeNull();
        });

        it("a source-code filename should return null (not linked as a domain)", () => {
            expect(detectPastedLinkTarget("app.ts")).toBeNull();
            expect(detectPastedLinkTarget("script.js")).toBeNull();
            expect(detectPastedLinkTarget("styles.css")).toBeNull();
            expect(detectPastedLinkTarget("index.html")).toBeNull();
            expect(detectPastedLinkTarget("build.sh")).toBeNull();
            expect(detectPastedLinkTarget("main.rs")).toBeNull();
        });

        it("an archive or media filename should return null", () => {
            expect(detectPastedLinkTarget("archive.zip")).toBeNull();
            expect(detectPastedLinkTarget("bundle.tar.gz")).toBeNull();
            expect(detectPastedLinkTarget("report.docx")).toBeNull();
            expect(detectPastedLinkTarget("clip.mov")).toBeNull();
        });

        it("a version tag or IP-like token (numeric last label) should return null", () => {
            expect(detectPastedLinkTarget("v1.2")).toBeNull();
            expect(detectPastedLinkTarget("1.2.3.4")).toBeNull();
            expect(detectPastedLinkTarget("10.0.0.1")).toBeNull();
            expect(detectPastedLinkTarget("clip.mp4")).toBeNull();
        });

        it("a dotted identifier with a single-char last label should return null", () => {
            expect(detectPastedLinkTarget("a.b.c.d")).toBeNull();
            expect(detectPastedLinkTarget("main.c")).toBeNull();
        });

        it("a workspace path should return null", () => {
            expect(detectPastedLinkTarget("./notes/x.md")).toBeNull();
            expect(detectPastedLinkTarget("/docs/y")).toBeNull();
            expect(detectPastedLinkTarget("../z")).toBeNull();
        });

        it("a plain word with no dot should return null", () => {
            expect(detectPastedLinkTarget("example")).toBeNull();
        });

        it("an anchor fragment should return null", () => {
            expect(detectPastedLinkTarget("#heading")).toBeNull();
        });
    });
});

// ── Paste-unfurl: empty-selection paste behavior (MAR-178) ──────────────────
// Drives the REAL Milkdown editor with the pasteLinkPlugin registered, and
// simulates a paste via the plugin's handlePaste prop. Detection reuses the
// same detectPastedLinkTarget (covered above); these tests cover the empty-
// selection BRANCH: it inserts a link mark, fires the unfurl request, respects
// the code/existing-link guards, and honors the feature gate.

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
        .use(pasteLinkPlugin)
        .create();
}

function view(editor: Editor): EditorView {
    return editor.action((ctx) => ctx.get(editorViewCtx));
}

/** A minimal ClipboardEvent carrying `text` as text/plain. */
function pasteEventWith(text: string): ClipboardEvent {
    return {
        clipboardData: { getData: (fmt: string) => (fmt === "text/plain" ? text : "") },
        preventDefault: () => {},
    } as unknown as ClipboardEvent;
}

/** Invoke the plugin's handlePaste prop; returns whether it handled the paste. */
function firePaste(v: EditorView, text: string): boolean {
    return v.someProp("handlePaste", (f) => f(v, pasteEventWith(text), (undefined as unknown as never))) ?? false;
}

/** True when some text node in the doc carries a link mark with the given href. */
function hasLinkMark(v: EditorView, href: string): boolean {
    let found = false;
    v.state.doc.descendants((node) => {
        if (node.isText && node.marks.some((m) => m.type.name === "link" && m.attrs["href"] === href)) {
            found = true;
        }
    });
    return found;
}

describe("paste-unfurl empty-selection paste", () => {
    let editor: Editor;
    let v: EditorView;

    beforeEach(async () => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
        delete window.__i18n; // default: pasteUnfurl enabled
        // Don't arm the real 15s backstop timer during these unit tests.
        vi.spyOn(unfurl, "registerPendingUnfurl").mockImplementation(() => {});
    });

    afterEach(async () => {
        await editor.destroy();
        vi.restoreAllMocks();
    });

    async function setupAtEnd(markdown: string): Promise<void> {
        editor = await makeEditor(markdown);
        v = view(editor);
        const end = v.state.doc.content.size - 1;
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, end)));
    }

    it("a bare URL pasted on an empty selection should insert a link and request an unfurl", async () => {
        await setupAtEnd("hello \n");
        const url = "https://example.com";

        const handled = firePaste(v, url);

        expect(handled).toBe(true);
        // Inserted as a link mark over the URL text (i.e. [url](url)).
        expect(hasLinkMark(v, url)).toBe(true);
        expect(v.state.doc.textContent).toContain(url);
        // Fired the fetch request through the messaging funnel.
        const posted = mockVscodeApi.postMessage.mock.calls
            .map((c) => c[0] as { type: string; url?: string })
            .filter((m) => m.type === "unfurlUrl");
        expect(posted.length).toBe(1);
        expect(posted[0]!.url).toBe(url);
        expect(unfurl.registerPendingUnfurl).toHaveBeenCalledOnce();
    });

    it("multi-word prose containing a URL should paste normally (not unfurled)", async () => {
        await setupAtEnd("hello \n");

        const handled = firePaste(v, "see https://example.com now");

        expect(handled).toBe(false);
        expect(hasLinkMark(v, "https://example.com")).toBe(false);
        expect(mockVscodeApi.postMessage).not.toHaveBeenCalled();
    });

    it("a paste inside an existing link should not be unfurled", async () => {
        await makeEditorInto("[foo](https://foo.com)\n");
        // Caret in the middle of the linked word "foo".
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 2)));

        const handled = firePaste(v, "https://example.com");

        expect(handled).toBe(false);
        expect(mockVscodeApi.postMessage).not.toHaveBeenCalled();
    });

    it("a paste inside a code block should not be unfurled", async () => {
        await makeEditorInto("```\ncode\n```\n");
        // Caret inside the code block text.
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, 3)));

        const handled = firePaste(v, "https://example.com");

        expect(handled).toBe(false);
        expect(mockVscodeApi.postMessage).not.toHaveBeenCalled();
    });

    it("with the feature gated OFF it should be a no-op (plain paste)", async () => {
        window.__i18n = { translations: {}, isMac: false, pasteUnfurl: false };
        await setupAtEnd("hello \n");

        const handled = firePaste(v, "https://example.com");

        expect(handled).toBe(false);
        expect(hasLinkMark(v, "https://example.com")).toBe(false);
        expect(mockVscodeApi.postMessage).not.toHaveBeenCalled();
    });

    /** Build an editor from markdown without moving the caret to the end. */
    async function makeEditorInto(markdown: string): Promise<void> {
        editor = await makeEditor(markdown);
        v = view(editor);
    }
});

describe("findBareLinkRange", () => {
    let editor: Editor;

    afterEach(async () => {
        if (editor) { await editor.destroy(); }
    });

    async function docFrom(markdown: string): Promise<EditorView> {
        const root = document.createElement("div");
        document.body.appendChild(root);
        editor = await Editor.make()
            .config((ctx) => {
                ctx.set(rootCtx, root);
                ctx.set(defaultValueCtx, markdown);
                configureSerialization(ctx);
            })
            .use(pureCommonmark)
            .use(gfmFidelity)
            .create();
        return editor.action((ctx) => ctx.get(editorViewCtx));
    }

    it("should locate a bare link whose text equals its href", async () => {
        const url = "https://example.com";
        const v = await docFrom(`[${url}](${url})\n`);

        const range = findBareLinkRange(v.state.doc, url, 1);

        expect(range).not.toBeNull();
        expect(v.state.doc.textBetween(range!.from, range!.to)).toBe(url);
    });

    it("should return null for an already-upgraded link (text differs from href)", async () => {
        const v = await docFrom(`[Example Domain](https://example.com)\n`);

        expect(findBareLinkRange(v.state.doc, "https://example.com", 1)).toBeNull();
    });

    it("should pick the occurrence nearest the recorded position", async () => {
        const url = "https://example.com";
        // Two bare links to the same URL, in separate paragraphs.
        const v = await docFrom(`[${url}](${url})\n\n[${url}](${url})\n`);

        const first = findBareLinkRange(v.state.doc, url, 1)!;
        const second = findBareLinkRange(v.state.doc, url, v.state.doc.content.size - 2)!;

        expect(first.from).toBeLessThan(second.from);
    });

    it("should return null when no matching bare link exists", async () => {
        const v = await docFrom(`just some prose\n`);

        expect(findBareLinkRange(v.state.doc, "https://example.com", 1)).toBeNull();
    });
});
