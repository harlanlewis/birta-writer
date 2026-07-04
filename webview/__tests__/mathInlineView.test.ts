/**
 * Unit tests for the inline math NodeView (components/math): clicking opens the
 * edit popover; Enter/blur commit through the document, Escape cancels, and an
 * emptied formula deletes the node. KaTeX renders through jsdom.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { createMathInlineView } from "../components/math";

/** A ProseMirror transaction stub recording the mutation calls it receives. */
function makeTr() {
    const calls: Array<{ op: string; args: unknown[] }> = [];
    const tr = {
        calls,
        setNodeMarkup(...args: unknown[]) {
            calls.push({ op: "setNodeMarkup", args });
            return tr;
        },
        delete(...args: unknown[]) {
            calls.push({ op: "delete", args });
            return tr;
        },
    };
    return tr;
}

function makeView(nodeValue: string) {
    const tr = makeTr();
    const dispatched: unknown[] = [];
    const view = {
        state: {
            get tr() {
                return tr;
            },
        },
        dispatch: vi.fn((t: unknown) => dispatched.push(t)),
        focus: vi.fn(),
    };
    const node = {
        type: { name: "math_inline" },
        attrs: { value: nodeValue },
        nodeSize: 1,
    };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return { view: view as any, node: node as any, tr, dispatched };
}

function getPopoverInput(): HTMLInputElement | null {
    return document.querySelector<HTMLInputElement>(".math-popover-input");
}

describe("inline math NodeView popover", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
    });

    it("clicking the formula should open a popover pre-filled with its value", () => {
        const { view, node } = makeView("a^2");
        const nv = createMathInlineView(node, view, () => 5);
        document.body.appendChild(nv.dom);

        nv.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        const input = getPopoverInput();
        expect(input).not.toBeNull();
        expect(input!.value).toBe("a^2");
    });

    it("pressing Enter should commit the edited value via setNodeMarkup", () => {
        const { view, node, tr, dispatched } = makeView("a^2");
        const nv = createMathInlineView(node, view, () => 5);
        document.body.appendChild(nv.dom);
        nv.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        const input = getPopoverInput()!;
        input.value = "b^2";
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

        const markup = tr.calls.find((c) => c.op === "setNodeMarkup");
        expect(markup).toBeDefined();
        expect((markup!.args[2] as { value: string }).value).toBe("b^2");
        expect(view.dispatch).toHaveBeenCalledOnce();
        expect(dispatched).toHaveLength(1);
        // Popover is torn down after commit.
        expect(getPopoverInput()).toBeNull();
    });

    it("committing an empty value should delete the node", () => {
        const { view, node, tr } = makeView("a^2");
        const nv = createMathInlineView(node, view, () => 5);
        document.body.appendChild(nv.dom);
        nv.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        const input = getPopoverInput()!;
        input.value = "   ";
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

        expect(tr.calls.some((c) => c.op === "delete")).toBe(true);
        expect(tr.calls.some((c) => c.op === "setNodeMarkup")).toBe(false);
    });

    it("pressing Escape should cancel without dispatching a change", () => {
        const { view, node } = makeView("a^2");
        const nv = createMathInlineView(node, view, () => 5);
        document.body.appendChild(nv.dom);
        nv.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        const input = getPopoverInput()!;
        input.value = "changed";
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));

        expect(view.dispatch).not.toHaveBeenCalled();
        expect(getPopoverInput()).toBeNull();
    });

    it("an unchanged commit should not dispatch a transaction", () => {
        const { view, node } = makeView("a^2");
        const nv = createMathInlineView(node, view, () => 5);
        document.body.appendChild(nv.dom);
        nv.dom.dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));

        const input = getPopoverInput()!;
        // value unchanged
        input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));

        expect(view.dispatch).not.toHaveBeenCalled();
    });
});
