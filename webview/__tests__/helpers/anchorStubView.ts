/**
 * A view whose layout answers come from a script, for testing anything built on
 * withScrollAnchor (utils/scrollAnchor.ts). jsdom has no layout engine, so a
 * scripted view is the only way to exercise the anchoring math at all:
 * coordsAtPos hands back the next `topsByCall` entry per call, and an anchored
 * mutation reads one top before it and one after.
 */
import type { EditorView } from "../../pm";

export interface AnchorStubOptions {
    posAtCoords?: (() => { pos: number } | null) | (() => never);
    /** Line tops handed to successive coordsAtPos calls. */
    topsByCall?: number[];
    /** coordsAtPos returns FLAT rects (hidden content) — the embed case. */
    degenerateCoords?: boolean;
    /** nodeDOM block-box tops consumed when coords are degenerate. */
    blockTopsByCall?: number[];
    isDestroyed?: boolean;
}

export function anchorStubView(opts: AnchorStubOptions = {}): EditorView {
    const tops = [...(opts.topsByCall ?? [])];
    const blockTops = [...(opts.blockTopsByCall ?? [])];
    const blockDom = document.createElement("div");
    blockDom.getBoundingClientRect = () => {
        const top = blockTops.shift();
        if (top === undefined) {
            throw new Error("no block measurements");
        }
        return { top } as DOMRect;
    };
    return {
        isDestroyed: opts.isDestroyed ?? false,
        dom: {
            getBoundingClientRect: () => ({ left: 100, width: 800 }),
            contains: () => true,
        },
        posAtCoords: opts.posAtCoords ?? (() => ({ pos: 42 })),
        coordsAtPos: () => {
            const top = tops.shift();
            if (top === undefined) {
                throw new Error("no more measurements");
            }
            return opts.degenerateCoords ? { top, bottom: top } : { top, bottom: top + 16 };
        },
        state: {
            doc: {
                resolve: () => ({ depth: 1, before: () => 7 }),
            },
        },
        nodeDOM: () => blockDom,
    } as unknown as EditorView;
}
