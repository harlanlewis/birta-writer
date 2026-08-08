/**
 * Per-block width store (blockWidth.ts): state-bag persistence with
 * validation, content-derived anchors, rename-on-edit, subscriber
 * notification, and the bounded-map eviction. The store is presentation-only
 * by design — nothing here ever touches a document.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import { Schema } from "../pm";

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

    /**
     * A rename notifies BOTH keys. It changes what `get(oldAnchor)` answers, and
     * chrome anchored there has no other way to hear it: a rename can move a
     * peer's ordinal, and a silent one leaves that peer painting a width the
     * store does not back (MAR-334).
     */
    it("subscribers should hear set and rename, and nothing after unsubscribing", async () => {
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
            // The rename, as vacated-then-occupied.
            ["table:H", null],
            ["table:H2", "full"],
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

// ─── Block identity: occurrence-disambiguated anchors ───────────────────────

/**
 * A minimal schema standing in for the real one. The production kinds are
 * registered by their owning modules against node type NAMES, so a test can
 * register its own kind the same way and exercise the index without booting a
 * Milkdown editor.
 */
function testSchema(): InstanceType<typeof Schema> {
    return new Schema({
        nodes: {
            doc: { content: "block+" },
            text: { group: "inline" },
            paragraph: { group: "block", content: "inline*" },
            widget: { group: "block", attrs: { key: { default: "" } } },
        },
    });
}

/** `widget` nodes anchored on their `key` attr — a stand-in for "a table
 * anchored on its header row". */
function widgetKind(bw: BlockWidthModule): (node: never) => string | null {
    return bw.registerAnchorKind(
        "widget",
        (node) => `w:${(node.attrs["key"] as string) ?? ""}`,
    ) as unknown as (node: never) => string | null;
}

/** doc(widget(key), …) from a list of keys. */
function docOf(schema: InstanceType<typeof Schema>, keys: string[]) {
    return schema.node("doc", null, keys.map((key) => schema.node("widget", { key })));
}

describe("occurrenceAnchor", () => {
    it("the first occurrence should be the bare base and later ones numbered", async () => {
        const bw = await loadBlockWidth();
        expect(bw.occurrenceAnchor("table:Fruit", 0)).toBe("table:Fruit");
        expect(bw.occurrenceAnchor("table:Fruit", 1)).toBe("table:Fruit#2");
        expect(bw.occurrenceAnchor("table:Fruit", 2)).toBe("table:Fruit#3");
    });

    it("a negative ordinal should degrade to the bare base, never a #0", async () => {
        const bw = await loadBlockWidth();
        expect(bw.occurrenceAnchor("table:Fruit", -1)).toBe("table:Fruit");
    });
});

describe("anchorAt", () => {
    it("blocks with distinct content should each get their bare base", async () => {
        const bw = await loadBlockWidth();
        const kind = widgetKind(bw);
        const schema = testSchema();
        const doc = docOf(schema, ["a", "b"]);
        expect(bw.anchorAt(doc, 0, kind)).toBe("w:a");
        expect(bw.anchorAt(doc, 1, kind)).toBe("w:b");
    });

    it("blocks with IDENTICAL content should get distinct keys in document order", async () => {
        const bw = await loadBlockWidth();
        const kind = widgetKind(bw);
        const schema = testSchema();
        const doc = docOf(schema, ["same", "same", "same"]);
        expect(bw.anchorAt(doc, 0, kind)).toBe("w:same");
        expect(bw.anchorAt(doc, 1, kind)).toBe("w:same#2");
        expect(bw.anchorAt(doc, 2, kind)).toBe("w:same#3");
    });

    it("a preference set on one of two identical blocks should not reach the other", async () => {
        // The reported defect (MAR-334), at the level the store can answer:
        // two keys, so one write cannot be read back through the other.
        const bw = await loadBlockWidth();
        const kind = widgetKind(bw);
        const schema = testSchema();
        const doc = docOf(schema, ["same", "same"]);
        const first = bw.anchorAt(doc, 0, kind)!;
        const second = bw.anchorAt(doc, 1, kind)!;
        bw.setBlockWidth(first, "full");
        expect(bw.getBlockWidth(first)).toBe("full");
        expect(bw.getBlockWidth(second)).toBeNull();
    });

    it("a position holding no node of the kind should return null", async () => {
        const bw = await loadBlockWidth();
        const kind = widgetKind(bw);
        const schema = testSchema();
        const doc = schema.node("doc", null, [
            schema.node("paragraph", null, [schema.text("prose")]),
        ]);
        expect(bw.anchorAt(doc, 0, kind)).toBeNull();
    });

    it("an out-of-range or undefined position should return null rather than throw", async () => {
        const bw = await loadBlockWidth();
        const kind = widgetKind(bw);
        const schema = testSchema();
        const doc = docOf(schema, ["a"]);
        expect(bw.anchorAt(doc, undefined, kind)).toBeNull();
        expect(bw.anchorAt(doc, -1, kind)).toBeNull();
        expect(bw.anchorAt(doc, 9999, kind)).toBeNull();
    });
});

describe("inheritDuplicatedAnchors", () => {
    it("a copy inserted AFTER its original should inherit the original's width", async () => {
        const bw = await loadBlockWidth();
        const kind = widgetKind(bw);
        const schema = testSchema();
        const before = docOf(schema, ["dup"]);
        bw.setBlockWidth(bw.anchorAt(before, 0, kind)!, "full");
        // The copy lands at position 1 (one widget is one position wide).
        const after = docOf(schema, ["dup", "dup"]);
        bw.inheritDuplicatedAnchors({
            before, after, sourceFrom: 0, insertAt: 1, size: 1,
        });
        expect(bw.getBlockWidth(bw.anchorAt(after, 0, kind)!)).toBe("full");
        expect(bw.getBlockWidth(bw.anchorAt(after, 1, kind)!)).toBe("full");
    });

    it("a copy inserted BEFORE its original should leave the original full, not steal it", async () => {
        // Duplicate-up renumbers: the COPY becomes occurrence 1 and the
        // original slides to occurrence 2, so without a remap the original
        // would go narrow and the copy would inherit its stored key.
        const bw = await loadBlockWidth();
        const kind = widgetKind(bw);
        const schema = testSchema();
        const before = docOf(schema, ["dup"]);
        bw.setBlockWidth(bw.anchorAt(before, 0, kind)!, "full");
        const after = docOf(schema, ["dup", "dup"]);
        bw.inheritDuplicatedAnchors({
            before, after, sourceFrom: 0, insertAt: 0, size: 1,
        });
        expect(bw.getBlockWidth(bw.anchorAt(after, 0, kind)!)).toBe("full");
        expect(bw.getBlockWidth(bw.anchorAt(after, 1, kind)!)).toBe("full");
    });

    it("an UNRELATED identical block after the insertion should keep its own width", async () => {
        // The staleness this exists to prevent: inserting a twin renumbers
        // every later occurrence, so a block that was #2 becomes #3 and must
        // carry its value along rather than adopt the copy's.
        const bw = await loadBlockWidth();
        const kind = widgetKind(bw);
        const schema = testSchema();
        const before = docOf(schema, ["dup", "dup"]);
        bw.setBlockWidth(bw.anchorAt(before, 0, kind)!, "full");   // #1 full
        bw.setBlockWidth(bw.anchorAt(before, 1, kind)!, "fixed");  // #2 fixed
        const after = docOf(schema, ["dup", "dup", "dup"]);        // copy of #1 at pos 1
        bw.inheritDuplicatedAnchors({
            before, after, sourceFrom: 0, insertAt: 1, size: 1,
        });
        expect(bw.getBlockWidth(bw.anchorAt(after, 0, kind)!)).toBe("full");
        expect(bw.getBlockWidth(bw.anchorAt(after, 1, kind)!)).toBe("full");
        expect(bw.getBlockWidth(bw.anchorAt(after, 2, kind)!)).toBe("fixed");
    });

    it("a block whose content is unique should be left entirely alone", async () => {
        const bw = await loadBlockWidth();
        const kind = widgetKind(bw);
        const schema = testSchema();
        const before = docOf(schema, ["solo", "dup"]);
        bw.setBlockWidth("w:solo", "fixed");
        const after = docOf(schema, ["solo", "dup", "dup"]);
        bw.inheritDuplicatedAnchors({
            before, after, sourceFrom: 1, insertAt: 2, size: 1,
        });
        expect(bw.getBlockWidth("w:solo")).toBe("fixed");
    });

    it("the word-wrap preference should ride along with the width", async () => {
        const bw = await loadBlockWidth();
        const kind = widgetKind(bw);
        const schema = testSchema();
        const before = docOf(schema, ["dup"]);
        bw.setBlockWrap(bw.anchorAt(before, 0, kind)!, true);
        const after = docOf(schema, ["dup", "dup"]);
        bw.inheritDuplicatedAnchors({
            before, after, sourceFrom: 0, insertAt: 1, size: 1,
        });
        expect(bw.getBlockWrap(bw.anchorAt(after, 1, kind)!)).toBe(true);
    });
});

describe("rename guards", () => {
    it("rename should refuse an OCCUPIED destination rather than overwrite it", async () => {
        const bw = await loadBlockWidth();
        bw.setBlockWidth("table:a", "full");
        bw.setBlockWidth("table:b", "fixed");
        bw.renameBlockWidthAnchor("table:a", "table:b");
        expect(bw.getBlockWidth("table:b")).toBe("fixed");
        expect(bw.getBlockWidth("table:a")).toBe("full");
    });

    it("rename should notify subscribers for BOTH the vacated and the new anchor", async () => {
        const bw = await loadBlockWidth();
        bw.setBlockWidth("table:a", "full");
        const seen: [string, unknown][] = [];
        bw.onBlockWidthChange((anchor, mode) => seen.push([anchor, mode]));
        bw.renameBlockWidthAnchor("table:a", "table:c");
        expect(seen).toEqual([["table:a", null], ["table:c", "full"]]);
    });
});
