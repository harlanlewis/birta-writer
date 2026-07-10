/**
 * Content-font injection on the extension side. A non-editor preset must be
 * baked into an INLINE style attribute on <html>, not into the <style> block:
 * switching to the "editor" preset at runtime clears the font via
 * documentElement.style.removeProperty("--content-font-family"), which only
 * touches inline styles. A value stuck in a <style> rule would survive that
 * removal and leave the content wrongly rendered in the previous preset
 * (e.g. serif) even though "Editor font" is selected.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { JSDOM } from "jsdom";
import * as vscode from "vscode";
import { makeFakeTextDocument, resetTextDocumentMocks } from "../../__mocks__/vscode";
import { FONT_PRESET_STACKS } from "../../shared/fontPresets";

import { MarkdownEditorProvider, escapeHtmlAttr } from "../MarkdownEditorProvider";

const makeContext = () =>
    ({
        extensionUri: vscode.Uri.file("/ext"),
        globalState: { get: vi.fn(() => undefined), update: vi.fn() },
    }) as unknown as vscode.ExtensionContext;

const makePanel = () => ({
    viewColumn: 1,
    active: true,
    visible: true,
    webview: {
        options: {},
        html: "",
        cspSource: "vscode-webview-resource:",
        postMessage: vi.fn(),
        asWebviewUri: vi.fn((uri: vscode.Uri) => uri),
        onDidReceiveMessage: vi.fn(() => ({ dispose: vi.fn() })),
    },
    onDidDispose: vi.fn(() => ({ dispose: vi.fn() })),
    onDidChangeViewState: vi.fn(() => ({ dispose: vi.fn() })),
    dispose: vi.fn(),
});

const makeCancellation = () =>
    ({ isCancellationRequested: false }) as vscode.CancellationToken;

/** Configuration fake whose fontPreset can be controlled per test. */
function mockConfiguration(fontPreset?: string) {
    const cfg = {
        get: vi.fn((key: string, defaultValue?: unknown) =>
            key === "fontPreset" && fontPreset !== undefined ? fontPreset : defaultValue,
        ),
        inspect: vi.fn(() => undefined),
        update: vi.fn(),
    };
    (vscode.workspace.getConfiguration as ReturnType<typeof vi.fn>).mockReturnValue(cfg);
    return cfg;
}

async function renderHtml(fontPreset?: string): Promise<string> {
    mockConfiguration(fontPreset);
    const provider = new MarkdownEditorProvider(makeContext());
    const document = makeFakeTextDocument("content\n", vscode.Uri.file("/project/note.md"));
    const panel = makePanel();
    await provider.resolveCustomTextEditor(
        document as unknown as vscode.TextDocument,
        panel as unknown as vscode.WebviewPanel,
        makeCancellation(),
    );
    return panel.webview.html;
}

/** The bootstrap <style> block that carries the other :root CSS variables. */
const styleBlock = (html: string) => html.match(/<style>[^]*?<\/style>/)?.[0] ?? "";
/** Parse the emitted HTML the way a browser would, so we test the real artifact. */
const rootEl = (html: string) => new JSDOM(html).window.document.documentElement;

describe("MarkdownEditorProvider content font injection", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resetTextDocumentMocks();
    });

    it("a non-editor preset should bake the exact font stack into the inline <html> style, not the <style> block", async () => {
        // Arrange / Act
        const html = await renderHtml("serif");
        const root = rootEl(html);

        // Assert — the parsed CSSOM value is the exact stack. The stack contains
        // `"…"` around family names, so this fails loudly if the attribute isn't
        // escaped (an unescaped `"` truncates the value and leaks stray attrs).
        expect(root.style.getPropertyValue("--content-font-family")).toBe(FONT_PRESET_STACKS.serif);
        expect(root.getAttributeNames().sort()).toEqual(["lang", "style"]);
        // ...and NOT declared in the <style> block, where removeProperty can't reach.
        expect(styleBlock(html)).not.toContain("--content-font-family");
    });

    it("the editor preset should emit no --content-font-family anywhere (inherits the VS Code editor font)", async () => {
        // Arrange / Act
        const html = await renderHtml("editor");
        const root = rootEl(html);

        // Assert
        expect(root.style.getPropertyValue("--content-font-family")).toBe("");
        expect(styleBlock(html)).not.toContain("--content-font-family");
    });
});

describe("escapeHtmlAttr", () => {
    it("a plain string with no special characters should pass through unchanged", () => {
        expect(escapeHtmlAttr("Menlo, monospace")).toBe("Menlo, monospace");
    });

    it("an empty string should return an empty string", () => {
        expect(escapeHtmlAttr("")).toBe("");
    });

    it("double quotes in a font stack should be escaped so the attribute can't be broken out of", () => {
        expect(escapeHtmlAttr(FONT_PRESET_STACKS.serif)).toBe(
            '&quot;Iowan Old Style&quot;, &quot;Palatino&quot;, Charter, ui-serif, Georgia, serif',
        );
    });

    it("an ampersand and angle brackets should be escaped, with & escaped first to avoid double-encoding", () => {
        expect(escapeHtmlAttr('a & "b" <c>')).toBe("a &amp; &quot;b&quot; &lt;c&gt;");
    });
});
