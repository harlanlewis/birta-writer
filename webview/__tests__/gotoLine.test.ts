/**
 * Go to Line (components/gotoLine): the parse rule, the prompt's three ways
 * out (Enter, Escape, a press outside), what each does to the host, and the
 * lazy chunk that keeps the prompt off the launch path.
 *
 * The prompt keeps a module singleton, so every test imports a fresh module
 * graph via vi.resetModules() + dynamic import.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { parseGotoLine } from "../components/gotoLine/parse";
import type { GotoLineHost } from "../components/gotoLine";

type GotoLineModule = typeof import("../components/gotoLine");

const STYLE_ID = "goto-line-styles";

interface Harness extends GotoLineModule {
    host: GotoLineHost;
    reveals: { line: number; column?: number; caret: boolean }[];
    focusEditor: ReturnType<typeof vi.fn>;
    editorDom: HTMLElement;
}

async function loadHarness(opts: { lineCount?: number; currentLine?: number | null } = {}): Promise<Harness> {
    vi.resetModules();
    document.body.innerHTML = "";
    document.getElementById(STYLE_ID)?.remove();
    (window as unknown as { __i18n: unknown }).__i18n = { translations: {}, isMac: true };
    const editorDom = document.createElement("div");
    editorDom.className = "ProseMirror";
    editorDom.tabIndex = -1;
    document.body.appendChild(editorDom);
    const reveals: Harness["reveals"] = [];
    const focusEditor = vi.fn(() => editorDom.focus());
    const host: GotoLineHost = {
        lineCount: () => opts.lineCount ?? 120,
        currentLine: () => opts.currentLine === undefined ? 7 : opts.currentLine,
        reveal: (target, caret) => { reveals.push({ ...target, caret }); },
        focusEditor,
    };
    const mod = await import("../components/gotoLine");
    return { ...mod, host, reveals, focusEditor, editorDom };
}

const input = (): HTMLInputElement => document.querySelector<HTMLInputElement>(".goto-line__input")!;
const hint = (): string => document.querySelector(".goto-line__hint")?.textContent ?? "";
const card = (): HTMLElement | null => document.querySelector(".goto-line");

function type(value: string): void {
    const el = input();
    el.value = value;
    el.dispatchEvent(new Event("input", { bubbles: true }));
}

function key(name: string): void {
    input().dispatchEvent(new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true }));
}

describe("parseGotoLine", () => {
    it("a bare number inside the document should be that line", () => {
        expect(parseGotoLine("42", 100)).toEqual({ kind: "target", target: { line: 42 } });
        expect(parseGotoLine("  42 ", 100)).toEqual({ kind: "target", target: { line: 42 } });
        expect(parseGotoLine("1", 1)).toEqual({ kind: "target", target: { line: 1 } });
        expect(parseGotoLine("100", 100)).toEqual({ kind: "target", target: { line: 100 } });
    });

    it("the quick-open spellings should be read: a leading colon, and a column after a second", () => {
        expect(parseGotoLine(":42", 100)).toEqual({ kind: "target", target: { line: 42 } });
        // Columns are typed 1-indexed and carried 0-indexed, as the wire's are.
        expect(parseGotoLine("42:7", 100)).toEqual({ kind: "target", target: { line: 42, column: 6 } });
        expect(parseGotoLine("42:0", 100)).toEqual({ kind: "target", target: { line: 42, column: 0 } });
        // The colon on the way to a column is not a refusal.
        expect(parseGotoLine("42:", 100)).toEqual({ kind: "target", target: { line: 42 } });
    });

    it("a number past the end, zero, or a negative should be refused with the number, never clamped", () => {
        expect(parseGotoLine("101", 100)).toEqual({ kind: "outOfRange", line: 101 });
        expect(parseGotoLine("0", 100)).toEqual({ kind: "outOfRange", line: 0 });
        // A minus sign is not part of the shape at all.
        expect(parseGotoLine("-3", 100)).toEqual({ kind: "invalid" });
    });

    it("nothing typed should be empty, and letters should be invalid", () => {
        expect(parseGotoLine("", 100)).toEqual({ kind: "empty" });
        expect(parseGotoLine("   ", 100)).toEqual({ kind: "empty" });
        expect(parseGotoLine(":", 100)).toEqual({ kind: "empty" });
        expect(parseGotoLine("abc", 100)).toEqual({ kind: "invalid" });
        expect(parseGotoLine("4 2", 100)).toEqual({ kind: "invalid" });
    });

    it("a document reported with no lines should still have a first line to go to", () => {
        expect(parseGotoLine("1", 0)).toEqual({ kind: "target", target: { line: 1 } });
        expect(parseGotoLine("2", 0)).toEqual({ kind: "outOfRange", line: 2 });
    });
});

describe("the Go to Line prompt", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("opening should build one card with a focused numeric field that says where the caret is", async () => {
        const h = await loadHarness({ lineCount: 120, currentLine: 7 });
        h.openGotoLine(h.host);
        expect(h.isGotoLineOpen()).toBe(true);
        expect(document.querySelectorAll(".goto-line").length).toBe(1);
        expect(document.activeElement).toBe(input());
        expect(input().inputMode).toBe("numeric");
        expect(hint()).toContain("7");
        expect(hint()).toContain("120");
        expect(h.reveals).toEqual([]);
    });

    it("typing a line should preview it without the caret, and Enter should land the caret and close", async () => {
        const h = await loadHarness({ lineCount: 120 });
        h.openGotoLine(h.host);
        type("42");
        expect(h.reveals).toEqual([{ line: 42, caret: false }]);
        expect(hint()).toContain("42");
        key("Enter");
        expect(h.reveals).toEqual([{ line: 42, caret: false }, { line: 42, caret: true }]);
        expect(h.isGotoLineOpen()).toBe(false);
        expect(card()).toBeNull();
        expect(h.focusEditor).toHaveBeenCalled();
    });

    it("a column typed after the line should reach the host on commit", async () => {
        const h = await loadHarness({ lineCount: 120 });
        h.openGotoLine(h.host);
        type("42:5");
        key("Enter");
        expect(h.reveals.at(-1)).toEqual({ line: 42, column: 4, caret: true });
    });

    it("a line past the end should be refused in the hint, previewed nowhere, and Enter should keep the prompt open", async () => {
        const h = await loadHarness({ lineCount: 120 });
        h.openGotoLine(h.host);
        type("999");
        expect(h.reveals).toEqual([]);
        expect(hint()).toContain("999");
        expect(hint()).toContain("120");
        expect(document.querySelector(".goto-line__hint--refused")).not.toBeNull();
        key("Enter");
        expect(h.isGotoLineOpen()).toBe(true);
        expect(h.reveals).toEqual([]);
    });

    it("Escape should close without the caret moving and put the scroll back where the prompt opened", async () => {
        const h = await loadHarness({ lineCount: 120 });
        Object.defineProperty(window, "scrollY", { value: 640, configurable: true });
        const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
        h.openGotoLine(h.host);
        type("42");
        key("Escape");
        expect(h.isGotoLineOpen()).toBe(false);
        expect(h.reveals).toEqual([{ line: 42, caret: false }]);
        expect(scrollTo).toHaveBeenCalledWith({ top: 640 });
        expect(h.focusEditor).toHaveBeenCalled();
    });

    it("a press outside the card should close it the way Escape does", async () => {
        const h = await loadHarness({ lineCount: 120 });
        const scrollTo = vi.spyOn(window, "scrollTo").mockImplementation(() => {});
        h.openGotoLine(h.host);
        h.editorDom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(h.isGotoLineOpen()).toBe(false);
        expect(scrollTo).toHaveBeenCalled();
    });

    it("the escape-layer registry should close it too, and hold no dead entry afterwards", async () => {
        const h = await loadHarness({ lineCount: 120 });
        vi.spyOn(window, "scrollTo").mockImplementation(() => {});
        const { closeTopmostLayer } = await import("../ui/escapeLayers");
        h.openGotoLine(h.host);
        expect(closeTopmostLayer()).toBe(true);
        expect(h.isGotoLineOpen()).toBe(false);
        expect(closeTopmostLayer()).toBe(false);
    });

    it("opening again should read the document's length afresh", async () => {
        let count = 10;
        const h = await loadHarness();
        const host: GotoLineHost = { ...h.host, lineCount: () => count };
        vi.spyOn(window, "scrollTo").mockImplementation(() => {});
        h.openGotoLine(host);
        type("50");
        expect(document.querySelector(".goto-line__hint--refused")).not.toBeNull();
        key("Escape");
        count = 100;
        h.openGotoLine(host);
        type("50");
        expect(document.querySelector(".goto-line__hint--refused")).toBeNull();
    });

    it("the first open should inject exactly one stylesheet, and a reopen never a second", async () => {
        const h = await loadHarness();
        vi.spyOn(window, "scrollTo").mockImplementation(() => {});
        expect(document.getElementById(STYLE_ID)).toBeNull();
        h.openGotoLine(h.host);
        expect(document.querySelectorAll(`#${STYLE_ID}`).length).toBe(1);
        key("Escape");
        h.openGotoLine(h.host);
        expect(document.querySelectorAll(`#${STYLE_ID}`).length).toBe(1);
    });

    it("the prompt and its styles should stay off the webview entry's eager import graph, reached only through the loader", async () => {
        const { eagerModulesOf } = await import("./helpers/eagerGraph");
        const eager = new Set(eagerModulesOf());
        expect(eager.has("components/gotoLine/loader.ts")).toBe(true);
        expect(eager.has("components/gotoLine/index.ts")).toBe(false);
        expect(eager.has("components/gotoLine/styles.ts")).toBe(false);
        expect(eager.has("components/gotoLine/parse.ts")).toBe(false);
    });

    it("the loader should open the same singleton the direct entry does", async () => {
        const h = await loadHarness();
        const { openGotoLineLazy } = await import("../components/gotoLine/loader");
        h.openGotoLine(h.host);
        expect(document.querySelectorAll(".goto-line").length).toBe(1);
        await openGotoLineLazy(h.host);
        expect(document.querySelectorAll(".goto-line").length).toBe(1);
        expect(h.isGotoLineOpen()).toBe(true);
    });
});
