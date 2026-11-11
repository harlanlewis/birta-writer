/**
 * The Folder Overview command's route from a host to the page (MAR-488): how a
 * note is opened when the open document is not in the index, what a second run
 * does while one overview is open, where a failure goes, how a live capability
 * change reaches the idle list a host menu dims by, and that a note's own name
 * is never read as a replacement pattern.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "./setup";
import type { FolderEdge, FolderIndex, FolderNode } from "../../shared/folderIndex";
import { idleCommandIds, setCommandsIdle } from "../../shared/commandAvailability";
import { HOST_PROFILES } from "../../shared/hostProfile";
import { createMessageHandlers, type MessageHandlerDeps } from "../messageHandlers";
import { createFolderOverview } from "../components/graph/folderOverview";
import * as graphModule from "../components/graph";
import {
    FOLDER_OVERVIEW_COMMAND,
    receiveFolderIndex,
    resetFolderIndexForTests,
    syncFolderOverviewAvailability,
} from "../links/folderIndex";
import { _resetFolderOverviewForTests, showFolderOverview, showStartView } from "../links/folderOverviewCommand";

const node = (path: string, name = path.replace(/^.*\//, "").replace(/\.md$/, "")): FolderNode =>
    ({ path, name, type: null, tags: [], status: null, trust: null, staleAfter: null });
const edge = (from: string, to: string | null, target = to ?? "x"): FolderEdge =>
    ({ from, to, target, kind: "link", text: "", line: 1 });

/** notes/hub.md is named by a, b and c; the open document is not in the index. */
const VAULT: FolderIndex = {
    rootName: "v",
    nodes: [node("notes/hub.md"), node("a.md"), node("b.md"), node("c.md")],
    edges: [edge("a.md", "notes/hub.md"), edge("b.md", "notes/hub.md"), edge("c.md", "notes/hub.md")],
    truncated: true,
};

type Posted = { type: string; path?: string };
const api = () => (globalThis as unknown as {
    acquireVsCodeApi: () => { postMessage: { mock: { calls: Array<[Posted]> } } };
}).acquireVsCodeApi();
const posted = (): Posted[] => api().postMessage.mock.calls.map((c) => c[0]);

type I18n = { __i18n?: Record<string, unknown> };

beforeEach(() => {
    vi.clearAllMocks();
    document.body.replaceChildren();
    resetFolderIndexForTests();
    _resetFolderOverviewForTests();
});

afterEach(() => {
    document.querySelectorAll(".fs-surface").forEach((el) => el.remove());
    setCommandsIdle([FOLDER_OVERVIEW_COMMAND], false);
    delete (window as I18n).__i18n;
    resetFolderIndexForTests();
    _resetFolderOverviewForTests();
});

describe("opening a note from the overview with no self (finding 1)", () => {
    it("a document outside the index should open the note from the folder's root, not from its own folder", async () => {
        // VS Code: no `projectFiles`, so the path goes through `openFile`,
        // which resolves a plain relative path against the open document.
        (window as I18n).__i18n = { translations: {}, isMac: false, folderGraph: true };
        await showFolderOverview({ focusEditor: () => {} });
        receiveFolderIndex(VAULT, null);
        document.querySelector<HTMLElement>('.lg-node[data-id="notes/hub.md"]')!
            .dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
        const opened = posted().filter((m) => m.type === "openFile").map((m) => m.path);
        expect(opened).toEqual(["/notes/hub.md"]);
    });
});

describe("running the command while an overview is open (finding 2)", () => {
    it("a second run should not stack a second surface or ask for the recent files again", async () => {
        (window as I18n).__i18n = { translations: {}, isMac: true, folderGraph: true };
        await showFolderOverview({ focusEditor: () => {} });
        await showFolderOverview({ focusEditor: () => {} });
        expect(document.querySelectorAll(".fo-surface")).toHaveLength(1);
        expect(posted().filter((m) => m.type === "requestFolderRecents")).toHaveLength(1);
    });

    it("two runs before the chunk has loaded should still open one", async () => {
        (window as I18n).__i18n = { translations: {}, isMac: true, folderGraph: true };
        await Promise.all([showFolderOverview({ focusEditor: () => {} }), showFolderOverview({ focusEditor: () => {} })]);
        expect(document.querySelectorAll(".fo-surface")).toHaveLength(1);
    });

    it("once the open one is closed, a run should open a fresh one", async () => {
        (window as I18n).__i18n = { translations: {}, isMac: true, folderGraph: true };
        await showFolderOverview({ focusEditor: () => {} });
        document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        document.querySelectorAll(".fs-surface").forEach((el) => el.remove());
        await showFolderOverview({ focusEditor: () => {} });
        expect(document.querySelectorAll(".fo-surface")).toHaveLength(1);
        expect(posted().filter((m) => m.type === "requestFolderRecents")).toHaveLength(2);
    });
});

describe("a failure inside the overview (finding 3)", () => {
    it("an exception while opening should reject, so the crash reporter's unhandled-rejection path sees it", async () => {
        (window as I18n).__i18n = { translations: {}, isMac: true, folderGraph: true };
        const boom = new Error("render failed");
        const load = () => Promise.resolve({
            ...graphModule,
            openFolderOverview: () => { throw boom; },
        } as typeof graphModule);
        await expect(showFolderOverview({ focusEditor: () => {}, load })).rejects.toBe(boom);
    });

    it("a chunk that failed to load should be tolerated, and the next run should try again", async () => {
        (window as I18n).__i18n = { translations: {}, isMac: true, folderGraph: true };
        const load = vi.fn(() => Promise.reject(new Error("chunk")));
        await expect(showFolderOverview({ focusEditor: () => {}, load })).resolves.toBeUndefined();
        await showFolderOverview({ focusEditor: () => {} });
        expect(document.querySelectorAll(".fo-surface")).toHaveLength(1);
    });
});

describe("a live capability change (finding 4)", () => {
    it("withdrawing folderIndex should mark the command idle, so a host menu dims its row", () => {
        (window as I18n).__i18n = {
            translations: {}, isMac: true, folderGraph: true,
            host: { capabilities: HOST_PROFILES.mac, arrangements: [], shortcuts: [] },
        };
        syncFolderOverviewAvailability();
        expect(idleCommandIds()).not.toContain(FOLDER_OVERVIEW_COMMAND);
        const deps = {
            state: {}, actions: {}, topbarTb: null,
        } as unknown as MessageHandlerDeps;
        createMessageHandlers(deps).hostCapabilitiesChanged!(
            { type: "hostCapabilitiesChanged", capabilities: HOST_PROFILES.mac.filter((c) => c !== "folderIndex") },
            document.createElement("div"));
        expect(idleCommandIds()).toContain(FOLDER_OVERVIEW_COMMAND);
    });
});

describe("a name holding a replacement pattern (finding 5)", () => {
    it("a folder or note named with $ sequences should be printed as written", () => {
        const odd: FolderIndex = {
            rootName: "a$&b$'c",
            nodes: [node("hub.md", "H$`ub$$"), node("x.md")],
            edges: [edge("x.md", "hub.md"), edge("hub.md", null, "Miss$&ing")],
            truncated: false,
        };
        const view = createFolderOverview({ openNote: () => {}, onEscape: () => {} });
        document.body.append(view.element);
        view.render({ index: odd, self: null }, null);
        expect(view.element.querySelector(".fo-caption")!.textContent).toContain("Centred on H$`ub$$,");
        const dangling = view.element.querySelector<HTMLElement>(".lg-node--dangling")!;
        expect(dangling.getAttribute("aria-label")).toBe("Miss$&ing (not a note in this folder)");
    });

    it("the overview's title should print the folder's name as written", async () => {
        (window as I18n).__i18n = { translations: {}, isMac: true, folderGraph: true };
        await showFolderOverview({ focusEditor: () => {} });
        receiveFolderIndex({ ...VAULT, rootName: "a$&b$'c" }, null);
        expect(document.querySelector(".fo-surface .fs-title")!.textContent).toBe("Folder: a$&b$'c");
    });
});

describe("the start view, from the host's showStartView", () => {
    const mac = (): void => {
        (window as I18n).__i18n = {
            translations: {}, isMac: true, folderGraph: true,
            host: { capabilities: HOST_PROFILES.mac, arrangements: [], shortcuts: [] },
        };
    };

    it("the message should open one pinned start view, and a second should not stack another", async () => {
        mac();
        const handlers = createMessageHandlers({ state: {}, actions: {}, topbarTb: null } as unknown as MessageHandlerDeps);
        handlers.showStartView!({ type: "showStartView" }, document.createElement("div"));
        await showStartView();
        await showStartView();
        expect(document.querySelectorAll(".fo-surface")).toHaveLength(1);
        expect(document.querySelector(".fo-surface .fs-title")!.textContent).toBe("No File Open");
        expect(posted().filter((m) => m.type === "requestRecentFiles")).toHaveLength(1);
    });

    it("its buttons and rows should reach the host as the launcher messages", async () => {
        mac();
        await showStartView();
        const press = (el: Element): void => { el.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); };
        const surface = document.querySelector(".fo-surface")!;
        const [newNote, open] = [...surface.querySelectorAll(".fo-action")];
        press(newNote!);
        press(open!);
        press(surface.querySelector(".fo-more")!);
        const sent = posted().filter((m) => m.type === "startAction") as Array<Posted & { action: string; x?: number }>;
        expect(sent.map((m) => m.action)).toEqual(["newNote", "open", "openRecentMenu"]);
        expect(typeof sent[2]!.x).toBe("number");
    });

    it("a host with no launcher should draw no buttons: the view of a folder is as it was", async () => {
        (window as I18n).__i18n = { translations: {}, isMac: false, folderGraph: true };
        await showFolderOverview({ focusEditor: () => {} });
        expect(document.querySelector(".fo-surface .fo-actions")).toBeNull();
        expect(posted().map((m) => m.type)).not.toContain("requestRecentFiles");
    });
});
