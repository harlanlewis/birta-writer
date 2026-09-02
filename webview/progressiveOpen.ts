/**
 * webview/progressiveOpen.ts — the editor mounts on the first screen and the
 * rest of the document arrives while the user reads it (MAR-429).
 *
 * `create` builds the whole model before the view exists, so open is
 * proportional to the document however the DOM is handled. Above a size
 * where that is felt, the text is cut at boundaries the block segmenter has
 * proven safe (utils/blockSegmenter.ts), the editor is created on the first
 * chunk alone, and every later chunk is parsed on its own and appended to the
 * live document as one transaction, on idle slices, each yielding a frame.
 * The segmenter's contract is what makes the pieces the whole: parsing a
 * chunk gives exactly the blocks it contributes to the whole document, so the
 * document at the end of the stream is the document a single parse gives,
 * node for node, and `progressiveOpen.test.ts` holds that over the corpus.
 *
 * This file is the plan and the schedule. What a chunk does to the document
 * (parse, seed, dispatch) and what the pipeline does while the document is
 * partial (nothing that could serialize it) are `editor.ts`'s, beside the
 * state they gate on.
 */
import { segmentBlocks } from "./utils/blockSegmenter";
import { requestIdle } from "./utils/idle";
import type { FormatModule } from "./format/types";

/**
 * Below this many characters the whole model builds faster than the stream
 * is worth. The same floor as the static first frame's, because it is the
 * same judgement about the same cost.
 */
export const PROGRESSIVE_OPEN_MIN_CHARS = 150_000;

/** The first chunk holds at least this many lines, a generous screen, and never more than the max. */
export const FIRST_SCREEN_MIN_LINES = 80;
export const FIRST_SCREEN_MAX_LINES = 400;

/**
 * Every later chunk holds at least this many lines. Smaller chunks yield
 * more often and cost more per line: each append is a transaction every
 * plugin sees, and the ones that read the whole document on a structural
 * change pay it once per chunk.
 */
export const STREAM_CHUNK_MIN_LINES = 400;

/**
 * How long an idle slice may be deferred before the next chunk runs anyway.
 * Idle time is the preference, not the condition: a page that is never idle
 * (a user typing steadily) still has to finish loading its document.
 */
const STREAM_YIELD_TIMEOUT_MS = 200;

export interface ProgressivePlan {
    /** The text the editor is created on. */
    readonly first: string;
    /** The rest, in order; `first` followed by these is the whole text. */
    readonly rest: readonly string[];
}

/**
 * How to open `markdown` progressively, or null: below the floor, for a
 * format with no proven cut points, or when no safe cut falls inside the
 * first screens, the document opens whole exactly as it always has.
 */
export function planProgressiveOpen(
    markdown: string,
    format: FormatModule,
    minChars: number = PROGRESSIVE_OPEN_MIN_CHARS,
): ProgressivePlan | null {
    if (markdown.length < minChars) return null;
    const cuts = format.findSafeCuts;
    if (!cuts) return null;
    const fine = segmentBlocks(markdown, FIRST_SCREEN_MIN_LINES, cuts);
    if (fine.length < 2) return null;
    const first = fine[0];
    if (first.endLine > FIRST_SCREEN_MAX_LINES) return null;
    // Consecutive chunks joined are still text between two safe cuts, so
    // coalescing keeps the contract while making the appends fewer.
    const rest: string[] = [];
    let text = "";
    let lines = 0;
    for (const chunk of fine.slice(1)) {
        text += chunk.text;
        lines += chunk.endLine - chunk.startLine;
        if (lines >= STREAM_CHUNK_MIN_LINES) {
            rest.push(text);
            text = "";
            lines = 0;
        }
    }
    if (text) rest.push(text);
    return { first: first.text, rest };
}

export interface StreamHandle {
    /** Stop before the next chunk; `done` resolves false. */
    cancel(): void;
    /** True once every chunk was appended, false if cancelled. */
    readonly done: Promise<boolean>;
}

/**
 * Append `chunks` one per idle slice. `append` is synchronous and owns what
 * an append means; a throw inside it ends the stream and rejects `done`,
 * which the caller turns into whatever a document that cannot finish loading
 * should become, and never into a document that reads as complete.
 */
export function streamChunks(chunks: readonly string[], append: (text: string, index: number) => void): StreamHandle {
    let cancelled = false;
    let pending: { cancel: () => void } | null = null;
    let finish: (complete: boolean) => void = () => {};
    let fail: (reason: unknown) => void = () => {};
    const done = new Promise<boolean>((resolve, reject) => {
        finish = resolve;
        fail = reject;
    });
    let index = 0;
    const step = (): void => {
        pending = null;
        if (cancelled) return;
        if (index >= chunks.length) {
            finish(true);
            return;
        }
        try {
            append(chunks[index], index);
        } catch (e) {
            cancelled = true;
            fail(e);
            return;
        }
        index++;
        pending = requestIdle(step, STREAM_YIELD_TIMEOUT_MS);
    };
    pending = requestIdle(step, STREAM_YIELD_TIMEOUT_MS);
    return {
        cancel() {
            if (cancelled) return;
            cancelled = true;
            pending?.cancel();
            pending = null;
            finish(false);
        },
        done,
    };
}
