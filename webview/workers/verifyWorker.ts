/**
 * webview/workers/verifyWorker.ts — a sync's whole save decision, made off
 * the interaction thread (MAR-430 tier B0, MAR-432 tier B1).
 *
 * A sync asks one question: given the live document and the bytes currently
 * on disk, what should be written. Answering it is a whole-document
 * serialize, a minimal-diff merge against the saved text, a fingerprint of
 * the live document, and one or two verifying reparses. All of it runs here,
 * for a document large enough that the page can feel it; the page hands over
 * `doc.toJSON()` and gets the bytes back.
 *
 * It is the same decision function the page runs below that size and on
 * every save flush (`utils/verifiedMerge.ts`'s `mergeVerified`), called with
 * the same profile and the same presets, so there is one implementation of
 * which bytes reach the file and the worker only moves where it ran.
 *
 * The parser and serializer are built headless (`utils/headlessParser.ts`)
 * from the markdown format's parse half, so they are the page's own pipeline
 * rather than a second one; `headlessParser.test.ts` holds both equal to the
 * live editor's over the corpus.
 *
 * It is a classic worker, built self-contained by `verifyWorkerPlugin` in
 * esbuild.mjs and started from a Blob URL (`utils/verifyOracle.ts` says why),
 * so it must import nothing that needs a document at load time, and nothing
 * lazy: a Blob-origin worker has no base URL to resolve a chunk against.
 * That is also why the profile comes from `utils/minimalDiff.ts` rather than
 * from `format/markdown`, whose index pulls in NodeViews; the two are the
 * same object, which `headlessParser.test.ts` asserts.
 *
 * Markdown only. The MDX format loads lazily and brings its own presets;
 * a document in it keeps the main-thread path, which the page decides.
 */
import { markdownParse } from "../format/markdown/parse";
import { createHeadlessParser, type HeadlessParser } from "../utils/headlessParser";
import { markdownProfile } from "../utils/minimalDiff";
import { mergeVerified } from "../utils/verifiedMerge";
import type { VerifyReply, VerifyRequest } from "./protocol";

/** The worker scope, typed by what this file uses of it; the DOM lib's `Window` is not it. */
const scope = globalThis as unknown as {
    addEventListener(type: "message", handler: (event: { data: VerifyRequest }) => void): void;
    postMessage(reply: VerifyReply): void;
};

let parserPromise: Promise<HeadlessParser> | null = null;
const parser = (): Promise<HeadlessParser> => (parserPromise ??= createHeadlessParser(markdownParse));

async function handle(request: VerifyRequest): Promise<void> {
    try {
        const p = await parser();
        if (request.type === "warm") {
            // A parse or serialize throw here is a property of the text, not
            // of the worker; the real question is answered per document below.
            try { p.serialize(p.parse(request.text)!); } catch { /* the text's own failure */ }
            scope.postMessage({ type: "warmed" });
            return;
        }
        const live = p.schema.nodeFromJSON(request.doc);
        let reparses = 0;
        const { text, canonical } = mergeVerified(
            request.saved,
            p.serialize(live),
            markdownProfile,
            request.protection,
            live,
            (candidate) => { reparses++; return p.parse(candidate); },
        );
        scope.postMessage({ type: "merged", id: request.id, text, canonical, reparses });
    } catch (e) {
        scope.postMessage({
            type: "failed",
            id: request.type === "merge" ? request.id : null,
            reason: e instanceof Error ? e.message : String(e),
        });
    }
}

// Answered in arrival order: each message is its own task, and a handler
// waiting on the parser's build continues in the order it began waiting.
scope.addEventListener("message", (event) => { void handle(event.data); });
