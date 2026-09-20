/**
 * webview/utils/verifyOracle.ts — the page's handle on the sync worker
 * (MAR-430 tier B0, MAR-432 tier B1).
 *
 * A `VerifyOracle` makes the save pipeline's whole decision — serialize,
 * merge, verify — somewhere other than the interaction thread. This one is a
 * worker holding the page's own parser and serializer
 * (workers/verifyWorker.ts); `editor.ts` asks it only for a document large
 * enough that the work is felt, and falls back to the main-thread
 * `mergeVerified` the moment it cannot answer, so the oracle is where the
 * work runs and never what the answer is.
 *
 * WHY A BLOB URL. Both hosts serve the bundle from an origin that is not the
 * page's own: inside VS Code the page is `vscode-webview:` and its resources
 * are a `vscode-resource` host, and a worker script must be same-origin, so
 * `new Worker(<bundle url>)` is refused before any policy is consulted. A
 * Blob URL made in the page is the page's origin. The worker's source
 * therefore ships as a string in a lazy chunk (`workers/verifyWorkerSource`,
 * replaced at build time) rather than as a file, the chunk loads through the
 * `script-src` grant the bundle's other chunks already use, and the one new
 * CSP grant each host declares is `worker-src blob:`
 * (`shared/__tests__/workerCsp.test.ts` holds both hosts and the harness).
 *
 * WHAT CAN GO WRONG, AND WHAT HAPPENS. The chunk fails to load, the runtime
 * has no `Worker`, a policy refuses the Blob, the worker's parser fails to
 * build, the document refuses to clone, or the worker stops answering: every
 * one rejects the questions in flight and retires the oracle for the
 * session, and every caller then makes the same decision on the main thread.
 * A worker that answers late is the case the caller owns, by seq (`syncNow`
 * in editor.ts). None of these can change which bytes reach the file, only
 * where the work that chose them ran.
 */
import type { RoundTripProtection } from "@birta/minimal-diff";
import type { VerifyReply, VerifyRequest } from "../workers/protocol";

/** The bytes a sync should write, and how many verifying reparses choosing them took. */
export interface MergeAnswer {
    text: string;
    canonical: boolean;
    reparses: number;
}

export interface VerifyOracle {
    /**
     * Serialize `doc` (a `ProseNode.toJSON()`), merge it into `saved` under
     * `protection`, and verify the result — the same decision
     * `mergeVerified` makes here.
     */
    merge(doc: unknown, saved: string, protection: RoundTripProtection | null): Promise<MergeAnswer>;
    /** Start the worker and run its parser and serializer over `text` once, off the mount path. */
    warm(text: string): void;
}

/**
 * How long a question may go unanswered before the worker is presumed wedged.
 * Sized as an order of magnitude over a cold pass over the largest fixture,
 * because the cost of firing early is one sync run twice, and the cost of
 * never firing is a sync pipeline that stops.
 */
const ANSWER_TIMEOUT_MS = 20_000;

interface Pending {
    resolve(answer: MergeAnswer): void;
    reject(reason: Error): void;
    timer: ReturnType<typeof setTimeout>;
}

let override: VerifyOracle | null | undefined;
let retired = false;
let workerPromise: Promise<Worker> | null = null;
let blobUrl: string | null = null;
let nextId = 0;
const pending = new Map<number, Pending>();

/** The oracle to ask, or null when this runtime cannot host one. */
export function verifyOracle(): VerifyOracle | null {
    if (override !== undefined) return override;
    if (retired || typeof Worker === "undefined") return null;
    return liveOracle;
}

/**
 * Test seam: `null` says no oracle, an object stands in for the worker, and
 * `undefined` restores the real one. jsdom has no `Worker`, so without this
 * every test runs the main-thread path.
 */
export function setVerifyOracleForTests(oracle: VerifyOracle | null | undefined): void {
    override = oracle;
}

const liveOracle: VerifyOracle = {
    async merge(doc, saved, protection) {
        const worker = await start();
        const id = ++nextId;
        return new Promise<MergeAnswer>((resolve, reject) => {
            const timer = setTimeout(() => {
                pending.delete(id);
                retire(new Error("sync worker: no answer"));
                reject(new Error("sync worker: no answer"));
            }, ANSWER_TIMEOUT_MS);
            pending.set(id, { resolve, reject, timer });
            try {
                worker.postMessage({ type: "merge", id, doc, saved, protection } satisfies VerifyRequest);
            } catch (e) {
                // A document the structured clone refuses never reaches the
                // worker, and the next one would not either: retire, and let
                // the caller decide here instead.
                pending.delete(id);
                clearTimeout(timer);
                const reason = e instanceof Error ? e : new Error(String(e));
                retire(reason);
                reject(reason);
            }
        });
    },
    warm(text) {
        start()
            .then((worker) => worker.postMessage({ type: "warm", text } satisfies VerifyRequest))
            .catch(() => { /* retired by start; the next sync takes the main-thread path */ });
    },
};

function start(): Promise<Worker> {
    if (!workerPromise) {
        workerPromise = spawn().catch((e: unknown) => {
            retire(e instanceof Error ? e : new Error(String(e)));
            throw e;
        });
    }
    return workerPromise;
}

async function spawn(): Promise<Worker> {
    const { source } = await import("../workers/verifyWorkerSource");
    if (!source) throw new Error("this build carries no sync worker");
    blobUrl = URL.createObjectURL(new Blob([source], { type: "text/javascript" }));
    const worker = new Worker(blobUrl);
    worker.onmessage = (event: MessageEvent<VerifyReply>) => {
        const reply = event.data;
        if (reply.type === "merged") {
            const p = pending.get(reply.id);
            if (!p) return; // answered after its timeout, already run on the main thread
            pending.delete(reply.id);
            clearTimeout(p.timer);
            p.resolve({ text: reply.text, canonical: reply.canonical, reparses: reply.reparses });
        } else if (reply.type === "failed") {
            retire(new Error(`sync worker: ${reply.reason}`));
        }
    };
    // A policy refusing the script, or the script throwing while it loads,
    // arrives here rather than as a constructor throw.
    worker.onerror = (event) => {
        retire(new Error(`sync worker: ${event.message || "error"}`));
    };
    return worker;
}

/** Fail every question in flight, stop the worker, and never start another this session. */
function retire(reason: Error): void {
    retired = true;
    // Loud, because the degradation is invisible: every sync still writes
    // the right bytes, on the main thread, and the only sign is a large
    // document that hitches again. The e2e runner fails a suite on this.
    console.error("[birta] sync worker retired; the save decision runs on the main thread:", reason.message);
    for (const p of pending.values()) {
        clearTimeout(p.timer);
        p.reject(reason);
    }
    pending.clear();
    const stopping = workerPromise;
    workerPromise = null;
    stopping?.then((worker) => worker.terminate()).catch(() => { /* never started */ });
    if (blobUrl) {
        URL.revokeObjectURL(blobUrl);
        blobUrl = null;
    }
}
