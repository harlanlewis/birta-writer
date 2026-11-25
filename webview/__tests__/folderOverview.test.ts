/**
 * The folder overview (components/graph/folderOverview.ts): the hub note's
 * two rings, the recent files under them, and what each opens. Built in
 * jsdom, so no layout: every label stays and positions are percentages.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { FolderEdge, FolderIndex, FolderNode } from "../../shared/folderIndex";
import { commandAvailable, idleCommandIds, setCommandsIdle } from "../../shared/commandAvailability";
import { folderHub } from "../components/graph/folderGraph";
import { activityOf } from "../components/graph/folderSignals";
import {
    createFolderOverview,
    openFolderOverview,
    OVERVIEW_RECENTS,
    overviewCentre,
    resetSubjectNamesForTests,
    sinceWritten,
    START_RECENTS,
    type StartLauncher,
} from "../components/graph/folderOverview";
import { createLocalGraphView } from "../components/graph";
import {
    FOLDER_OVERVIEW_COMMAND,
    receiveFolderIndex,
    receiveFolderRecents,
    receiveRecentFiles,
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
        const view = createFolderOverview({ defer: (run) => run(), openNote, onEscape: () => {} });
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

    it("recent files should list above the drawing, in the order given, named from the index", () => {
        const view = mount();
        view.render({ index: VAULT, self: null }, ["lone.md", "sub/far.md", "notes.txt"]);
        expect(rows(view.element)).toEqual(["lone.md", "sub/far.md", "notes.txt"]);
        const children = [...view.element.children];
        expect(children.indexOf(view.element.querySelector(".fo-recents")!))
            .toBeLessThan(children.indexOf(view.element.querySelector(".lg-stage")!));
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
        view.render({ index: flat, self: null }, []);
        expect(view.element.querySelectorAll(".lg-node")).toHaveLength(0);
        expect(view.element.querySelector<HTMLElement>(".lg-stage")!.hidden).toBe(true);
        expect(view.element.querySelector(".fo-caption")!.textContent).toBe("No note in this folder links to another");
        view.render({ index: flat, self: null }, ["a.md"]);
        expect(view.element.querySelector(".fo-caption")!.textContent).toBe("None of the notes you opened here links to another");
        expect(rows(view.element)).toEqual(["a.md"]);
    });

    it("the drawing should centre on the most recent note that links, not on the hub", () => {
        const view = mount();
        // lone.md links to nothing, so the next recent note is the centre.
        view.render({ index: VAULT, self: null }, ["lone.md", "sub/far.md", "hub.md"]);
        expect(view.element.querySelector<HTMLElement>(".lg-node--self")!.dataset["id"]).toBe("sub/far.md");
        expect(view.element.querySelector(".fo-caption")!.textContent).toContain("where you have been working");
    });

    it("recent notes none of which links should draw nothing rather than fall back to the hub", () => {
        const view = mount();
        view.render({ index: VAULT, self: null }, ["lone.md", "notes.txt"]);
        expect(view.element.querySelectorAll(".lg-node")).toHaveLength(0);
        expect(view.element.querySelector<HTMLElement>(".lg-stage")!.hidden).toBe(true);
    });

    it("a host keeping no recent files list should centre on the hub", () => {
        const view = mount();
        view.render({ index: VAULT, self: null }, null);
        expect(view.element.querySelector<HTMLElement>(".lg-node--self")!.dataset["id"]).toBe("hub.md");
    });

    it("with no recent files, the most recently written linked note should be the centre, not the hub", () => {
        const now = Date.UTC(2026, 10, 24);
        const dated: FolderIndex = { ...VAULT, nodes: VAULT.nodes.map((n) => ({ ...n, modified: n.path === "d.md" ? now - 86_400_000 : now - 400 * 86_400_000 })) };
        const view = createFolderOverview({ defer: (run) => run(), openNote, onEscape: () => {}, now: () => now });
        document.body.append(view.element);
        view.render({ index: dated, self: null }, null);
        expect(view.element.querySelector<HTMLElement>(".lg-node--self")!.dataset["id"]).toBe("d.md");
        // hub.md, a.md and the rest were last written over a year ago: faded.
        expect(view.element.querySelector('.lg-node[data-id="a.md"]')!.classList.contains("lg-node--dormant")).toBe(true);
        expect(view.element.querySelector('.lg-node[data-id="d.md"]')!.classList.contains("lg-node--dormant")).toBe(false);
        expect(view.element.querySelector(".fo-caption")!.textContent).toContain("Faded names");
    });

    it("a subject row should draw its subject in the square and press again to go back", () => {
        const view = mount();
        view.render({ index: VAULT, self: null }, ["sub/far.md"]);
        const row = view.element.querySelector<HTMLElement>(".fo-subject")!;
        expect(row).not.toBeNull();
        const before = view.element.querySelector<HTMLElement>(".lg-node--self")!.dataset["id"];
        row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        const pressed = view.element.querySelector<HTMLElement>(".fo-subject")!;
        expect(pressed.getAttribute("aria-pressed")).toBe("true");
        expect(view.element.querySelector(".fo-caption")!.textContent).toMatch(/notes, around/);
        pressed.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(view.element.querySelector<HTMLElement>(".fo-subject")!.getAttribute("aria-pressed")).toBe("false");
        expect(view.element.querySelector<HTMLElement>(".lg-node--self")!.dataset["id"]).toBe(before);
    });

    it("pressing a subject from the keyboard should leave focus on its row", () => {
        const view = mount();
        view.render({ index: VAULT, self: null }, ["sub/far.md"]);
        const row = view.element.querySelector<HTMLElement>(".fo-subject")!;
        const id = row.dataset["subject"];
        row.focus();
        row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect((document.activeElement as HTMLElement).dataset["subject"]).toBe(id);
    });

    it("a folder that changes under the view should keep its subjects listed until the new ones are found", () => {
        const pending: Array<() => void> = [];
        const view = createFolderOverview({ openNote, onEscape: () => {}, defer: (run) => pending.push(run) });
        document.body.append(view.element);
        view.render({ index: VAULT, self: null }, []);
        pending.shift()!();
        const before = view.element.querySelectorAll(".fo-subject").length;
        expect(before).toBeGreaterThan(0);
        view.render({ index: { ...VAULT, edges: [...VAULT.edges] }, self: null }, []);
        expect(view.element.querySelectorAll(".fo-subject")).toHaveLength(before);
    });

    it("a detached view should find nothing when its deferred work comes round", () => {
        const pending: Array<() => void> = [];
        const names = vi.fn(async () => new Map<string, string>());
        const view = createFolderOverview({ openNote, onEscape: () => {}, defer: (run) => pending.push(run), nameSubjects: names });
        document.body.append(view.element);
        view.render({ index: VAULT, self: null }, []);
        view.element.remove();
        pending.shift()!();
        expect(names).not.toHaveBeenCalled();
    });

    it("subjects should be found after the view is drawn, not while it is drawn", () => {
        const pending: Array<() => void> = [];
        const view = createFolderOverview({ openNote, onEscape: () => {}, defer: (run) => pending.push(run) });
        document.body.append(view.element);
        view.render({ index: VAULT, self: null }, ["sub/far.md"]);
        expect(view.element.querySelector(".lg-node--self")).not.toBeNull();
        expect(view.element.querySelectorAll(".fo-subject")).toHaveLength(0);
        expect(view.element.querySelector<HTMLElement>(".fo-subjects")!.hidden).toBe(true);
        expect(pending).toHaveLength(1);
        pending.shift()!();
        expect(view.element.querySelectorAll(".fo-subject").length).toBeGreaterThan(0);
    });

    it("a host's names should replace the subjects' own, and a failing namer should leave them", async () => {
        resetSubjectNamesForTests();
        const names = vi.fn(async (subjects: readonly { id: string }[]) => new Map(subjects.map((s) => [s.id, "Named by host"])));
        const view = createFolderOverview({ defer: (run) => run(), openNote, onEscape: () => {}, nameSubjects: names });
        document.body.append(view.element);
        view.render({ index: VAULT, self: null }, []);
        await Promise.resolve(); await Promise.resolve();
        expect(view.element.querySelector(".fo-subject .fg-row-label")!.textContent).toBe("Named by host");
        // A model's names say whose they are; the notes' own need no credit.
        const row = view.element.querySelector<HTMLElement>(".fo-subject")!;
        expect(row.classList.contains("fo-subject--model-named")).toBe(true);
        expect(row.querySelector(".fg-row-detail")!.textContent).toMatch(/named by the on-device model$/);
        view.render({ index: VAULT, self: null }, []);
        expect(names).toHaveBeenCalledTimes(1);
        // A second overview of the same folder asks nothing: the page keeps
        // what the host's model already said.
        const again = createFolderOverview({ defer: (run) => run(), openNote, onEscape: () => {}, nameSubjects: names });
        document.body.append(again.element);
        again.render({ index: VAULT, self: null }, []);
        expect(names).toHaveBeenCalledTimes(1);
        expect(again.element.querySelector(".fo-subject .fg-row-label")!.textContent).toBe("Named by host");
        resetSubjectNamesForTests();

        const failing = createFolderOverview({ defer: (run) => run(), openNote, onEscape: () => {}, nameSubjects: () => Promise.reject(new Error("no model")) });
        document.body.append(failing.element);
        failing.render({ index: VAULT, self: null }, []);
        await Promise.resolve(); await Promise.resolve();
        expect(failing.element.querySelector(".fo-subject .fg-row-label")!.textContent).not.toBe("");
        expect(failing.element.querySelector(".fo-subject--model-named")).toBeNull();
        expect(failing.element.querySelector(".fo-subject .fg-row-detail")!.textContent).not.toMatch(/model/);
    });

    it("a fading note should be listed with its age and open on a press", () => {
        const now = Date.UTC(2026, 10, 24);
        const old = now - 200 * 86_400_000;
        const dated: FolderIndex = { ...VAULT, nodes: VAULT.nodes.map((n) => ({ ...n, modified: old })) };
        const view = createFolderOverview({ defer: (run) => run(), openNote, onEscape: () => {}, now: () => now });
        document.body.append(view.element);
        view.render({ index: dated, self: null }, []);
        const row = view.element.querySelector<HTMLElement>('.fo-fading[data-fading="hub.md"]')!;
        expect(row.querySelector(".fg-row-detail")!.textContent).toBe("4 links, written 6 months ago");
        row.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(openNote).toHaveBeenCalledWith("hub.md");
    });

    it("a centre that is the note on screen should be drawn current and open nothing", () => {
        const view = mount();
        view.render({ index: VAULT, self: "a.md" }, ["a.md"]);
        const centre = view.element.querySelector<HTMLElement>(".lg-node--self")!;
        expect(centre.dataset["id"]).toBe("a.md");
        expect(centre.classList.contains("lg-node--opens")).toBe(false);
        centre.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        expect(openNote).not.toHaveBeenCalled();
    });

    it("the folder's name should head the column once the index arrives", () => {
        const view = mount();
        view.render(null, null);
        expect(view.element.querySelector<HTMLElement>(".fo-title")!.hidden).toBe(true);
        view.render({ index: VAULT, self: null }, []);
        const title = view.element.querySelector<HTMLElement>(".fo-title")!;
        expect(title.hidden).toBe(false);
        expect(title.textContent).toBe("v");
        expect(view.element.firstElementChild).toBe(title);
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
        const view = createFolderOverview({ defer: (run) => run(), openNote: () => {}, onEscape: () => {} });
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
        const { close } = openFolderOverview({ openNote: () => {}, onDismiss: () => {} });
        const types = posted().map((m) => m.type);
        expect(types).toContain("requestFolderRecents");
        expect(types).toContain("requestFolderIndex");
        const surface = document.querySelector<HTMLElement>(".fo-surface")!;
        expect(surface.querySelector(".fo-caption")!.textContent).toBe("Reading the folder…");
        receiveFolderIndex(VAULT, "lone.md");
        receiveFolderRecents(["sub/far.md", "a.md"]);
        expect(surface.querySelector(".lg-node--self")!.getAttribute("data-id")).toBe("sub/far.md");
        expect(rows(surface)).toEqual(["sub/far.md", "a.md"]);
        expect(surface.getAttribute("aria-label")).toBe("Folder: v");
        expect(surface.querySelector(".fo-title")!.textContent).toBe("v");
        // Set in the document's area, beside the chrome, not a modal over it.
        expect(surface.classList.contains("fs-surface--in-content")).toBe(true);
        expect(surface.getAttribute("aria-modal")).toBeNull();
        close();
    });

    it("every opening should ask again, because the list moves with every file opened", () => {
        openFolderOverview({ openNote: () => {}, onDismiss: () => {} }).close();
        openFolderOverview({ openNote: () => {}, onDismiss: () => {} }).close();
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
        const { close } = openFolderOverview({ openNote: () => {}, onDismiss: () => {} });
        receiveFolderIndex(VAULT, null);
        expect((document.activeElement as HTMLElement).classList.contains("lg-node")).toBe(true);
        receiveFolderRecents(["lone.md", "a.md"]);
        expect((document.activeElement as HTMLElement).dataset["path"]).toBe("lone.md");
        close();
    });

    it("once the reader has moved, a redraw should keep focus on the same row rather than move it", () => {
        const { close } = openFolderOverview({ openNote: () => {}, onDismiss: () => {} });
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
        const { close } = openFolderOverview({ openNote: () => {}, onDismiss: () => {} });
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

/** Eight of the reader's recent files, more than the start view lists. */
const FILES = Array.from({ length: 8 }, (_, i) => ({ path: `/u/notes/n${i}.md`, name: `n${i}.md`, detail: "~/notes" }));

const launcherSpy = () => ({
    newNote: vi.fn(),
    open: vi.fn(),
    openRecent: vi.fn<(path: string) => void>(),
    openRecentMenu: vi.fn<(anchor: DOMRect) => void>(),
}) satisfies StartLauncher;

const press = (el: Element): void => { el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); };

describe("the start view", () => {
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

    it("with no folder it should draw the two buttons and the recent files, and no folder section", () => {
        const launcher = launcherSpy();
        const view = createFolderOverview({ defer: (run) => run(), openNote: () => {}, onEscape: () => {}, launcher, folder: false });
        document.body.append(view.element);
        view.render(null, null, FILES);
        expect([...view.element.querySelectorAll(".fo-action")].map((b) => b.textContent)).toEqual(["New Note", "Open…"]);
        expect(view.element.querySelector(".lg-stage")).toBeNull();
        expect(view.element.querySelector(".fo-caption")).toBeNull();
        expect(rows(view.element)).toEqual([]);
        const files = [...view.element.querySelectorAll<HTMLElement>(".fo-file")].map((b) => b.dataset["file"]);
        expect(files).toEqual(FILES.slice(0, START_RECENTS).map((f) => f.path));
        expect(START_RECENTS).toBe(6);
    });

    it("Open Recent… should close the list, drawn even before the files arrive", () => {
        const view = createFolderOverview({ defer: (run) => run(), openNote: () => {}, onEscape: () => {}, launcher: launcherSpy(), folder: false });
        view.render(null, null, null);
        const list = view.element.querySelector(".fo-files")!;
        expect([...list.children].map((c) => c.textContent)).toEqual(["Open Recent…"]);
        view.render(null, null, FILES.slice(0, 2));
        expect(list.lastElementChild!.textContent).toBe("Open Recent…");
        expect(list.children).toHaveLength(3);
    });

    it("each control should run the launcher gesture it names", () => {
        const launcher = launcherSpy();
        const view = createFolderOverview({ defer: (run) => run(), openNote: () => {}, onEscape: () => {}, launcher, folder: false });
        document.body.append(view.element);
        view.render(null, null, FILES);
        const [newNote, open] = [...view.element.querySelectorAll(".fo-action")];
        press(newNote!);
        press(open!);
        press(view.element.querySelector('.fo-file[data-file="/u/notes/n2.md"]')!);
        press(view.element.querySelector(".fo-more")!);
        expect(launcher.newNote).toHaveBeenCalledTimes(1);
        expect(launcher.open).toHaveBeenCalledTimes(1);
        expect(launcher.openRecent).toHaveBeenCalledWith("/u/notes/n2.md");
        expect(launcher.openRecentMenu).toHaveBeenCalledTimes(1);
    });

    it("in a folder it should put the name and buttons first, the two lists next, and the drawing last", () => {
        const view = createFolderOverview({ defer: (run) => run(), openNote: () => {}, onEscape: () => {}, launcher: launcherSpy() });
        document.body.append(view.element);
        view.render({ index: VAULT, self: null }, ["a.md"], FILES);
        const children = [...view.element.children];
        const at = (selector: string): number => children.indexOf(view.element.querySelector(selector)!);
        expect(at(".fo-title")).toBe(0);
        expect(at(".fo-actions")).toBe(1);
        expect(at(".fo-row")).toBe(-1); // a row is inside its list, not a child
        expect(at(".fo-recents:not(.fo-files)")).toBeGreaterThan(at(".fo-actions"));
        expect(at(".fo-files")).toBeGreaterThan(at(".fo-recents:not(.fo-files)"));
        expect(at(".lg-stage")).toBeGreaterThan(at(".fo-files"));
        const headings = [...view.element.querySelectorAll<HTMLElement>(".fo-heading")].filter((h) => !h.hidden).map((h) => h.textContent);
        expect(headings).toEqual(["In this folder", "Recent", "Subjects"]);
    });

    it("without a launcher the overview should be as it was: no buttons, no reader's list", () => {
        const view = createFolderOverview({ defer: (run) => run(), openNote: () => {}, onEscape: () => {} });
        view.render({ index: VAULT, self: null }, ["a.md"], FILES);
        expect(view.element.querySelector(".fo-actions")).toBeNull();
        expect(view.element.querySelector(".fo-files")).toBeNull();
        expect(view.element.querySelector(".fo-heading")!.textContent).toBe("Recent files");
    });

    it("pinned, as a window's empty state, it should ask only for the reader's files and refuse Escape", () => {
        const onDismiss = vi.fn();
        openFolderOverview({ openNote: () => {}, onDismiss, launcher: launcherSpy(), empty: true });
        const types = posted().map((m) => m.type);
        expect(types).toContain("requestRecentFiles");
        expect(types).not.toContain("requestFolderRecents");
        const surface = document.querySelector<HTMLElement>(".fo-surface")!;
        expect(surface.getAttribute("aria-label")).toBe("No File Open");
        expect(surface.querySelector(".fo-title")).toBeNull();
        expect(surface.querySelector<HTMLElement>(".fs-actions__group--close")!.hidden).toBe(true);
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(onDismiss).not.toHaveBeenCalled();
        expect(surface.isConnected && !surface.classList.contains("lb-closing")).toBe(true);
        receiveRecentFiles(FILES.slice(0, 1));
        expect(surface.querySelectorAll(".fo-file")).toHaveLength(1);
        expect(document.activeElement!.textContent).toBe("New Note");
    });

    it("over a folder, the drawing should wait for the recent files rather than draw the hub first", () => {
        receiveFolderIndex(VAULT, null);
        openFolderOverview({ openNote: () => {}, onDismiss: () => {}, launcher: launcherSpy() });
        const surface = document.querySelector<HTMLElement>(".fo-surface")!;
        expect(surface.querySelectorAll(".lg-node")).toHaveLength(0);
        receiveFolderRecents(["sub/far.md"]);
        expect(surface.querySelector<HTMLElement>(".lg-node--self")!.dataset["id"]).toBe("sub/far.md");
    });

    it("New Note over a folder should put the overview away before the host acts; Open should leave it up", () => {
        const launcher = launcherSpy();
        const onDismiss = vi.fn();
        openFolderOverview({ openNote: () => {}, onDismiss, launcher });
        const surface = document.querySelector<HTMLElement>(".fo-surface")!;
        press(surface.querySelectorAll(".fo-action")[1]!);
        expect(launcher.open).toHaveBeenCalledTimes(1);
        expect(surface.classList.contains("lb-closing")).toBe(false);
        press(surface.querySelectorAll(".fo-action")[0]!);
        expect(launcher.newNote).toHaveBeenCalledTimes(1);
        expect(onDismiss).toHaveBeenCalledTimes(1);
        expect(surface.classList.contains("lb-closing") || !surface.isConnected).toBe(true);
    });
});

describe("overviewCentre", () => {
    it("recent notes that link nowhere should not hide an older note that does", () => {
        const now = Date.UTC(2026, 10, 24);
        const daily = Array.from({ length: 60 }, (_, i) => node(`daily/${i}.md`));
        const idx: FolderIndex = {
            ...VAULT,
            nodes: [
                ...VAULT.nodes.map((n) => ({ ...n, modified: now - 300 * 86_400_000 })),
                ...daily.map((n, i) => ({ ...n, modified: now - i * 86_400_000 })),
            ],
        };
        const centre = overviewCentre(idx, null, activityOf(idx, null, now));
        expect(centre?.reason).toBe("active");
        expect(VAULT.nodes.map((n) => n.path)).toContain(centre!.graph.nodes[0]!.id);
    });
});

describe("a centre joined only by likeness", () => {
    it("the most active note should be the centre when likeness is all that joins it", () => {
        const now = Date.UTC(2026, 10, 24);
        const idx: FolderIndex = {
            rootName: "v", truncated: false,
            nodes: [node("fresh.md"), node("alike.md"), node("old.md"), node("older.md")].map((n, i) => ({ ...n, modified: now - (i === 0 ? 0 : 300) * 86_400_000 })),
            edges: [edge("old.md", "older.md")],
            similar: [{ a: "alike.md", b: "fresh.md", score: 0.4 }],
        };
        const centre = overviewCentre(idx, null, activityOf(idx, null, now));
        expect(centre?.graph.nodes[0]!.id).toBe("fresh.md");
        expect(centre?.graph.nodes.find((n) => n.id === "alike.md")?.alike).toBe(true);
    });
});

describe("a folder gone quiet", () => {
    it("a centre that is itself dormant should be called the note touched most recently, not current work", () => {
        const now = Date.UTC(2026, 10, 24);
        const old = now - 400 * 86_400_000;
        const dated: FolderIndex = { ...VAULT, nodes: VAULT.nodes.map((n) => ({ ...n, modified: old })) };
        const view = createFolderOverview({ defer: (run) => run(), openNote: () => {}, onEscape: () => {}, now: () => now });
        document.body.append(view.element);
        view.render({ index: dated, self: null }, null);
        const caption = view.element.querySelector(".fo-caption")!.textContent!;
        expect(caption).toContain("nothing here has been touched in months");
        expect(caption).not.toContain("where you have been working");
        view.element.remove();
    });
});

describe("sinceWritten", () => {
    const now = Date.UTC(2026, 10, 24);
    const DAY = 86_400_000;
    it("an age should read in days, then whole months, then years, and never as one year at under two", () => {
        expect(sinceWritten(now - 10 * DAY, now)).toBe("10 days ago");
        expect(sinceWritten(now - 200 * DAY, now)).toBe("6 months ago");
        expect(sinceWritten(now - 720 * DAY, now)).toBe("23 months ago");
        expect(sinceWritten(now - 800 * DAY, now)).toBe("2 years ago");
    });
});
