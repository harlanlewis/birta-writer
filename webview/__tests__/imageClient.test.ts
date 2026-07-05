/**
 * imageClient.ts tests: verify that a save request is correlated with its
 * response by id, that success resolves and failure rejects the returned
 * promise, and that concurrent saves never cross wires.
 *
 * The only test double is the injected VS Code API (postMessage), set up in
 * setup.ts; the File/FileReader path runs for real under jsdom.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";

// Deferred import so acquireVsCodeApi (injected by setup.ts) exists first.
const { saveImageFile, handleImageSaved, handleImageSaveError } = await import(
    "../../webview/imageClient"
);

function makePng(bytes: number[] = [1, 2, 3, 4]): File {
    return new File([new Uint8Array(bytes)], "photo.png", { type: "image/png" });
}

/** The ids of every saveImage message posted so far, in order. */
function postedSaveIds(): string[] {
    return mockVscodeApi.postMessage.mock.calls
        .map((args) => args[0])
        .filter((m) => m?.type === "saveImage")
        .map((m) => m.id as string);
}

/** Wait until `count` saveImage messages have been posted, then return their ids. */
function waitForSaveIds(count: number): Promise<string[]> {
    return vi.waitFor(() => {
        const ids = postedSaveIds();
        expect(ids.length).toBe(count);
        return ids;
    });
}

describe("imageClient — save request/response correlation", () => {
    beforeEach(() => {
        vi.clearAllMocks();
    });

    it("a saved response should resolve the promise with the returned URL", async () => {
        const promise = saveImageFile(makePng(), "alt");
        const [id] = await waitForSaveIds(1);
        handleImageSaved(id, "vscode-webview://img/photo.png");
        await expect(promise).resolves.toBe("vscode-webview://img/photo.png");
    });

    it("a save-error response should reject the promise with the reported message", async () => {
        const promise = saveImageFile(makePng(), "alt");
        const [id] = await waitForSaveIds(1);
        handleImageSaveError(id, "disk full");
        await expect(promise).rejects.toThrow("disk full");
    });

    it("concurrent saves resolved out of order should each get their own URL", async () => {
        const p1 = saveImageFile(makePng([1]), "a");
        const p2 = saveImageFile(makePng([2]), "b");
        const [id1, id2] = await waitForSaveIds(2);
        expect(id1).not.toBe(id2);

        // Resolve the second request first to prove correlation is by id, not order.
        handleImageSaved(id2, "url-2");
        handleImageSaved(id1, "url-1");

        await expect(p1).resolves.toBe("url-1");
        await expect(p2).resolves.toBe("url-2");
    });

    it("a response for an unknown id should be ignored without throwing", () => {
        expect(() => handleImageSaved("no-such-id", "x")).not.toThrow();
        expect(() => handleImageSaveError("no-such-id", "x")).not.toThrow();
    });
});
