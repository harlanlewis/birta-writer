/**
 * Which message opens a note the folder index names, per host.
 *
 * VS Code resolves `openFile` against the open document, so the path goes
 * relative and carries its line. Birta Writer for Mac parses no `openFile` (it
 * has no text editor to open one into) and opens a root-relative path through
 * the explorer's `openProjectFile`, so on a host declaring `projectFiles` the
 * index's own path goes there. A Backlinks row on the Mac that posted
 * `openFile` would be a row that silently does nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import { openIndexedNote } from "../links/folderIndex";

function declare(capabilities: string[]): void {
    (globalThis as { __i18n?: unknown }).__i18n = { host: { capabilities, arrangements: [], shortcuts: [] } };
}

describe("openIndexedNote", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });
    afterEach(() => {
        delete (globalThis as { __i18n?: unknown }).__i18n;
    });

    it("a host with no explorer should be sent openFile, relative to this note and at the line", () => {
        declare(["textEditor", "folderIndex"]);
        openIndexedNote("notes/here.md", "other/there.md", 12);
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "openFile", path: "../other/there.md#12" });
    });

    it("a file name holding % but no # should go literally, which resolution opens with smart links on or off", () => {
        declare(["textEditor", "folderIndex"]);
        openIndexedNote("here.md", "100% done.md", 3);
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "openFile", path: "./100% done.md#3" });
    });

    it("a file name holding # should be escaped, % with it, so the name is not read as a fragment", () => {
        declare(["textEditor", "folderIndex"]);
        openIndexedNote("here.md", "C# at 50%.md", 3);
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "openFile", path: "./C%23 at 50%25.md#3" });
    });

    it("a host with an explorer should be sent openProjectFile with the root-relative path", () => {
        declare(["projectFiles", "folderIndex"]);
        openIndexedNote("notes/here.md", "other/th#ere.md", 12);
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({ type: "openProjectFile", path: "other/th#ere.md", newTab: false });
        expect(mockVscodeApi.postMessage).not.toHaveBeenCalledWith(expect.objectContaining({ type: "openFile" }));
    });
});
