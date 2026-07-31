/**
 * The drag-time aim for a dropped image file (editing/fileDrop.ts). Two
 * halves:
 *
 *   - the CLAIM: which drags this path takes over, and that it marks them
 *     handled so a drop can fire in this document at all;
 *   - DEPARTURE: telling "the drag left" from "the pointer crossed into the
 *     next element", which decides whether the drop line stays up.
 *
 * The aiming geometry itself (nearest-boundary snapping, the drop line, the
 * position the drop lands at) needs real layout — jsdom measures every rect as
 * zero — so it lives in e2e/imageDrop.
 *
 * Note what these CANNOT check: VS Code's own whole-editor drop overlay is
 * painted by the workbench in another document, and no webview-side assertion
 * can observe it. See the module header for what is actually within reach.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
    aimedDropPos,
    clearDropAim,
    dragCarriesImageFile,
    dragLeftDocument,
    initImageFileDrop,
} from "../editing/fileDrop";
import { createEventManager, type EventManager } from "../eventManager";

const managers: EventManager[] = [];

afterEach(() => {
    for (const manager of managers.splice(0)) {
        manager.dispose();
    }
    clearDropAim();
    document.body.innerHTML = "";
    vi.restoreAllMocks();
});

/** A DragEvent stand-in: jsdom has no DataTransfer, and the handlers read
 * only these fields. */
function dragEvent(
    type: string,
    items: { kind: string; type: string }[],
    at: { x?: number; y?: number; relatedTarget?: EventTarget | null } = {},
): DragEvent {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", {
        value: { items, files: [], dropEffect: "none" },
    });
    Object.defineProperty(event, "clientX", { value: at.x ?? 10 });
    Object.defineProperty(event, "clientY", { value: at.y ?? 10 });
    Object.defineProperty(event, "relatedTarget", { value: at.relatedTarget ?? null });
    return event as DragEvent;
}

const IMAGE_ITEM = { kind: "file", type: "image/png" };
const TEXT_FILE_ITEM = { kind: "file", type: "text/markdown" };

function wire(): void {
    const manager = createEventManager();
    managers.push(manager);
    const container = document.createElement("div");
    document.body.appendChild(container);
    initImageFileDrop(manager, { container, getView: () => null });
}

describe("dragCarriesImageFile", () => {
    it("an image file in the item list should be claimed", () => {
        expect(dragCarriesImageFile(dragEvent("dragover", [IMAGE_ITEM]))).toBe(true);
    });

    it("a non-image file drag should be left to VS Code", () => {
        expect(dragCarriesImageFile(dragEvent("dragover", [TEXT_FILE_ITEM]))).toBe(false);
    });

    it("dragged text (kind string, not file) should not be claimed", () => {
        const items = [{ kind: "string", type: "text/plain" }];
        expect(dragCarriesImageFile(dragEvent("dragover", items))).toBe(false);
    });

    it("a drag with no dataTransfer should not be claimed", () => {
        const bare = new Event("dragover") as DragEvent;
        expect(dragCarriesImageFile(bare)).toBe(false);
    });
});

describe("dragLeftDocument", () => {
    // The measured Chromium behavior these encode: an internal crossing
    // carries the entered element as relatedTarget and in-viewport
    // coordinates; a departure carries neither.
    it("a crossing into a sibling element should NOT read as a departure", () => {
        const sibling = document.createElement("div");
        const event = dragEvent("dragleave", [IMAGE_ITEM], {
            x: 220, y: 120, relatedTarget: sibling,
        });
        expect(dragLeftDocument(event)).toBe(false);
    });

    it("a null relatedTarget should read as a departure", () => {
        const event = dragEvent("dragleave", [IMAGE_ITEM], { x: 220, y: 120 });
        expect(dragLeftDocument(event)).toBe(true);
    });

    it("coordinates on the viewport edge should read as a departure", () => {
        const sibling = document.createElement("div");
        const edge = dragEvent("dragleave", [IMAGE_ITEM], {
            x: 0, y: 300, relatedTarget: sibling,
        });
        expect(dragLeftDocument(edge)).toBe(true);
        const past = dragEvent("dragleave", [IMAGE_ITEM], {
            x: 400, y: window.innerHeight, relatedTarget: sibling,
        });
        expect(dragLeftDocument(past)).toBe(true);
    });
});

describe("initImageFileDrop claim", () => {
    it("an image dragenter should be defaultPrevented (so a drop can fire here at all)", () => {
        wire();
        const event = dragEvent("dragenter", [IMAGE_ITEM]);
        document.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
    });

    it("a non-image dragenter should pass through untouched to the host", () => {
        wire();
        const event = dragEvent("dragenter", [TEXT_FILE_ITEM]);
        document.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(false);
    });

    it("an image dragover should be claimed and ask for a copy cursor", () => {
        wire();
        const event = dragEvent("dragover", [IMAGE_ITEM]);
        document.dispatchEvent(event);
        expect(event.defaultPrevented).toBe(true);
        expect(event.dataTransfer?.dropEffect).toBe("copy");
    });

    it("a drag that never resolves a target should report no aim", () => {
        // getView is null here, so nothing aims — handleDrop then falls back
        // to the inline position under the pointer.
        wire();
        document.dispatchEvent(dragEvent("dragover", [IMAGE_ITEM]));
        expect(aimedDropPos()).toBeNull();
    });
});
