/**
 * Mermaid code-block render pipeline (MAR-202/203/204/205), driving the REAL
 * code-block NodeView with a mocked Mermaid module: off-screen measurement
 * host, latest-wins render scheduling, theme invalidation, language-flip pane
 * switching, and the fit-to-view cap. The geometry corruption itself needs
 * real layout and is pinned by e2e/mermaidRender.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Editor, rootCtx, defaultValueCtx, editorViewCtx } from "@milkdown/core";
import { commonmark } from "@milkdown/preset-commonmark";
import { gfmFidelity } from "../serialization";
import type { EditorView } from "../pm";
import type { Node as PMNode } from "../pm";

const mermaidMock = vi.hoisted(() => {
    const state = {
        /** One entry per mermaid.render call, with the host facts AT call time. */
        calls: [] as { code: string; hostInBody: boolean; hostInNodeView: boolean; hostHidden: boolean }[],
        /** When set, render() stalls on this promise (simulates a slow render). */
        gate: null as Promise<void> | null,
    };
    const mermaid = {
        initialize: (): void => {},
        render: async (_id: string, code: string, host?: Element) => {
            const el = host as HTMLElement | undefined;
            state.calls.push({
                code,
                hostInBody: !!el && document.body.contains(el),
                hostInNodeView: !!el && !!el.closest(".code-block-wrapper"),
                hostHidden: !!el && el.style.visibility === "hidden",
            });
            if (state.gate) await state.gate;
            return { svg: `<svg viewBox="0 0 300 150"><text>${code}</text></svg>` };
        },
    };
    return { state, mermaid };
});

vi.mock("@/utils/mermaidLoader", () => ({
    loadMermaid: () =>
        Promise.resolve(mermaidMock.mermaid as unknown as typeof import("mermaid")["default"]),
}));

import { createCodeBlockView, setMermaidThemeMode } from "../components/codeBlock";

type CodeBlockNodeView = ReturnType<typeof createCodeBlockView>;

let editors: Editor[] = [];
let nodeViews: CodeBlockNodeView[] = [];

async function makeCodeBlockView(
    md: string,
): Promise<{ nv: CodeBlockNodeView; view: EditorView; getPos: () => number }> {
    const root = document.createElement("div");
    document.body.appendChild(root);
    const editor = await Editor.make()
        .config((ctx) => {
            ctx.set(rootCtx, root);
            ctx.set(defaultValueCtx, md);
        })
        .use(commonmark)
        .use(gfmFidelity)
        .create();
    editors.push(editor);

    let view!: EditorView;
    let node: PMNode | null = null;
    let pos = -1;
    editor.action((ctx) => {
        view = ctx.get(editorViewCtx);
        view.state.doc.descendants((n, p) => {
            if (n.type.name === "code_block") { node = n; pos = p; return false; }
            return true;
        });
    });
    expect(node).not.toBeNull();
    const nv = createCodeBlockView(node!, view, () => pos);
    nodeViews.push(nv);
    // Attach like ProseMirror would, so document.body.contains() distinctions
    // between the NodeView DOM and the off-screen host are meaningful.
    document.body.appendChild(nv.dom);
    return { nv, view, getPos: () => pos };
}

const wait = (ms = 0): Promise<void> => new Promise((r) => setTimeout(r, ms));

const renderedCodes = (): string[] => mermaidMock.state.calls.map((c) => c.code);

/** Replace the code block's full text content and feed the node to update(). */
function replaceCode(
    nv: CodeBlockNodeView, view: EditorView, pos: number, newCode: string,
): void {
    const n = view.state.doc.nodeAt(pos)!;
    view.dispatch(
        view.state.tr.replaceWith(pos + 1, pos + n.nodeSize - 1, view.state.schema.text(newCode)),
    );
    nv.update(view.state.doc.nodeAt(pos)!);
}

const toggleBtn = (nv: CodeBlockNodeView): HTMLElement =>
    nv.dom.querySelector<HTMLElement>(".code-view-toggle-btn")!;

const clickToggle = (nv: CodeBlockNodeView): void => {
    toggleBtn(nv).dispatchEvent(new MouseEvent("mousedown", { bubbles: true }));
};

describe("mermaid code-block rendering", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
        document.body.className = "";
        delete window.__i18n;
        mermaidMock.state.calls = [];
        mermaidMock.state.gate = null;
    });
    afterEach(async () => {
        // Destroy NodeViews first: they deregister from the module-level
        // mermaid instance registry, so a later test's theme change can't
        // re-render this test's diagrams and pollute its call log.
        for (const nv of nodeViews) nv.destroy();
        nodeViews = [];
        for (const e of editors) { await e.destroy(); }
        editors = [];
        setMermaidThemeMode("light"); // the module's seeded default
    });

    it("rendering should happen in an off-screen body host, never inside the NodeView (MAR-202)", async () => {
        await makeCodeBlockView("```mermaid\ngraph TD; A-->B\n```\n");
        await wait(20); // mount auto-preview defers a macrotask
        expect(mermaidMock.state.calls.length).toBeGreaterThan(0);
        for (const call of mermaidMock.state.calls) {
            expect(call.hostInBody).toBe(true);
            // The corruption root cause: mermaid measuring inside the
            // pan/zoom-transformed svgContainer. The host must be detached
            // from the NodeView entirely.
            expect(call.hostInNodeView).toBe(false);
            expect(call.hostHidden).toBe(true);
        }
        // The host is removed once rendering settles.
        await wait(0);
        expect(document.body.querySelector("div[style*='-10000px']")).toBeNull();
    });

    it("a render requested during an in-flight render should run afterwards with the newest code (MAR-203)", async () => {
        const { nv, view, getPos } = await makeCodeBlockView("```mermaid\ngraph TD; A\n```\n");
        await wait(20);
        expect(renderedCodes()).toEqual(["graph TD; A"]);

        // Stall the next render, then request B via toggle→edit→toggle (the
        // user's rapid edit loop; re-entering preview renders synchronously).
        let release!: () => void;
        mermaidMock.state.gate = new Promise<void>((r) => { release = r; });
        clickToggle(nv); // to code mode
        replaceCode(nv, view, getPos(), "graph TD; B");
        clickToggle(nv); // back to preview → render B starts, stalls on the gate
        await wait(0);
        expect(renderedCodes()).toEqual(["graph TD; A", "graph TD; B"]);

        // While B is in flight, request C the same way. The old pipeline
        // silently dropped this; now it parks as the pending render.
        clickToggle(nv);
        replaceCode(nv, view, getPos(), "graph TD; C");
        clickToggle(nv);
        await wait(0);
        expect(renderedCodes()).toEqual(["graph TD; A", "graph TD; B"]); // C parked, not dropped

        mermaidMock.state.gate = null;
        release();
        await wait(20);
        expect(renderedCodes()).toEqual(["graph TD; A", "graph TD; B", "graph TD; C"]);
        expect(nv.dom.querySelector(".mermaid-svg-container svg")?.textContent).toBe("graph TD; C");
    });

    it("a mermaid theme change should actually re-render an already-rendered diagram (MAR-203)", async () => {
        await makeCodeBlockView("```mermaid\ngraph TD; A-->B\n```\n");
        await wait(20);
        expect(renderedCodes()).toEqual(["graph TD; A-->B"]);

        // Previously a no-op: the memo guard rejected the same-code re-render.
        setMermaidThemeMode("dark");
        await wait(20);
        expect(renderedCodes()).toEqual(["graph TD; A-->B", "graph TD; A-->B"]);
        expect(document.body.classList.contains("mermaid-canvas-dark")).toBe(true);
    });

    it("flipping a previewed block's language calc→mermaid should switch panes and render (MAR-204)", async () => {
        const { nv, view, getPos } = await makeCodeBlockView("```calc\n2 + 3\n```\n");
        await wait(20);
        const calcPane = nv.dom.querySelector<HTMLElement>(".calc-preview")!;
        const mermaidPane = nv.dom.querySelector<HTMLElement>(".mermaid-preview")!;
        expect(calcPane.style.display).toBe("flex");
        expect(mermaidPane.style.display).toBe("none");

        const pos = getPos();
        view.dispatch(view.state.tr.setNodeMarkup(pos, null, { language: "mermaid" }));
        nv.update(view.state.doc.nodeAt(pos)!);
        await wait(20);

        expect(calcPane.style.display).toBe("none");
        expect(mermaidPane.style.display).toBe("flex");
        expect(renderedCodes()).toEqual(["2 + 3"]);
    });

    it("fit-to-view should cap the zoom at natural size (100%) (MAR-205)", async () => {
        const { nv } = await makeCodeBlockView("```mermaid\ngraph TD; A\n```\n");
        const preview = nv.dom.querySelector<HTMLElement>(".mermaid-preview")!;
        // A container far larger than the mock SVG's 300×150 viewBox: the old
        // fit blew the diagram up (scale 3.2); the cap holds it at 1.0.
        Object.defineProperty(preview, "clientWidth", { value: 1000, configurable: true });
        Object.defineProperty(preview, "clientHeight", { value: 800, configurable: true });
        await wait(50); // mount render + fitToView's requestAnimationFrame
        const svgContainer = nv.dom.querySelector<HTMLElement>(".mermaid-svg-container")!;
        expect(svgContainer.style.transform).toBe("translate(0px, 0px) scale(1)");
    });
});
