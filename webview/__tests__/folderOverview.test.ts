/**
 * The folder overview (components/graph/folderOverview.ts): the hub note's
 * two rings, the recent files under them, and what each opens. Built in
 * jsdom, so no layout: every label stays and positions are percentages.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FolderEdge, FolderIndex, FolderNode } from "../../shared/folderIndex";
import { commandAvailable, idleCommandIds, setCommandsIdle } from "../../shared/commandAvailability";
import { folderHub } from "../components/graph/folderGraph";
import { createFolderOverview, openFolderOverview, OVERVIEW_RECENTS } from "../components/graph/folderOverview";
import { createLocalGraphView } from "../components/graph";
import {
    FOLDER_OVERVIEW_COMMAND,
    receiveFolderIndex,
    receiveFolderRecents,
    resetFolderIndexForTests,
    setFolderGraphEnabled,
    syncFolderOverviewAvailability,
} from "../links/folderIndex";

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

describe("createFolderOverview with a host that keeps no recent files", () => {
    it("null recents should draw no recent files section at all, heading included", () => {
        const view = createFolderOverview({ openNote: () => {}, onEscape: () => {} });
        document.body.replaceChildren(view.element);
        view.render({ index: VAULT, self: null }, ["a.md"]);
        view.render({ index: VAULT, self: null }, null);
        expect(view.element.querySelector<HTMLElement>(".fo-heading")!.hidden).toBe(true);
        expect(view.element.querySelector<HTMLElement>(".fo-recents")!.hidden).toBe(true);
        expect(view.element.querySelector<HTMLElement>(".fo-empty")!.hidden).toBe(true);
        expect(view.element.querySelectorAll(".fo-row")).toHaveLength(0);
        expect(view.element.querySelectorAll(".lg-node").length).toBeGreaterThan(1);
    });
});

type I18n = { __i18n?: Record<string, unknown> };
const posted = (): Array<{ type: string }> =>
    ((globalThis as unknown as { acquireVsCodeApi: () => { postMessage: { mock: { calls: Array<[{ type: string }]> } } } })
        .acquireVsCodeApi().postMessage.mock.calls).map((c) => c[0]);

describe("openFolderOverview", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.replaceChildren();
        resetFolderIndexForTests();
        (window as I18n).__i18n = { translations: {}, isMac: true, folderGraph: true };
    });
    afterEach(() => {
        document.querySelectorAll(".fs-surface").forEach((el) => el.remove());
        delete (window as I18n).__i18n;
        resetFolderIndexForTests();
    });

    it("opening should ask for the recent files and the index, and draw both as they arrive", () => {
        const close = openFolderOverview({ openNote: () => {}, onDismiss: () => {} });
        const types = posted().map((m) => m.type);
        expect(types).toContain("requestFolderRecents");
        expect(types).toContain("requestFolderIndex");
        const surface = document.querySelector<HTMLElement>(".fo-surface")!;
        expect(surface.querySelector(".fo-caption")!.textContent).toBe("Reading the folder…");
        receiveFolderIndex(VAULT, "lone.md");
        receiveFolderRecents(["sub/far.md", "a.md"]);
        expect(surface.querySelector(".lg-node--self")!.getAttribute("data-id")).toBe("hub.md");
        expect(rows(surface)).toEqual(["sub/far.md", "a.md"]);
        expect(surface.querySelector(".fs-title")!.textContent).toBe("Folder: v");
        close();
    });

    it("every opening should ask again, because the list moves with every file opened", () => {
        openFolderOverview({ openNote: () => {}, onDismiss: () => {} })();
        openFolderOverview({ openNote: () => {}, onDismiss: () => {} })();
        expect(posted().filter((m) => m.type === "requestFolderRecents")).toHaveLength(2);
    });

    it("Escape should close it and hand focus back, opening nothing", () => {
        const openNote = vi.fn();
        const onDismiss = vi.fn();
        openFolderOverview({ openNote, onDismiss });
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(onDismiss).toHaveBeenCalledTimes(1);
        expect(openNote).not.toHaveBeenCalled();
        expect(document.querySelector(".fo-surface")!.classList.contains("lb-closing")
            || !document.querySelector(".fo-surface")).toBe(true);
    });

    it("a row should close it and open that note, and not also hand focus back", () => {
        const openNote = vi.fn();
        const onDismiss = vi.fn();
        openFolderOverview({ openNote, onDismiss });
        receiveFolderIndex(VAULT, null);
        receiveFolderRecents(["lone.md"]);
        document.querySelector<HTMLElement>(".fo-row")!.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(openNote).toHaveBeenCalledWith("lone.md");
        expect(onDismiss).not.toHaveBeenCalled();
    });

    it("focus should follow the recent files when they arrive after the index", () => {
        const close = openFolderOverview({ openNote: () => {}, onDismiss: () => {} });
        receiveFolderIndex(VAULT, null);
        expect((document.activeElement as HTMLElement).classList.contains("lg-node")).toBe(true);
        receiveFolderRecents(["lone.md", "a.md"]);
        expect((document.activeElement as HTMLElement).dataset["path"]).toBe("lone.md");
        close();
    });

    it("once the reader has moved, a redraw should keep focus on the same row rather than move it", () => {
        const close = openFolderOverview({ openNote: () => {}, onDismiss: () => {} });
        receiveFolderIndex(VAULT, null);
        receiveFolderRecents(["lone.md", "a.md"]);
        const second = document.querySelector<HTMLElement>('.fo-row[data-path="a.md"]')!;
        second.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
        second.focus();
        receiveFolderIndex({ ...VAULT }, null);
        expect((document.activeElement as HTMLElement).dataset["path"]).toBe("a.md");
        expect(document.activeElement).not.toBe(second);
        close();
    });

    it("an answer arriving after close should not redraw a closed surface", () => {
        const close = openFolderOverview({ openNote: () => {}, onDismiss: () => {} });
        const surface = document.querySelector<HTMLElement>(".fo-surface")!;
        close();
        receiveFolderRecents(["a.md"]);
        expect(rows(surface)).toEqual([]);
    });
});

describe("the folder overview command's availability", () => {
    afterEach(() => {
        setCommandsIdle([FOLDER_OVERVIEW_COMMAND], false);
        delete (window as I18n).__i18n;
        resetFolderIndexForTests();
    });

    it("with the setting on and a host that has an index it should be offered", () => {
        (window as I18n).__i18n = { translations: {}, isMac: false, folderGraph: true };
        syncFolderOverviewAvailability();
        expect(commandAvailable(FOLDER_OVERVIEW_COMMAND)).toBe(true);
        expect(idleCommandIds()).not.toContain(FOLDER_OVERVIEW_COMMAND);
    });

    it("with the setting off it should be idle, and turning it on should say it changed", () => {
        (window as I18n).__i18n = { translations: {}, isMac: false, folderGraph: false };
        syncFolderOverviewAvailability();
        expect(commandAvailable(FOLDER_OVERVIEW_COMMAND)).toBe(false);
        expect(setFolderGraphEnabled(true)).toBe(true);
        expect(commandAvailable(FOLDER_OVERVIEW_COMMAND)).toBe(true);
        expect(setFolderGraphEnabled(true)).toBe(false);
    });

    it("a window whose host declares no folder index should be withdrawn AND listed idle, so a host menu dims it", () => {
        (window as I18n).__i18n = {
            translations: {}, isMac: true, folderGraph: true,
            host: { capabilities: ["toc", "projectFiles"], arrangements: [], shortcuts: [] },
        };
        syncFolderOverviewAvailability();
        expect(commandAvailable(FOLDER_OVERVIEW_COMMAND)).toBe(false);
        expect(idleCommandIds()).toContain(FOLDER_OVERVIEW_COMMAND);
    });
});
