/**
 * webview/workers/protocol.ts — what crosses between the page and the verify
 * worker (MAR-430). Text and a fingerprint one way, a boolean the other; no
 * document model in either direction, which is what keeps tier B0 free of a
 * shadow document.
 */

export type VerifyRequest =
    /** Build the parser and run it once over `text`, so the first real question is answered warm. */
    | { type: "warm"; text: string }
    /** Does `text` reopen holding exactly the content `liveFp` fingerprints? */
    | { type: "reopens"; id: number; text: string; liveFp: ReadonlyMap<string, number> };

export type VerifyReply =
    | { type: "warmed" }
    | { type: "verdict"; id: number; reopens: boolean }
    /** The worker cannot answer this or anything after it (its parser failed to build). */
    | { type: "failed"; id: number | null; reason: string };
