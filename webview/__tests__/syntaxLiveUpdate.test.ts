/**
 * The live half of the syntax gate: what happens between the reader changing
 * `birta.syntax.sets` and the surfaces agreeing about it again.
 *
 * Every other test in this feature declares a target and then asks a surface
 * what it would draw, which pins the GATE and says nothing about the WIRE. The
 * wire had nothing on it at all: `syntaxSetsChanged` appeared in five
 * production files and no test, and the handler map is typed with optional
 * members, so deleting the handler compiles clean and the editor simply goes
 * on offering the target the document was opened under. The extension's own
 * comment says "It has to be live"; this is what holds that claim.
 *
 * Driven through `createMessageHandlers` rather than by calling the surfaces,
 * because the surfaces already have their own tests and what is unproven here
 * is that anything calls them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "./setup";
import { createMessageHandlers, type MessageHandlerDeps } from "../messageHandlers";
import { commandAvailable } from "../../shared/commandAvailability";
import { syntaxAllows } from "../../shared/syntaxSets";
import type { ToolbarController } from "../messageHandlers";

function stubDeps(topbarTb: ToolbarController | null): MessageHandlerDeps {
    return {
        state: {
            getEditor: () => null,
            setEditor: () => {},
            setLineMap: () => {},
            getMarkdownSource: () => "",
            setMarkdownSource: () => {},
        },
        actions: {
            placeCaretAtLine: () => {},
            scrollToDocumentLine: () => {},
            getSwitchTarget: () => undefined,
            getSelectionContext: () => null,
            setLineOffset: () => {},
            initEditor: async () => {},
            retryScroll: () => {},
            getEditorView: () => null,
            refreshToc: () => {},
            setLineNumbers: () => {},
        },
        topbarTb,
    };
}

/** A bar that records only what this path asks of it. */
function stubToolbar(): ToolbarController & { applySyntaxSets: ReturnType<typeof vi.fn> } {
    const bar = { applySyntaxSets: vi.fn() };
    return new Proxy(bar, {
        get(target, key) {
            if (key in target) { return (target as Record<string | symbol, unknown>)[key]; }
            return () => {};
        },
    }) as ToolbarController & { applySyntaxSets: ReturnType<typeof vi.fn> };
}

const container = document.createElement("div");

let before: unknown;

beforeEach(() => {
    vi.clearAllMocks();
    before = window.__i18n;
    window.__i18n = { ...(window.__i18n ?? {}) };
});

afterEach(() => {
    (window as { __i18n?: unknown }).__i18n = before;
});

describe("a live syntax-target change", () => {
    it("should be handled at all, so the message is not silently dropped", () => {
        // The handler map's members are optional, so a missing handler is a
        // TYPE-CHECKED no-op rather than a compile error. That is the failure
        // this asserts against, and it is the reason the assertion is about
        // the handler's existence rather than only about its effect.
        const handlers = createMessageHandlers(stubDeps(null));
        expect(handlers.syntaxSetsChanged, "no handler for syntaxSetsChanged").toBeDefined();
    });

    it("should write the new target back to the one declaration every gate reads", () => {
        const handlers = createMessageHandlers(stubDeps(null));
        // Before: every target, so nothing is withdrawn.
        window.__i18n!.syntaxSets = undefined;
        expect(syntaxAllows("table")).toBe(true);
        expect(commandAvailable("insertTable")).toBe(true);

        handlers.syntaxSetsChanged!({ type: "syntaxSetsChanged", sets: [] }, container);

        // After: the predicate every surface asks answers differently, with
        // nothing rebuilt and nothing notified. That IS the update.
        expect(window.__i18n!.syntaxSets).toEqual([]);
        expect(syntaxAllows("table")).toBe(false);
        expect(commandAvailable("insertTable")).toBe(false);
        // And a CommonMark command is untouched, so the write narrowed the
        // target rather than breaking the predicate.
        expect(commandAvailable("toggleBold")).toBe(true);
    });

    it("should widen as well as narrow, so a target coming back is not a reload", () => {
        const handlers = createMessageHandlers(stubDeps(null));
        window.__i18n!.syntaxSets = [];
        expect(commandAvailable("toggleHighlight")).toBe(false);

        handlers.syntaxSetsChanged!({ type: "syntaxSetsChanged", sets: ["obsidian"] }, container);

        expect(commandAvailable("toggleHighlight")).toBe(true);
        // Obsidian's alone, so the widening is the union rather than a reset.
        expect(commandAvailable("insertTable")).toBe(true);
        expect(syntaxAllows("calc")).toBe(false);
    });

    it("should ask the bar to re-place its items", () => {
        // The one surface that decided its contents once and cannot re-read
        // the declaration on its own (webview/components/toolbar/layout.ts).
        const bar = stubToolbar();
        const handlers = createMessageHandlers(stubDeps(bar));

        handlers.syntaxSetsChanged!({ type: "syntaxSetsChanged", sets: ["gfm"] }, container);

        expect(bar.applySyntaxSets).toHaveBeenCalledTimes(1);
    });

    it("should survive a page with no bar, which is every host that hides it", () => {
        const handlers = createMessageHandlers(stubDeps(null));
        expect(() => handlers.syntaxSetsChanged!(
            { type: "syntaxSetsChanged", sets: ["pandoc"] }, container,
        )).not.toThrow();
        expect(window.__i18n!.syntaxSets).toEqual(["pandoc"]);
    });
});
