/**
 * The per-node crash boundary (nodeViewBoundary.ts): a NodeView that throws
 * costs its own chrome, never the editor. Constructor throw → undefined (so
 * prosemirror-view falls back to schema toDOM rendering); update throw →
 * false (so the view is rebuilt through the guarded factory); destroy throw →
 * swallowed. Reports are deduped per (node type, method) so one broken
 * update() cannot spend the whole crash-report session budget.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import type { NodeViewConstructor } from "../pm";

vi.mock("../messaging", () => ({ notifyCrash: vi.fn() }));

import { guardNodeViewFactory } from "../nodeViewBoundary";
import {
    _resetCrashReporterForTests,
    _resetNodeViewFailuresForTests,
} from "../crashReporter";
import { notifyCrash } from "../messaging";

const factoryArgs = [null, null, null, null, null] as unknown as Parameters<NodeViewConstructor>;

describe("guardNodeViewFactory", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _resetCrashReporterForTests();
        _resetNodeViewFailuresForTests();
    });

    it("a healthy factory should pass its NodeView through untouched in behavior", () => {
        const dom = document.createElement("div");
        const factory = (() => ({ dom, update: () => true })) as unknown as NodeViewConstructor;
        const nv = guardNodeViewFactory("code_block", factory)(...factoryArgs) as {
            dom: HTMLElement; update: () => boolean;
        };
        expect(nv.dom).toBe(dom);
        expect(nv.update()).toBe(true);
        expect(notifyCrash).not.toHaveBeenCalled();
    });

    it("a throwing constructor should degrade to default rendering and report once", () => {
        const factory = (() => { throw new Error("chrome exploded"); }) as unknown as NodeViewConstructor;
        const guarded = guardNodeViewFactory("table", factory);

        expect(guarded(...factoryArgs)).toBeUndefined();
        expect(notifyCrash).toHaveBeenCalledTimes(1);
        expect(vi.mocked(notifyCrash).mock.calls[0][0]).toContain("table.create");
        expect(vi.mocked(notifyCrash).mock.calls[0][2]).toBe("nodeview");

        // The same failure again (ProseMirror rebuilds views freely) must not
        // spend another slot of the session's crash-report budget.
        expect(guarded(...factoryArgs)).toBeUndefined();
        expect(notifyCrash).toHaveBeenCalledTimes(1);
    });

    it("a throwing update should report and return false so ProseMirror rebuilds the view", () => {
        const factory = (() => ({
            dom: document.createElement("div"),
            update: () => { throw new Error("update exploded"); },
        })) as unknown as NodeViewConstructor;
        const nv = guardNodeViewFactory("image", factory)(...factoryArgs) as {
            update: () => boolean;
        };

        expect(nv.update()).toBe(false);
        expect(nv.update()).toBe(false);
        expect(notifyCrash).toHaveBeenCalledTimes(1); // deduped per (node, method)
        expect(vi.mocked(notifyCrash).mock.calls[0][0]).toContain("image.update");
    });

    it("distinct methods should report distinctly, and destroy throws are swallowed", () => {
        const factory = (() => ({
            dom: document.createElement("div"),
            update: () => { throw new Error("u"); },
            destroy: () => { throw new Error("d"); },
        })) as unknown as NodeViewConstructor;
        const nv = guardNodeViewFactory("callout", factory)(...factoryArgs) as {
            update: () => boolean; destroy: () => void;
        };

        expect(nv.update()).toBe(false);
        expect(() => nv.destroy()).not.toThrow();
        expect(notifyCrash).toHaveBeenCalledTimes(2);
        const messages = vi.mocked(notifyCrash).mock.calls.map((c) => c[0]);
        expect(messages.some((m) => m.includes("callout.update"))).toBe(true);
        expect(messages.some((m) => m.includes("callout.destroy"))).toBe(true);
    });

    it("ignoreMutation and stopEvent throws should fall back to false, not unwind the observer", () => {
        const factory = (() => ({
            dom: document.createElement("div"),
            ignoreMutation: () => { throw new Error("im"); },
            stopEvent: () => { throw new Error("se"); },
        })) as unknown as NodeViewConstructor;
        const nv = guardNodeViewFactory("html", factory)(...factoryArgs) as {
            ignoreMutation: () => boolean; stopEvent: () => boolean;
        };

        expect(nv.ignoreMutation()).toBe(false);
        expect(nv.stopEvent()).toBe(false);
    });
});
