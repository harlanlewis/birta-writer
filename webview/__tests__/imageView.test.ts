/**
 * imageView.test.ts — image NodeView: alt-text caption and path editing.
 *
 * The NodeView is exercised with lightweight fakes for the ProseMirror node
 * and view: dispatch/setNodeMarkup calls are recorded so tests can assert
 * what the UI committed to the document.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { createImageView, setImageUriMap } from "../components/imageView";

// ── Fakes ──────────────────────────────────────────────────
const imageType = { name: "image" };

function makeNode(attrs: Record<string, string>) {
    return { attrs, type: imageType, nodeSize: 1 } as never;
}

type MarkupCall = { pos: number; attrs: Record<string, string> };

function makeViewFake() {
    const markupCalls: MarkupCall[] = [];
    const makeTr = () => {
        const tr = {
            doc: {
                content: { size: 9999 },
                resolve: () => {
                    throw new Error("fake resolve");
                },
            },
            setNodeMarkup(pos: number, _t: null, attrs: Record<string, string>) {
                markupCalls.push({ pos, attrs });
                return tr;
            },
            setSelection: () => tr,
            delete: () => tr,
        };
        return tr;
    };
    const view = {
        focus: vi.fn(),
        dispatch: vi.fn(),
        get state() {
            return { tr: makeTr() };
        },
    };
    return { view: view as never, dispatch: view.dispatch, focus: view.focus, markupCalls };
}

// pos: null models a node whose getPos() returns undefined (detached node)
function create(attrs: Record<string, string>, pos: number | null = 5) {
    const fake = makeViewFake();
    const nodeView = createImageView(makeNode(attrs), fake.view, () => pos ?? undefined);
    return { ...fake, nodeView };
}

function caption(nv: { dom: HTMLElement }): HTMLInputElement {
    const el = nv.dom.querySelector<HTMLInputElement>(".image-caption");
    if (!el) throw new Error("caption input not found");
    return el;
}

beforeEach(() => {
    vi.clearAllMocks();
    setImageUriMap({});
});

afterEach(() => {
    vi.useRealTimers();
});

describe("imageView — alt-text caption", () => {
    it("an image with alt text should show the alt in a visible caption", () => {
        const { nodeView } = create({ src: "img/a.png", alt: "two cats" });

        const cap = caption(nodeView);
        expect(cap.value).toBe("two cats");
        expect(cap.classList.contains("image-caption--filled")).toBe(true);
    });

    it("an image without alt text should mark the caption as empty", () => {
        const { nodeView } = create({ src: "img/a.png", alt: "" });

        const cap = caption(nodeView);
        expect(cap.value).toBe("");
        expect(cap.classList.contains("image-caption--filled")).toBe(false);
    });

    it("blurring an edited caption should commit the new alt to the node", () => {
        const { nodeView, dispatch, markupCalls } = create({ src: "img/a.png", alt: "old alt" });

        const cap = caption(nodeView);
        cap.value = "new alt";
        cap.dispatchEvent(new FocusEvent("blur"));

        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(markupCalls).toEqual([{ pos: 5, attrs: { src: "img/a.png", alt: "new alt" } }]);
    });

    it("blurring an unchanged caption should not dispatch", () => {
        const { nodeView, dispatch } = create({ src: "img/a.png", alt: "same" });

        caption(nodeView).dispatchEvent(new FocusEvent("blur"));

        expect(dispatch).not.toHaveBeenCalled();
    });

    it("pressing Enter in the caption should commit and refocus the editor", () => {
        const { nodeView, dispatch, focus, markupCalls } = create({ src: "img/a.png", alt: "" });

        const cap = caption(nodeView);
        cap.value = "typed alt";
        cap.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));

        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(markupCalls[0].attrs["alt"]).toBe("typed alt");
        expect(focus).toHaveBeenCalled();
    });

    it("pressing Escape in the caption should revert without dispatching", () => {
        const { nodeView, dispatch } = create({ src: "img/a.png", alt: "original" });

        const cap = caption(nodeView);
        cap.value = "abandoned edit";
        cap.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));

        expect(cap.value).toBe("original");
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("a node update with new alt should refresh the caption", () => {
        const { nodeView } = create({ src: "img/a.png", alt: "before" });

        nodeView.update(makeNode({ src: "img/a.png", alt: "after" }));

        expect(caption(nodeView).value).toBe("after");
        expect(caption(nodeView).classList.contains("image-caption--filled")).toBe(true);
    });

    it("a caption edit on a node with no position should not dispatch", () => {
        const { nodeView, dispatch } = create({ src: "img/a.png", alt: "x" }, null);

        const cap = caption(nodeView);
        cap.value = "y";
        cap.dispatchEvent(new FocusEvent("blur"));

        expect(dispatch).not.toHaveBeenCalled();
        expect(cap.value).toBe("x");
    });

    it("the markdown title should surface as the image's native tooltip", () => {
        const { nodeView } = create({ src: "img/a.png", alt: "cats", title: "Optional title" });

        const img = nodeView.dom.querySelector<HTMLImageElement>("img.image-node");
        expect(img?.title).toBe("Optional title");
    });

    it("a node update should refresh the image tooltip from the title attr", () => {
        const { nodeView } = create({ src: "img/a.png", alt: "cats", title: "before" });

        nodeView.update(makeNode({ src: "img/a.png", alt: "cats", title: "after" }));

        const img = nodeView.dom.querySelector<HTMLImageElement>("img.image-node");
        expect(img?.title).toBe("after");
    });

    it("committing a caption edit should preserve the title attribute", () => {
        const { nodeView, markupCalls } = create({ src: "img/a.png", alt: "old", title: "kept" });

        const cap = caption(nodeView);
        cap.value = "new";
        cap.dispatchEvent(new FocusEvent("blur"));

        expect(markupCalls[0].attrs).toEqual({ src: "img/a.png", alt: "new", title: "kept" });
    });

    it("caption events should be kept from ProseMirror via stopEvent", () => {
        const { nodeView } = create({ src: "img/a.png", alt: "x" });

        const ev = new Event("keydown");
        Object.defineProperty(ev, "target", { value: caption(nodeView) });

        expect(nodeView.stopEvent(ev)).toBe(true);
    });
});

describe("imageView — path editing", () => {
    const CATS_URI = "https://file.vscode-cdn.net/ws/images/cats.jpeg";
    const OTHER_URI = "https://file.vscode-cdn.net/ws/images/other.png";

    beforeEach(() => {
        setImageUriMap({
            [CATS_URI]: "images/cats.jpeg",
            [OTHER_URI]: "images/other.png",
        });
    });

    function openPathEditor(nv: { dom: HTMLElement }): HTMLInputElement {
        const pencil = nv.dom.querySelector<HTMLButtonElement>('button[aria-label="Edit Image Path"]');
        if (!pencil) throw new Error("pencil button not found");
        pencil.dispatchEvent(new MouseEvent("mousedown", { cancelable: true }));
        const path = nv.dom.querySelector<HTMLInputElement>(".img-path-input");
        if (!path) throw new Error("path input not found");
        return path;
    }

    it("opening the path editor should show the relative path and no confirm buttons", () => {
        const { nodeView } = create({ src: CATS_URI, alt: "" });
        const buttonsBefore = nodeView.dom.querySelectorAll("button").length;

        const path = openPathEditor(nodeView);

        expect(path.value).toBe("images/cats.jpeg");
        // Apply-on-blur design: entering edit mode adds no ✓/✗ buttons
        expect(nodeView.dom.querySelectorAll("button").length).toBe(buttonsBefore);
    });

    it("blurring the path input should apply a mapped path to the node", () => {
        vi.useFakeTimers();
        const { nodeView, dispatch, markupCalls } = create({ src: CATS_URI, alt: "" });

        const path = openPathEditor(nodeView);
        path.value = "images/other.png";
        path.dispatchEvent(new FocusEvent("blur"));
        vi.advanceTimersByTime(200);

        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(markupCalls[0].attrs["src"]).toBe(OTHER_URI);
        // Edit mode closed: the input is removed from the toolbar
        expect(nodeView.dom.querySelector(".img-rename-input")).toBeNull();
    });

    it("blurring with an unchanged path should not dispatch", () => {
        vi.useFakeTimers();
        const { nodeView, dispatch } = create({ src: CATS_URI, alt: "" });

        const path = openPathEditor(nodeView);
        path.dispatchEvent(new FocusEvent("blur"));
        vi.advanceTimersByTime(200);

        expect(dispatch).not.toHaveBeenCalled();
        expect(nodeView.dom.querySelector(".img-rename-input")).toBeNull();
    });

    it("pressing Escape in the path input should cancel without dispatching", () => {
        const { nodeView, dispatch, focus } = create({ src: CATS_URI, alt: "" });

        const path = openPathEditor(nodeView);
        path.value = "images/other.png";
        path.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));

        expect(dispatch).not.toHaveBeenCalled();
        expect(nodeView.dom.querySelector(".img-rename-input")).toBeNull();
        expect(focus).toHaveBeenCalled();
    });

    it("the file-name chip should show the name, carry a pencil, and open the path editor", () => {
        const { nodeView } = create({ src: CATS_URI, alt: "" });

        const chip = nodeView.dom.querySelector<HTMLElement>(".img-tb-path");
        expect(chip?.querySelector(".img-tb-path-name")?.textContent).toBe("cats.jpeg");
        expect(chip?.querySelector(".img-tb-path-pencil svg")).not.toBeNull();
        chip?.dispatchEvent(new MouseEvent("mousedown", { cancelable: true }));

        expect(nodeView.dom.querySelector(".img-rename-input")).not.toBeNull();
    });

    it("a node update should refresh the file name in the chip", () => {
        const { nodeView } = create({ src: CATS_URI, alt: "" });

        nodeView.update(makeNode({ src: OTHER_URI, alt: "" }));

        expect(nodeView.dom.querySelector(".img-tb-path-name")?.textContent).toBe("other.png");
    });
});

describe("imageView — title row", () => {
    function titleRow(nv: { dom: HTMLElement }): HTMLInputElement {
        const el = nv.dom.querySelector<HTMLInputElement>(".img-tb-title");
        if (!el) throw new Error("title row not found");
        return el;
    }

    it("the toolbar should carry an always-present title row prefilled from the node", () => {
        const { nodeView } = create({ src: "img/a.png", alt: "", title: "Sleepy tabbies" });

        const row = titleRow(nodeView);
        expect(row.value).toBe("Sleepy tabbies");
        // Lives in the toolbar as its own row, not inside the path editor
        expect(row.closest(".image-toolbar")).not.toBeNull();
        expect(nodeView.dom.querySelector(".img-path-input")).toBeNull();
    });

    it("blurring an edited title should commit it and keep the other attrs", () => {
        const { nodeView, dispatch, markupCalls } = create({ src: "img/a.png", alt: "cats", title: "" });

        const row = titleRow(nodeView);
        row.value = "A new title";
        row.dispatchEvent(new FocusEvent("blur"));

        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(markupCalls[0].attrs).toEqual({ src: "img/a.png", alt: "cats", title: "A new title" });
    });

    it("clearing the title should commit an empty title", () => {
        const { nodeView, dispatch, markupCalls } = create({ src: "img/a.png", alt: "", title: "old title" });

        const row = titleRow(nodeView);
        row.value = "";
        row.dispatchEvent(new FocusEvent("blur"));

        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(markupCalls[0].attrs["title"]).toBe("");
    });

    it("blurring an unchanged title should not dispatch", () => {
        const { nodeView, dispatch } = create({ src: "img/a.png", alt: "", title: "same" });

        titleRow(nodeView).dispatchEvent(new FocusEvent("blur"));

        expect(dispatch).not.toHaveBeenCalled();
    });

    it("pressing Enter in the title row should commit and refocus the editor", () => {
        const { nodeView, dispatch, focus, markupCalls } = create({ src: "img/a.png", alt: "", title: "" });

        const row = titleRow(nodeView);
        row.value = "typed title";
        row.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", cancelable: true }));

        expect(dispatch).toHaveBeenCalledTimes(1);
        expect(markupCalls[0].attrs["title"]).toBe("typed title");
        expect(focus).toHaveBeenCalled();
    });

    it("pressing Escape in the title row should revert without dispatching", () => {
        const { nodeView, dispatch } = create({ src: "img/a.png", alt: "", title: "keep me" });

        const row = titleRow(nodeView);
        row.value = "discard this";
        row.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", cancelable: true }));

        expect(row.value).toBe("keep me");
        expect(dispatch).not.toHaveBeenCalled();
    });

    it("a node update should refresh the title row", () => {
        const { nodeView } = create({ src: "img/a.png", alt: "", title: "before" });

        nodeView.update(makeNode({ src: "img/a.png", alt: "", title: "after" }));

        expect(titleRow(nodeView).value).toBe("after");
    });
});
