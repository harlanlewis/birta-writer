/**
 * The file explorer through its gate (utils/fileExplorerLoader.ts): nothing
 * built until a host names a folder, the chunk's panel once it does, and the
 * wire between the two. Selection is the host's, listings are asked for
 * exactly when a folder opens, and a `projectRoot` with no root takes it all
 * down. Layout (the margins, the flyout, the drag) is e2e/fileExplorer's.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import { createFileExplorerGate, type FileExplorerGate } from "../utils/fileExplorerLoader";
import { LISTING_TIMEOUT_MS } from "../components/fileExplorer";
import type { EventManager } from "../eventManager";
import type { ProjectEntry, ToExtensionMessage } from "../../shared/messages";

// `onWindow` hands back an unbind, as the real one does: teardown is asserted
// to call it, so a fake returning nothing would hide a leaked resize listener.
const offResize = vi.fn();
const fakeEventManager = { onWindow: vi.fn(() => offResize) } as unknown as EventManager;

type Posted = ToExtensionMessage;
const posted = (): Posted[] => mockVscodeApi.postMessage.mock.calls.map((c) => c[0] as Posted);
const listRequests = (path?: string) =>
    posted().filter((m): m is Extract<Posted, { type: "listDirectory" }> =>
        m.type === "listDirectory" && (path === undefined || m.path === path));

const dir = (name: string, hidden = false): ProjectEntry => ({ name, kind: "dir", openable: true, hidden });
const file = (name: string, openable = true, hidden = false): ProjectEntry => ({ name, kind: "file", openable, hidden });

const ROOT = { name: "Notes", path: "/Users/me/Notes" };

function declareHost(): void {
    (globalThis as { __i18n?: unknown }).__i18n = {
        translations: {},
        isMac: true,
        host: { capabilities: ["projectFiles"], arrangements: [], shortcuts: [] },
    };
}

function makeGate(): FileExplorerGate {
    const editorDom = document.createElement("div");
    editorDom.tabIndex = 0;
    editorDom.className = "editor-stand-in";
    document.body.appendChild(editorDom);
    return createFileExplorerGate({
        eventManager: fakeEventManager,
        getEditorView: () => ({ focus: () => editorDom.focus() } as never),
        neighborReserve: () => 0,
    });
}

const panel = (): HTMLElement | null => document.querySelector(".files-panel");
const row = (path: string): HTMLElement | null =>
    document.querySelector(`.files-row[data-path="${path}"]`);

async function mounted(gate: FileExplorerGate): Promise<void> {
    gate.setProjectRoot(ROOT, false);
    await vi.waitFor(() => { expect(panel()).not.toBeNull(); });
}

/** Answer the newest outstanding request for `path`. */
function answer(gate: FileExplorerGate, path: string, entries: ProjectEntry[] | null, error?: string): void {
    const req = listRequests(path).at(-1);
    expect(req, `no listDirectory for "${path}"`).toBeDefined();
    gate.applyDirectoryListing({ type: "directoryListing", id: req!.id, path, entries, ...(error ? { error } : {}) });
}

describe("the file explorer gate", () => {
    let gate: FileExplorerGate;

    beforeEach(() => {
        vi.clearAllMocks();
        declareHost();
        Object.defineProperty(window, "innerWidth", { value: 1200, configurable: true });
        vi.stubGlobal("requestAnimationFrame", (cb: FrameRequestCallback) => { cb(0); return 0; });
        document.body.className = "";
        document.body.innerHTML = "";
        document.documentElement.style.cssText = "";
        gate = makeGate();
    });

    afterEach(() => {
        gate.setProjectRoot(null, false);
        vi.unstubAllGlobals();
        vi.useRealTimers();
        delete (globalThis as { __i18n?: unknown }).__i18n;
    });

    it("no root should build no DOM and post nothing", async () => {
        gate.setCurrentProjectFile("a.md");
        gate.directoryChanged([""]);
        gate.toggle();
        await new Promise((r) => setTimeout(r, 0));
        expect(panel()).toBeNull();
        expect(posted()).toEqual([]);
    });

    it("a null root should build nothing either, however the host declares itself", async () => {
        gate.setProjectRoot(null, false);
        await new Promise((r) => setTimeout(r, 0));
        expect(panel()).toBeNull();
        expect(posted()).toEqual([]);
    });

    it("a root should build the panel, name it, and ask for the root listing once", async () => {
        await mounted(gate);
        expect(panel()!.getAttribute("role")).toBe("complementary");
        expect(panel()!.querySelector(".files-header__name")!.textContent).toBe("Notes");
        expect(listRequests("")).toHaveLength(1);
        expect(listRequests()).toHaveLength(1);
        // Docked open at this width, in the shell's vocabulary.
        expect(document.body.classList.contains("files-open")).toBe(true);
    });

    it("a root arriving with folders to open should list each of them at once and draw them open", async () => {
        gate.setProjectRoot(ROOT, false, ["docs", "docs/guide"]);
        await vi.waitFor(() => { expect(panel()).not.toBeNull(); });
        // The root and both folders, each asked for on its own rather than
        // after its parent's listing lands.
        expect(listRequests().map((m) => m.path)).toEqual(["", "docs", "docs/guide"]);
        answer(gate, "", [dir("docs")]);
        answer(gate, "docs", [dir("guide"), file("a.md")]);
        answer(gate, "docs/guide", [file("deep.md")]);
        expect(row("docs")!.getAttribute("aria-expanded")).toBe("true");
        expect(row("docs/guide")!.getAttribute("aria-expanded")).toBe("true");
        expect(row("docs/guide/deep.md")).not.toBeNull();
        // Seeding is not a report: the host already holds this set.
        expect(posted().filter((m) => m.type === "fileExplorerExpanded")).toEqual([]);
        // A toggle is: the whole open set goes out, shallowest first.
        row("docs/guide")!.click();
        row("docs")!.click();
        row("docs")!.click();
        expect(posted().filter((m) => m.type === "fileExplorerExpanded")).toEqual([
            { type: "fileExplorerExpanded", paths: ["docs"] },
            { type: "fileExplorerExpanded", paths: [] },
            { type: "fileExplorerExpanded", paths: ["docs"] },
        ]);
    });

    it("messages arriving before the chunk lands should replay into the panel in order", async () => {
        gate.setProjectRoot(ROOT, false);
        // Before the import resolves: the host names the current file at once.
        gate.setCurrentProjectFile("docs/a.md");
        await vi.waitFor(() => { expect(panel()).not.toBeNull(); });
        // The reveal asked for the root and for `docs`, in that order.
        expect(listRequests().map((m) => m.path)).toEqual(["", "docs"]);
    });

    it("a null root after a panel exists should tear it down and leave no body class behind", async () => {
        await mounted(gate);
        expect([...document.body.classList].some((c) => c.startsWith("files-"))).toBe(true);
        const trigger = document.createElement("button");
        document.body.appendChild(trigger);
        gate.setFlyoutTrigger(trigger);
        offResize.mockClear();
        gate.setProjectRoot(null, false);
        expect(panel()).toBeNull();
        expect([...document.body.classList].filter((c) => c.startsWith("files-"))).toEqual([]);
        // And nothing of the panel is left listening: a resize or a hover on
        // the bar's button after teardown must not write its classes back.
        expect(offResize).toHaveBeenCalledTimes(1);
        trigger.dispatchEvent(new Event("mouseenter"));
        expect([...document.body.classList].filter((c) => c.startsWith("files-"))).toEqual([]);
        trigger.remove();
    });

    it("a host without the capability should queue nothing for a panel that will never load", async () => {
        (globalThis as { __i18n?: unknown }).__i18n = {
            translations: {}, isMac: true,
            host: { capabilities: [], arrangements: [], shortcuts: [] },
        };
        gate.setProjectRoot(ROOT, false);
        gate.setCurrentProjectFile("docs/a.md");
        gate.directoryChanged([""]);
        expect(gate.queuedForTesting()).toBe(0);
        // And nothing loads: the root was never recorded.
        await new Promise((r) => setTimeout(r, 0));
        expect(panel()).toBeNull();
    });

    it("the root listing should draw folders first, then files, dimming the non-openable", async () => {
        await mounted(gate);
        answer(gate, "", [file("z.md"), file("notes.txt", false), dir("docs"), file("a.md")]);
        const rows = [...document.querySelectorAll<HTMLElement>(".files-row")];
        expect(rows.map((r) => r.dataset["path"])).toEqual(["docs", "a.md", "notes.txt", "z.md"]);
        expect(row("notes.txt")!.classList.contains("files-row--other")).toBe(true);
        expect(row("a.md")!.classList.contains("files-row--other")).toBe(false);
        expect(row("docs")!.getAttribute("aria-expanded")).toBe("false");
        expect(row("a.md")!.hasAttribute("aria-expanded")).toBe(false);
    });

    it("a non-openable file's row should carry its extension for the hover chip, and no other row should", async () => {
        await mounted(gate);
        answer(gate, "", [
            file("a.md"), file("Report Q4 final.PDF", false), file("archive.tar.gz", false),
            file("Makefile", false), file(".env", false), file("ends-with-dot.", false), dir("docs"),
        ]);
        // Upper-cased, the LAST extension of a doubled one, and none for a
        // name with nothing after its last dot or a dotfile, whose dot leads.
        expect(row("Report Q4 final.PDF")!.dataset["ext"]).toBe("PDF");
        expect(row("archive.tar.gz")!.dataset["ext"]).toBe("GZ");
        expect(row("Makefile")!.dataset["ext"]).toBeUndefined();
        expect(row(".env")!.dataset["ext"]).toBeUndefined();
        expect(row("ends-with-dot.")!.dataset["ext"]).toBeUndefined();
        expect(row("a.md")!.dataset["ext"]).toBeUndefined();
        expect(row("docs")!.dataset["ext"]).toBeUndefined();
    });

    it("the panel should hold one card, with the header and the tree inside it", async () => {
        await mounted(gate);
        const card = panel()!.querySelector(".files-card");
        expect(card).not.toBeNull();
        expect(card!.querySelector(".files-header")).not.toBeNull();
        expect(card!.querySelector(".files-tree")).not.toBeNull();
    });

    it("an empty root should say so", async () => {
        await mounted(gate);
        answer(gate, "", []);
        expect(document.querySelector(".files-empty")).not.toBeNull();
    });

    it("clicking a file should ask the host to open it and select nothing", async () => {
        await mounted(gate);
        answer(gate, "", [file("a.md"), file("notes.txt", false)]);
        row("a.md")!.click();
        row("notes.txt")!.click();
        const opens = posted().filter((m) => m.type === "openProjectFile");
        expect(opens).toEqual([
            { type: "openProjectFile", path: "a.md", newTab: false },
            { type: "openProjectFile", path: "notes.txt", newTab: false },
        ]);
        expect(document.querySelector(".files-row--selected")).toBeNull();
    });

    it("Cmd+click, a middle click and Cmd+Return should ask for the file in a new tab", async () => {
        await mounted(gate);
        answer(gate, "", [file("a.md")]);
        row("a.md")!.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, metaKey: true }));
        row("a.md")!.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 1 }));
        row("a.md")!.focus();
        row("a.md")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true }));
        // The other button of an auxclick (the right one) opens nothing.
        row("a.md")!.dispatchEvent(new MouseEvent("auxclick", { bubbles: true, cancelable: true, button: 2 }));
        expect(posted().filter((m) => m.type === "openProjectFile")).toEqual([
            { type: "openProjectFile", path: "a.md", newTab: true },
            { type: "openProjectFile", path: "a.md", newTab: true },
            { type: "openProjectFile", path: "a.md", newTab: true },
        ]);
    });

    it("a right-click on a file or folder row should hand the host the point and refuse the browser's menu", async () => {
        await mounted(gate);
        answer(gate, "", [dir("docs"), file("a.md")]);
        const onFile = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 40, clientY: 120 });
        row("a.md")!.dispatchEvent(onFile);
        const onDir = new MouseEvent("contextmenu", { bubbles: true, cancelable: true, clientX: 41, clientY: 90 });
        row("docs")!.dispatchEvent(onDir);
        expect(onFile.defaultPrevented && onDir.defaultPrevented).toBe(true);
        expect(posted().filter((m) => m.type === "projectFileMenu")).toEqual([
            { type: "projectFileMenu", path: "a.md", kind: "file", x: 40, y: 120 },
            { type: "projectFileMenu", path: "docs", kind: "dir", x: 41, y: 90 },
        ]);
        // A stand-in row (a folder's Loading) has no file to act on.
        row("docs")!.click();
        const onLoading = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
        document.querySelector(".files-row--loading")!.dispatchEvent(onLoading);
        expect(onLoading.defaultPrevented).toBe(false);
        expect(posted().filter((m) => m.type === "projectFileMenu")).toHaveLength(2);
    });

    it("clicking a folder should expand it and ask for exactly one listing", async () => {
        await mounted(gate);
        answer(gate, "", [dir("docs")]);
        row("docs")!.click();
        expect(listRequests("docs")).toHaveLength(1);
        expect(row("docs")!.getAttribute("aria-expanded")).toBe("true");
        // Until the answer: a loading row under it.
        expect(document.querySelector(".files-row--loading")).not.toBeNull();
        answer(gate, "docs", [file("inner.md")]);
        expect(row("docs/inner.md")).not.toBeNull();
        expect(row("docs/inner.md")!.getAttribute("aria-level")).toBe("2");
        // Closing and reopening a listed folder asks for nothing.
        row("docs")!.click();
        expect(row("docs/inner.md")).toBeNull();
        row("docs")!.click();
        expect(listRequests("docs")).toHaveLength(1);
        expect(row("docs/inner.md")).not.toBeNull();
    });

    it("currentProjectFile should expand and list every ancestor, then select and reveal the row", async () => {
        await mounted(gate);
        answer(gate, "", [dir("docs"), file("top.md")]);
        gate.setCurrentProjectFile("docs/deep/target.md");
        expect(listRequests("docs")).toHaveLength(1);
        answer(gate, "docs", [dir("deep")]);
        // The chain continues on its own as each answer lands.
        expect(listRequests("docs/deep")).toHaveLength(1);
        answer(gate, "docs/deep", [file("target.md"), file("other.md")]);
        const selected = row("docs/deep/target.md")!;
        expect(selected.classList.contains("files-row--selected")).toBe(true);
        expect(selected.getAttribute("aria-selected")).toBe("true");
        expect(document.querySelectorAll(".files-row--selected")).toHaveLength(1);
        // Null clears it.
        gate.setCurrentProjectFile(null);
        expect(document.querySelector(".files-row--selected")).toBeNull();
    });

    it("a reveal of a row that cannot be drawn should be given up, not kept for a later render", async () => {
        // A hidden file with the dotfile switch off has no row to scroll to.
        // Once nothing is in flight the reveal is over; showing dotfiles later
        // must not scroll to it as if the pick had just happened.
        const scrolled = vi.fn();
        const proto = Element.prototype as { scrollIntoView?: unknown };
        const had = proto.scrollIntoView;
        proto.scrollIntoView = scrolled;
        try {
            await mounted(gate);
            answer(gate, "", [file(".hidden.md", true, true), file("a.md")]);
            gate.setCurrentProjectFile(".hidden.md");
            expect(row(".hidden.md")!.hidden).toBe(true);
            expect(scrolled).not.toHaveBeenCalled();
            gate.setShowHidden(true);
            expect(row(".hidden.md")!.hidden).toBe(false);
            expect(scrolled).not.toHaveBeenCalled();
            // A fresh pick of the now-visible row does scroll: the give-up was
            // of that one reveal, not of revealing.
            gate.setCurrentProjectFile(".hidden.md");
            expect(scrolled).toHaveBeenCalledTimes(1);
        } finally {
            proto.scrollIntoView = had;
        }
    });

    it("a listing the host could not read should draw an error row that retries on activate", async () => {
        await mounted(gate);
        answer(gate, "", [dir("locked")]);
        row("locked")!.click();
        answer(gate, "locked", null, "Permission denied");
        const err = document.querySelector<HTMLElement>(".files-row--error");
        expect(err).not.toBeNull();
        expect(err!.textContent).toContain("Permission denied");
        err!.click();
        expect(listRequests("locked")).toHaveLength(2);
    });

    it("a listing nobody answers should become an error row when its wait runs out", async () => {
        await mounted(gate);
        answer(gate, "", [dir("slow")]);
        vi.useFakeTimers();
        row("slow")!.click();
        expect(document.querySelector(".files-row--loading")).not.toBeNull();
        vi.advanceTimersByTime(LISTING_TIMEOUT_MS - 1);
        expect(document.querySelector(".files-row--error")).toBeNull();
        vi.advanceTimersByTime(1);
        expect(document.querySelector(".files-row--error")).not.toBeNull();
        expect(document.querySelector(".files-row--loading")).toBeNull();
    });

    it("a reply to a request this panel never made should be ignored", async () => {
        await mounted(gate);
        gate.applyDirectoryListing({ type: "directoryListing", id: "someone-elses", path: "", entries: [file("ghost.md")] });
        expect(row("ghost.md")).toBeNull();
    });

    it("directoryChanged should re-list an expanded folder and only drop a collapsed one's cache", async () => {
        await mounted(gate);
        answer(gate, "", [dir("open"), dir("shut")]);
        row("open")!.click();
        answer(gate, "open", [file("a.md")]);
        row("shut")!.click();
        answer(gate, "shut", [file("b.md")]);
        row("shut")!.click(); // collapse it, listing cached
        const before = listRequests().length;

        gate.directoryChanged(["open", "shut"]);

        expect(listRequests("open")).toHaveLength(2);
        expect(listRequests("shut")).toHaveLength(1);
        expect(listRequests().length).toBe(before + 1);
        // The open folder keeps its rows while the answer is on its way.
        expect(row("open/a.md")).not.toBeNull();
        expect(document.querySelector(".files-row--loading")).toBeNull();
        // The collapsed one asks again when next opened.
        row("shut")!.click();
        expect(listRequests("shut")).toHaveLength(2);
    });

    it("the root changing on disk should re-list it in place", async () => {
        await mounted(gate);
        answer(gate, "", [file("a.md")]);
        gate.directoryChanged([""]);
        expect(listRequests("")).toHaveLength(2);
        expect(row("a.md")).not.toBeNull();
        answer(gate, "", [file("a.md"), file("b.md")]);
        expect(row("b.md")).not.toBeNull();
    });

    it("the hidden switch should conceal dotfiles without a re-list, and the command should post the choice", async () => {
        await mounted(gate);
        answer(gate, "", [file(".env", true, true), file("a.md")]);
        const requests = listRequests().length;
        expect(row(".env")!.hidden).toBe(true);

        gate.setShowHidden(true);
        expect(row(".env")!.hidden).toBe(false);
        expect(listRequests().length).toBe(requests);

        gate.toggleHidden();
        expect(row(".env")!.hidden).toBe(true);
        expect(posted().filter((m) => m.type === "setFileExplorerShowHidden"))
            .toEqual([{ type: "setFileExplorerShowHidden", value: false }]);
    });

    it("toggle should close and reopen the panel, telling the host each time", async () => {
        await mounted(gate);
        gate.toggle();
        expect(document.body.classList.contains("files-open")).toBe(false);
        gate.toggle();
        expect(document.body.classList.contains("files-open")).toBe(true);
        expect(posted().filter((m) => m.type === "fileExplorerVisibility")).toEqual([
            { type: "fileExplorerVisibility", visible: false },
            { type: "fileExplorerVisibility", visible: true },
        ]);
    });

    it("a remembered hide should open the panel closed", async () => {
        (globalThis as { __i18n?: { fileExplorerVisible?: boolean } }).__i18n!.fileExplorerVisible = false;
        await mounted(gate);
        expect(document.body.classList.contains("files-open")).toBe(false);
    });

    it("focus should land on the current file's row, opening the panel if it was hidden", async () => {
        await mounted(gate);
        answer(gate, "", [file("a.md"), file("b.md")]);
        gate.setCurrentProjectFile("b.md");
        gate.toggle(); // hide it first
        expect(document.body.classList.contains("files-open")).toBe(false);

        gate.focus();

        expect(document.body.classList.contains("files-open")).toBe(true);
        expect(document.activeElement).toBe(row("b.md"));
    });

    it("focus with nothing current should land on the first row", async () => {
        await mounted(gate);
        answer(gate, "", [dir("docs"), file("a.md")]);
        gate.focus();
        expect(document.activeElement).toBe(row("docs"));
    });

    it("Right should open a folder, Left should close it or climb to the parent, Escape should return to the editor", async () => {
        await mounted(gate);
        answer(gate, "", [dir("docs")]);
        gate.focus();
        const docs = row("docs")!;
        expect(document.activeElement).toBe(docs);

        docs.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        expect(docs.getAttribute("aria-expanded")).toBe("true");
        answer(gate, "docs", [file("inner.md")]);
        // Right on an open folder moves to its first child.
        row("docs")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        expect(document.activeElement).toBe(row("docs/inner.md"));
        // Left on a file climbs to its folder.
        row("docs/inner.md")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
        expect(document.activeElement).toBe(row("docs"));
        // Left on an open folder closes it.
        row("docs")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowLeft", bubbles: true }));
        expect(row("docs")!.getAttribute("aria-expanded")).toBe("false");
        // Enter on a file asks the host to open it.
        row("docs")!.dispatchEvent(new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }));
        row("docs/inner.md")!.focus();
        row("docs/inner.md")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
        expect(posted().filter((m) => m.type === "openProjectFile")).toEqual([{ type: "openProjectFile", path: "docs/inner.md", newTab: false }]);
        // Escape hands focus back to the editor.
        row("docs/inner.md")!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
        expect(document.activeElement).toBe(document.querySelector(".editor-stand-in"));
    });

    it("a new root should forget every listing and ask for the new root", async () => {
        await mounted(gate);
        answer(gate, "", [file("a.md")]);
        gate.setProjectRoot({ name: "Other", path: "/elsewhere" }, false);
        expect(panel()!.querySelector(".files-header__name")!.textContent).toBe("Other");
        expect(row("a.md")).toBeNull();
        expect(listRequests("")).toHaveLength(2);
    });

    it("dockedReserve should be the panel's width while docked open and nothing otherwise", async () => {
        expect(gate.dockedReserve()).toBe(0);
        await mounted(gate);
        expect(gate.dockedReserve()).toBeGreaterThan(0);
        gate.toggle();
        expect(gate.dockedReserve()).toBe(0);
    });
});
