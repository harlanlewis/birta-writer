/**
 * webview/firstFrame.ts — something correct on screen before the model is
 * built (MAR-428).
 *
 * Open on a large document is bound by the model: `create` parses the whole
 * text and builds the whole ProseMirror tree before the view exists, and the
 * reader looks at nothing for all of it. This paints a read-only render of the
 * first screen's worth of blocks in the editor's own markup a few frames after
 * the document arrives, then the live editor mounts behind it and the frame is
 * removed in the same task the editor's DOM lands, so there is one paint with
 * the frame and the next with the editor, and nothing in between.
 *
 * Three decisions, and the reason for each:
 *
 * - The frame is the editor's own markup: the prefix is parsed by the real
 *   parser and rendered through ProseMirror's `DOMSerializer` with the
 *   editor's own schema, so headings, paragraphs and lists carry the classes
 *   and structure the stylesheet already targets. What it lacks is NodeViews
 *   (a table's chrome, a code block's toolbar), which is cosmetic for the
 *   second it is on screen. The parser and schema come from a throwaway
 *   editor built from the format's presets alone, on a detached root, with an
 *   empty document; its cost is the plugin stack and nothing proportional to
 *   the document, and `pnpm perf huge-outline` reads it as the `frame` span.
 *
 * - The prefix ends at a boundary the block segmenter has proven safe
 *   (utils/blockSegmenter.ts), so the frame never shows half a construct. A
 *   text with no safe cut in its first screens, or below the size where the
 *   model build is felt at all, gets no frame and opens exactly as before.
 *
 * - Keystrokes during the window are kept, not dropped. The frame carries a
 *   focused, invisible capture field; whatever the user types into it is
 *   replayed into the live editor at the caret's opening position the moment
 *   the swap happens. Those are real key events, so they lift the editor's
 *   interaction flag the way any keystroke does, and the replayed text
 *   reaches the save pipeline like typed text. Formatting chords pressed
 *   before the editor exists have nothing to act on and are not replayed.
 */
import { Editor, defaultValueCtx, parserCtx, rootCtx, schemaCtx } from "@milkdown/core";
import { markUserInteracted } from "./editor";
import type { FormatModule } from "./format/types";
import { mark, measure } from "./perf";
import {
    DOMSerializer,
    Selection,
    TextSelection,
    splitBlock,
    type EditorView,
    type Node as ProseNode,
} from "./pm";
import { segmentBlocks } from "./utils/blockSegmenter";
import "./firstFrame.css";

/**
 * Below this many characters the model builds faster than the frame would
 * be worth: `pnpm perf large` (about two thirds of this) opens in a fraction
 * of a second, and a frame there would cost a paint to save nothing a reader
 * can feel. Above it, every open pays one throwaway plugin stack and one
 * frame's wait to show the first screen while the model builds.
 */
export const FIRST_FRAME_MIN_CHARS = 150_000;

/** The frame holds at least this many lines, a generous screen. */
export const FIRST_FRAME_MIN_LINES = 80;

/** And never more than this many: past it the frame is its own model build. */
export const FIRST_FRAME_MAX_LINES = 400;

/**
 * The text the frame renders: the first safely cut chunk of at least
 * `FIRST_FRAME_MIN_LINES`, or null when the document is small, the format has
 * no segmenter, or no safe cut falls inside `FIRST_FRAME_MAX_LINES`.
 */
export function firstFramePrefix(markdown: string, format: FormatModule): string | null {
    if (markdown.length < FIRST_FRAME_MIN_CHARS) return null;
    const cuts = format.findSafeCuts;
    if (!cuts) return null;
    const chunks = segmentBlocks(markdown, FIRST_FRAME_MIN_LINES, cuts);
    if (chunks.length < 2) return null;
    const first = chunks[0];
    if (first.endLine > FIRST_FRAME_MAX_LINES) return null;
    return first.text;
}

/**
 * Render `prefix` to the editor's own markup, through a throwaway editor
 * built from the format's presets. Exported for the unit test; the runtime
 * path is `paintFirstFrame`.
 */
export async function renderPrefix(prefix: string, format: FormatModule): Promise<HTMLElement | DocumentFragment | null> {
    let builder = Editor.make().config((ctx) => {
        ctx.set(rootCtx, document.createElement("div"));
        ctx.set(defaultValueCtx, "");
        format.configureSerialization(ctx);
    });
    for (const preset of format.presets) builder = builder.use(preset);
    const throwaway = await builder.create();
    try {
        const doc = throwaway.action((ctx) => ctx.get(parserCtx)(prefix)) as ProseNode | null;
        if (!doc) return null;
        const schema = throwaway.action((ctx) => ctx.get(schemaCtx));
        return DOMSerializer.fromSchema(schema).serializeFragment(doc.content);
    } finally {
        await throwaway.destroy();
    }
}

/** A frame on screen: dispose it to take it down and collect what was typed. */
export interface FirstFrame {
    readonly element: HTMLElement;
    /**
     * Remove the frame and return the text typed while it was up, and whether
     * its capture field still held focus. When it did, the caller focuses the
     * live view at once: a key pressed DURING the model build is queued behind
     * that long task and targets whatever is focused when it finally
     * dispatches, which must be the editor and not the body the removed field
     * leaves focus on.
     */
    dispose(): { typed: string; hadFocus: boolean };
}

/**
 * Paint the first screen into `container` and resolve once the browser has
 * had a frame to show it, or resolve null at once when no frame is due.
 */
export async function paintFirstFrame(
    container: HTMLElement,
    markdown: string,
    format: FormatModule,
): Promise<FirstFrame | null> {
    const prefix = firstFramePrefix(markdown, format);
    if (prefix === null) return null;
    mark("frame-start");
    const content = await renderPrefix(prefix, format);
    if (!content) return null;

    const frame = document.createElement("div");
    frame.className = "milkdown birta-first-frame";
    const body = document.createElement("div");
    body.className = "editor ProseMirror";
    body.setAttribute("contenteditable", "false");
    body.setAttribute("aria-busy", "true");
    body.appendChild(content);
    const sink = document.createElement("textarea");
    sink.className = "birta-first-frame-sink";
    sink.setAttribute("aria-label", "Loading editor");
    frame.append(body, sink);
    container.appendChild(frame);
    sink.focus({ preventScroll: true });

    // One animation frame, then a task: the frame's callback runs before that
    // frame paints, and the timeout runs after it has, so the model build
    // that follows starts on a screen that already shows the prefix.
    await new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
    mark("frame-painted");
    measure("frame", "frame-start", "frame-painted");

    return {
        element: frame,
        dispose() {
            const typed = sink.value;
            const hadFocus = document.activeElement === sink;
            frame.remove();
            return { typed, hadFocus };
        },
    };
}

/**
 * Type `text` into the live view at the caret's opening position: each
 * newline the user pressed splits a block, everything else is inserted as
 * text. The opening selection is made a text selection first, because a
 * document that opens on a selectable atom (a leading rule) opens with a node
 * selection, and inserting text over one replaces the node; a document with no
 * textblock at all gets a paragraph to type into. The interaction flag is
 * lifted before the first transaction, so the replayed text dirties the
 * document the way typed text does (editor.ts, `markUserInteracted`).
 */
export function replayTypedText(view: EditorView, text: string): void {
    if (!(view.state.selection instanceof TextSelection)) {
        const { doc, schema } = view.state;
        const first = Selection.findFrom(doc.resolve(0), 1, true);
        if (first) {
            view.dispatch(view.state.tr.setSelection(first));
        } else {
            const tr = view.state.tr.insert(doc.content.size, schema.nodes.paragraph.create());
            view.dispatch(tr.setSelection(TextSelection.create(tr.doc, doc.content.size + 1)));
        }
    }
    markUserInteracted();
    const parts = text.split("\n");
    parts.forEach((part, i) => {
        if (i > 0) splitBlock(view.state, view.dispatch);
        if (part) view.dispatch(view.state.tr.insertText(part));
    });
}
