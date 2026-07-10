/**
 * Unit tests for the inline math NodeView (components/math): the two-face DOM
 * (KaTeX render + source contentDOM), content-driven repaint, empty-formula
 * placeholder state, and mutation filtering (ProseMirror must see contentDOM
 * mutations, KaTeX churn is ignored). KaTeX renders through jsdom.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { createMathInlineView } from "../components/math";

/** A minimal PMNode stub: type identity (shared reference) + textContent. */
const MATH_TYPE = { name: "math_inline" };
function makeNode(text: string, type: object = MATH_TYPE) {
    return {
        type,
        textContent: text,
        content: { size: text.length },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any;
}

const flush = () => new Promise((r) => setTimeout(r, 0));

describe("inline math NodeView", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
    });

    it("the view should expose a render span and the source span as contentDOM", () => {
        const nv = createMathInlineView(makeNode("a^2"));
        expect(nv.dom.classList.contains("math-inline")).toBe(true);
        const render = nv.dom.querySelector(".math-inline-render") as HTMLElement;
        expect(render).not.toBeNull();
        // The render face is not editable; the source face is PM's contentDOM.
        expect(render.contentEditable).toBe("false");
        expect(nv.contentDOM.classList.contains("math-inline-src")).toBe(true);
        expect(nv.dom.contains(nv.contentDOM)).toBe(true);
    });

    it("a non-empty formula should render KaTeX output into the render span", async () => {
        const nv = createMathInlineView(makeNode("a^2"));
        await flush();
        const render = nv.dom.querySelector(".math-inline-render") as HTMLElement;
        // KaTeX output (or the raw-value fallback) lands in the render span only.
        expect(render.textContent).toContain("a");
        expect(nv.dom.classList.contains("math-inline--empty")).toBe(false);
    });

    it("an empty formula should mark the node empty (placeholder styling)", () => {
        const nv = createMathInlineView(makeNode(""));
        expect(nv.dom.classList.contains("math-inline--empty")).toBe(true);
    });

    it("update with changed content should repaint and clear/set the empty state", async () => {
        const nv = createMathInlineView(makeNode("a^2"));
        expect(nv.update(makeNode(""))).toBe(true);
        expect(nv.dom.classList.contains("math-inline--empty")).toBe(true);
        expect(nv.update(makeNode("b_1"))).toBe(true);
        await flush();
        expect(nv.dom.classList.contains("math-inline--empty")).toBe(false);
    });

    it("update with a different node type should return false", () => {
        const nv = createMathInlineView(makeNode("a^2"));
        expect(nv.update(makeNode("a^2", { name: "other" }))).toBe(false);
    });

    it("mutations in the source span should reach ProseMirror; render churn should not", () => {
        const nv = createMathInlineView(makeNode("a^2"));
        const render = nv.dom.querySelector(".math-inline-render") as HTMLElement;
        const srcMutation = { type: "characterData", target: nv.contentDOM } as unknown as MutationRecord;
        const renderMutation = { type: "childList", target: render } as unknown as MutationRecord;
        expect(nv.ignoreMutation(srcMutation)).toBe(false);
        expect(nv.ignoreMutation(renderMutation)).toBe(true);
        expect(nv.ignoreMutation({ type: "selection", target: render })).toBe(false);
    });

    it("selectNode/deselectNode should toggle the selected class", () => {
        const nv = createMathInlineView(makeNode("x"));
        nv.selectNode();
        expect(nv.dom.classList.contains("math-inline--selected")).toBe(true);
        nv.deselectNode();
        expect(nv.dom.classList.contains("math-inline--selected")).toBe(false);
    });
});
