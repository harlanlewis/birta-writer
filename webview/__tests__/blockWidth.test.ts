/**
 * Per-block width store (blockWidth.ts): state-bag persistence with
 * validation, content-derived anchors, rename-on-edit, subscriber
 * notification, and the bounded-map eviction. The store is presentation-only
 * by design — nothing here ever touches a document.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockVscodeApi } from "./setup";

type BlockWidthModule = typeof import("../blockWidth");

/** Fresh module per test: the store caches its map at module scope. */
async function loadBlockWidth(): Promise<BlockWidthModule> {
    vi.resetModules();
    return await import("../blockWidth");
}

let bag: Record<string, unknown> | null;

beforeEach(() => {
    vi.clearAllMocks();
    bag = null;
    mockVscodeApi.getState.mockImplementation(() => bag);
    mockVscodeApi.setState.mockImplementation((state: unknown) => {
        bag = state as Record<string, unknown>;
    });
});

describe("blockWidth store", () => {
    it("an unset anchor should return null", async () => {
        const bw = await loadBlockWidth();
        expect(bw.getBlockWidth("img:a.png")).toBeNull();
    });

    it("set should round-trip through get and persist to the state bag", async () => {
        const bw = await loadBlockWidth();
        bw.setBlockWidth("embed:https://youtu.be/x", "full");
        expect(bw.getBlockWidth("embed:https://youtu.be/x")).toBe("full");
        expect(bag?.["blockWidths"]).toEqual({ "embed:https://youtu.be/x": "full" });
    });

    it("set null should clear the entry and the persisted record", async () => {
        const bw = await loadBlockWidth();
        bw.setBlockWidth("img:a.png", "fixed");
        bw.setBlockWidth("img:a.png", null);
        expect(bw.getBlockWidth("img:a.png")).toBeNull();
        expect(bag?.["blockWidths"]).toEqual({});
    });

    it("a persisted bag should hydrate a fresh module", async () => {
        bag = { blockWidths: { "table:Name": "full", "img:a.png": "fixed" } };
        const bw = await loadBlockWidth();
        expect(bw.getBlockWidth("table:Name")).toBe("full");
        expect(bw.getBlockWidth("img:a.png")).toBe("fixed");
    });

    it("garbage values in the persisted bag should be dropped, never guessed", async () => {
        bag = {
            blockWidths: {
                "img:ok.png": "full",
                "img:bad.png": "huge",
                "img:worse.png": 42,
                "img:null.png": null,
            },
        };
        const bw = await loadBlockWidth();
        expect(bw.getBlockWidth("img:ok.png")).toBe("full");
        expect(bw.getBlockWidth("img:bad.png")).toBeNull();
        expect(bw.getBlockWidth("img:worse.png")).toBeNull();
        expect(bw.getBlockWidth("img:null.png")).toBeNull();
    });

    it("a non-object persisted value should hydrate to an empty store", async () => {
        bag = { blockWidths: ["full"] };
        const bw = await loadBlockWidth();
        expect(bw.getBlockWidth("0")).toBeNull();
    });

    it("rename should carry the mode to the new anchor", async () => {
        const bw = await loadBlockWidth();
        bw.setBlockWidth("code:old first line", "full");
        bw.renameBlockWidthAnchor("code:old first line", "code:new first line");
        expect(bw.getBlockWidth("code:old first line")).toBeNull();
        expect(bw.getBlockWidth("code:new first line")).toBe("full");
    });

    it("rename of an absent anchor should be a no-op", async () => {
        const bw = await loadBlockWidth();
        bw.renameBlockWidthAnchor("code:none", "code:other");
        expect(bw.getBlockWidth("code:other")).toBeNull();
        expect(bag).toBeNull();
    });

    it("subscribers should hear set (with the new mode) but not rename", async () => {
        const bw = await loadBlockWidth();
        const heard: Array<[string, string | null]> = [];
        const off = bw.onBlockWidthChange((anchor, mode) => heard.push([anchor, mode]));
        bw.setBlockWidth("table:H", "full");
        bw.renameBlockWidthAnchor("table:H", "table:H2");
        bw.setBlockWidth("table:H2", null);
        off();
        bw.setBlockWidth("table:H2", "full");
        expect(heard).toEqual([
            ["table:H", "full"],
            ["table:H2", null],
        ]);
    });

    it("a redundant set should not persist or notify", async () => {
        const bw = await loadBlockWidth();
        bw.setBlockWidth("img:a.png", "full");
        const writes = mockVscodeApi.setState.mock.calls.length;
        const listener = vi.fn();
        bw.onBlockWidthChange(listener);
        bw.setBlockWidth("img:a.png", "full");
        bw.setBlockWidth("img:absent.png", null);
        expect(mockVscodeApi.setState.mock.calls.length).toBe(writes);
        expect(listener).not.toHaveBeenCalled();
    });

    it("the store should evict oldest-first beyond the entry cap", async () => {
        const bw = await loadBlockWidth();
        for (let i = 0; i < 301; i++) {
            bw.setBlockWidth(`img:${i}.png`, "full");
        }
        expect(bw.getBlockWidth("img:0.png")).toBeNull();
        expect(bw.getBlockWidth("img:1.png")).toBe("full");
        expect(bw.getBlockWidth("img:300.png")).toBe("full");
    });

    it("set should preserve other keys already in the state bag", async () => {
        bag = { scrollY: 120, foldAnchors: { headings: ["a:0"] } };
        const bw = await loadBlockWidth();
        bw.setBlockWidth("img:a.png", "full");
        expect(bag?.["scrollY"]).toBe(120);
        expect(bag?.["foldAnchors"]).toEqual({ headings: ["a:0"] });
    });
});

describe("width anchors", () => {
    it("codeWidthAnchor should key on the first line only, truncated", async () => {
        const bw = await loadBlockWidth();
        expect(bw.codeWidthAnchor("const a = 1;\nconst b = 2;")).toBe("code:const a = 1;");
        expect(bw.codeWidthAnchor("no newline")).toBe("code:no newline");
        const long = "x".repeat(200);
        expect(bw.codeWidthAnchor(`${long}\nrest`)).toBe(`code:${"x".repeat(120)}`);
    });

    it("tableWidthAnchor should key on the (truncated) header text", async () => {
        const bw = await loadBlockWidth();
        expect(bw.tableWidthAnchor("NameAge")).toBe("table:NameAge");
        expect(bw.tableWidthAnchor("y".repeat(200))).toBe(`table:${"y".repeat(120)}`);
    });

    it("embed and image anchors should be namespaced so kinds never collide", async () => {
        const bw = await loadBlockWidth();
        expect(bw.embedWidthAnchor("https://a")).toBe("embed:https://a");
        expect(bw.imageWidthAnchor("a.png")).toBe("img:a.png");
        expect(bw.embedWidthAnchor("x")).not.toBe(bw.imageWidthAnchor("x"));
    });
});

describe("codeWrap override store (same bagMap machinery)", () => {
    it("set/get/clear should round-trip through the bag under its own key", async () => {
        const bw = await loadBlockWidth();
        bw.setBlockWrap("code:const a = 1;", true);
        expect(bw.getBlockWrap("code:const a = 1;")).toBe(true);
        expect(bag?.["codeWrap"]).toEqual({ "code:const a = 1;": true });
        bw.setBlockWrap("code:const a = 1;", null);
        expect(bw.getBlockWrap("code:const a = 1;")).toBeNull();
    });

    it("non-boolean persisted values should be dropped, never guessed", async () => {
        bag = { codeWrap: { "code:ok": false, "code:bad": "yes", "code:worse": 1 } };
        const bw = await loadBlockWidth();
        expect(bw.getBlockWrap("code:ok")).toBe(false);
        expect(bw.getBlockWrap("code:bad")).toBeNull();
        expect(bw.getBlockWrap("code:worse")).toBeNull();
    });

    it("rename should carry the override, independently of the width map", async () => {
        const bw = await loadBlockWidth();
        bw.setBlockWrap("code:old", true);
        bw.setBlockWidth("code:old", "full");
        bw.renameBlockWrapAnchor("code:old", "code:new");
        expect(bw.getBlockWrap("code:new")).toBe(true);
        expect(bw.getBlockWrap("code:old")).toBeNull();
        // The width map was NOT renamed by the wrap rename.
        expect(bw.getBlockWidth("code:old")).toBe("full");
    });
});

describe("applyBlockWidthClass", () => {
    it("should toggle bw-full / bw-fixed exclusively and clear on null", async () => {
        const bw = await loadBlockWidth();
        const el = document.createElement("div");
        bw.applyBlockWidthClass(el, "full");
        expect(el.classList.contains("bw-full")).toBe(true);
        expect(el.classList.contains("bw-fixed")).toBe(false);
        bw.applyBlockWidthClass(el, "fixed");
        expect(el.classList.contains("bw-full")).toBe(false);
        expect(el.classList.contains("bw-fixed")).toBe(true);
        bw.applyBlockWidthClass(el, null);
        expect(el.classList.contains("bw-full")).toBe(false);
        expect(el.classList.contains("bw-fixed")).toBe(false);
    });
});
