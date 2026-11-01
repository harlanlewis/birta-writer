/**
 * The folder overview (components/graph/folderOverview.ts): the hub note's
 * two rings, the recent files under them, and what each opens. Built in
 * jsdom, so no layout: every label stays and positions are percentages.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import type { FolderEdge, FolderIndex, FolderNode } from "../../shared/folderIndex";
import { folderHub } from "../components/graph/folderGraph";
import { createFolderOverview, OVERVIEW_RECENTS } from "../components/graph/folderOverview";
import { createLocalGraphView } from "../components/graph";

const node = (path: string, type: string | null = null): FolderNode =>
    ({ path, name: path.replace(/^.*\//, "").replace(/\.md$/, ""), type, tags: [], status: null, trust: null, staleAfter: null });
const edge = (from: string, to: string | null, target = to ?? "x"): FolderEdge =>
    ({ from, to, target, kind: "link", text: "", line: 1 });
const index = (nodes: FolderNode[], edges: FolderEdge[], truncated = false): FolderIndex =>
    ({ rootName: "v", nodes, edges, truncated });

/**
 * hub.md is named by a, b and c and names d; d names far.md, two steps from
 * the hub; lone.md touches nothing. a.md is the second most connected.
 */
const VAULT = index(
    [node("hub.md"), node("a.md"), node("b.md"), node("c.md"), node("d.md"), node("sub/far.md"), node("lone.md")],
    [
        edge("a.md", "hub.md"), edge("b.md", "hub.md"), edge("c.md", "hub.md"), edge("hub.md", "d.md"),
        edge("d.md", "sub/far.md"), edge("a.md", "b.md"),
    ],
);

const ids = (el: HTMLElement): string[] =>
    [...el.querySelectorAll<HTMLElement>(".lg-node")].map((b) => b.dataset["id"]!).sort();
const rows = (el: HTMLElement): string[] =>
    [...el.querySelectorAll<HTMLElement>(".fo-row")].map((b) => b.dataset["path"]!);

describe("folderHub", () => {
    it("a folder should centre on its most connected note", () => {
        expect(folderHub(VAULT)).toBe("hub.md");
    });

    it("a tie should go to the name first in order, as the Most connected list does", () => {
        const tied = index([node("b.md"), node("a.md")], [edge("a.md", "b.md")]);
        expect(folderHub(tied)).toBe("a.md");
    });

    it("a folder where no note links to another should have no hub", () => {
        const flat = index([node("a.md"), node("b.md")], [edge("a.md", null, "Missing"), edge("b.md", "b.md")]);
        expect(folderHub(flat)).toBeNull();
    });
});

describe("createFolderOverview", () => {
    let openNote: ReturnType<typeof vi.fn<(path: string) => void>>;

    beforeEach(() => {
        vi.clearAllMocks();
        document.body.replaceChildren();
        openNote = vi.fn<(path: string) => void>();
    });

    function mount() {
        const view = createFolderOverview({ openNote, onEscape: () => {} });
        document.body.append(view.element);
        return view;
    }

    it("an index should draw the hub at the centre with two rings and nothing unconnected", () => {
        const view = mount();
        view.render({ index: VAULT, self: null }, []);
        expect(ids(view.element)).toEqual(["a.md", "b.md", "c.md", "d.md", "hub.md", "sub/far.md"]);
        const centre = view.element.querySelector<HTMLElement>(".lg-node--self")!;
        expect(centre.dataset["id"]).toBe("hub.md");
        expect(view.element.querySelector(".fo-caption")!.textContent).toContain("hub");
    });

    it("clicking the hub should open it, because nothing is open yet", () => {
        const view = mount();
        view.render({ index: VAULT, self: null }, []);
        const centre = view.element.querySelector<HTMLElement>(".lg-node--self")!;
        expect(centre.getAttribute("aria-current")).toBeNull();
        centre.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(openNote).toHaveBeenCalledWith("hub.md");
    });

    it("clicking a second-ring dot should open that note", () => {
        const view = mount();
        view.render({ index: VAULT, self: null }, []);
        view.element.querySelector<HTMLElement>('.lg-node[data-id="sub/far.md"]')!
            .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(openNote).toHaveBeenCalledWith("sub/far.md");
    });

    it("recent files should list under the drawing, in the order given, named from the index", () => {
        const view = mount();
        view.render({ index: VAULT, self: null }, ["lone.md", "sub/far.md", "notes.txt"]);
        expect(rows(view.element)).toEqual(["lone.md", "sub/far.md", "notes.txt"]);
        const children = [...view.element.children];
        expect(children.indexOf(view.element.querySelector(".lg-stage")!))
            .toBeLessThan(children.indexOf(view.element.querySelector(".fo-recents")!));
        const far = view.element.querySelector<HTMLElement>('.fo-row[data-path="sub/far.md"]')!;
        expect(far.querySelector(".fg-row-label")!.textContent).toBe("far");
        expect(far.querySelector(".fo-row-where")!.textContent).toBe("sub");
        expect(view.element.querySelector('.fo-row[data-path="lone.md"] .fo-row-where')).toBeNull();
    });

    it("clicking a recent file should open it", () => {
        const view = mount();
        view.render({ index: VAULT, self: null }, ["lone.md"]);
        view.element.querySelector<HTMLElement>(".fo-row")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(openNote).toHaveBeenCalledWith("lone.md");
    });

    it("a long recents list should be capped, and a repeat listed once", () => {
        const many = Array.from({ length: OVERVIEW_RECENTS + 5 }, (_, i) => `n${i}.md`);
        const view = mount();
        view.render({ index: VAULT, self: null }, ["n0.md", ...many]);
        expect(rows(view.element)).toEqual(many.slice(0, OVERVIEW_RECENTS));
    });

    it("no recent files should say so rather than draw an empty list", () => {
        const view = mount();
        view.render({ index: VAULT, self: null }, []);
        expect(view.element.querySelector<HTMLElement>(".fo-recents")!.hidden).toBe(true);
        expect(view.element.querySelector<HTMLElement>(".fo-empty")!.hidden).toBe(false);
    });

    it("before the index arrives the recent files should still be listed and openable", () => {
        const view = mount();
        view.render(null, ["sub/far.md"]);
        expect(view.element.querySelector<HTMLElement>(".lg-stage")!.hidden).toBe(true);
        expect(view.element.querySelector(".fo-caption")!.textContent).toBe("Reading the folder…");
        expect(rows(view.element)).toEqual(["sub/far.md"]);
        expect(view.element.querySelector(".fo-row .fg-row-label")!.textContent).toBe("far.md");
    });

    it("a folder with no links should say so and keep the recent files", () => {
        const flat = index([node("a.md"), node("b.md")], []);
        const view = mount();
        view.render({ index: flat, self: null }, ["a.md"]);
        expect(view.element.querySelectorAll(".lg-node")).toHaveLength(0);
        expect(view.element.querySelector<HTMLElement>(".lg-stage")!.hidden).toBe(true);
        expect(view.element.querySelector(".fo-caption")!.textContent).toBe("No note in this folder links to another");
        expect(rows(view.element)).toEqual(["a.md"]);
    });

    it("a truncated index should say the drawing may be missing notes", () => {
        const view = mount();
        view.render({ index: { ...VAULT, truncated: true }, self: null }, []);
        expect(view.element.querySelector(".fo-caption")!.textContent).toContain("more notes than its index reads");
    });

    it("a render after a render should replace the drawing rather than add to it", () => {
        const view = mount();
        view.render({ index: VAULT, self: null }, ["a.md"]);
        view.render({ index: VAULT, self: null }, ["a.md"]);
        expect(view.element.querySelectorAll(".lg-lines")).toHaveLength(1);
        expect(rows(view.element)).toEqual(["a.md"]);
    });
});

describe("the Graph tab on the shared ring stage", () => {
    it("this note at the centre should stay current and open nothing", () => {
        const openNote = vi.fn<(path: string) => void>();
        const view = createLocalGraphView({ openNote, openFolder: () => {}, onEscape: () => {} });
        document.body.replaceChildren(view.element);
        view.render({ index: VAULT, self: "hub.md" });
        const centre = view.element.querySelector<HTMLElement>(".lg-node--self")!;
        expect(centre.getAttribute("aria-current")).toBe("page");
        expect(centre.classList.contains("lg-node--opens")).toBe(false);
        centre.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(openNote).not.toHaveBeenCalled();
    });
});
