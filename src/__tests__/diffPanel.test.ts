/**
 * The two decisions the diff panel makes before it draws anything (MAR-55).
 *
 * `diffTargetFromArg` reconciles three invokers with three argument shapes,
 * and the shape it must NOT be strict about is the SCM one: a resource state
 * is built by the git extension, so the only thing this side can rely on is
 * that it carries a `resourceUri`. Testing it with a real `vscode.Uri` would
 * hide that, because an `instanceof` check would pass too - so the fixtures
 * here are plain objects, which is what actually arrives.
 *
 * `readWorkingContent` decides what "the working side" even means. Preferring
 * the open buffer over the file on disk is the whole reason the panel can show
 * unsaved work, and it is invisible in any test that saves first.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import * as vscode from "vscode";
import {
    makeFakeTextDocument,
    resetTextDocumentMocks,
    workspace as mockWorkspace,
} from "../../__mocks__/vscode";
import { diffTargetFromArg, readWorkingContent } from "../diffPanel";

describe("diffTargetFromArg", () => {
    const uri = vscode.Uri.file("/w/notes.md");
    const other = vscode.Uri.file("/w/fallback.md");

    it("a URI argument should be taken as the target", () => {
        expect(diffTargetFromArg(uri, other)).toBe(uri);
    });

    it("an SCM resource state should be unwrapped, without relying on its class", () => {
        // Exactly the shape the git extension hands a command: a plain object
        // from another extension's realm, not a vscode.Uri instance of ours.
        const resourceState = { resourceUri: { fsPath: "/w/scm.md", scheme: "file" } };
        expect(diffTargetFromArg(resourceState, other)).toBe(resourceState.resourceUri);
    });

    it("no argument should fall back, and no fallback should be undefined", () => {
        expect(diffTargetFromArg(undefined, other)).toBe(other);
        expect(diffTargetFromArg(undefined, undefined)).toBeUndefined();
    });

    it("an argument that is neither should fall back rather than be treated as a URI", () => {
        // A menu contribution can pass anything; a bare string or a resource
        // state with no URI must not become a target with a missing fsPath.
        for (const junk of ["/w/notes.md", 42, {}, { resourceUri: {} }, null]) {
            expect(diffTargetFromArg(junk, other)).toBe(other);
        }
    });
});

describe("readWorkingContent", () => {
    beforeEach(() => {
        resetTextDocumentMocks();
        vi.clearAllMocks();
    });

    it("an open buffer should be preferred over the bytes on disk", async () => {
        const uri = vscode.Uri.file("/w/notes.md");
        makeFakeTextDocument("unsaved edit\n", uri);
        mockWorkspace.fs.readFile.mockResolvedValue(new TextEncoder().encode("stale on disk\n"));

        expect(await readWorkingContent(uri)).toBe("unsaved edit\n");
        // Not merely "the right string": reading disk at all would mean the
        // panel could show saved bytes for a dirty document.
        expect(mockWorkspace.fs.readFile).not.toHaveBeenCalled();
    });

    it("a file with no open buffer should be read from disk", async () => {
        const uri = vscode.Uri.file("/w/closed.md");
        mockWorkspace.fs.readFile.mockResolvedValue(new TextEncoder().encode("on disk\n"));

        expect(await readWorkingContent(uri)).toBe("on disk\n");
        expect(mockWorkspace.fs.readFile).toHaveBeenCalledTimes(1);
    });

    it("a different file's open buffer should not be mistaken for this one", async () => {
        makeFakeTextDocument("other buffer\n", vscode.Uri.file("/w/other.md"));
        mockWorkspace.fs.readFile.mockResolvedValue(new TextEncoder().encode("on disk\n"));

        expect(await readWorkingContent(vscode.Uri.file("/w/notes.md"))).toBe("on disk\n");
    });
});
