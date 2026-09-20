/**
 * webview/workers/protocol.ts — what crosses between the page and the sync
 * worker (MAR-430, MAR-432).
 *
 * One request carries a sync's whole question: the document as
 * `doc.toJSON()`, the saved bytes it is merged into, and the round-trip
 * protection derived from that baseline. One reply carries its whole answer:
 * the bytes to write and whether they are canonical. No editor, no view and
 * no format object crosses — the worker imports the markdown format itself,
 * so the profile and the serializer are the page's own objects rather than a
 * copy of them.
 *
 * Everything here must survive a structured clone, which is why the document
 * crosses as JSON and the protection as the plain maps and arrays
 * `computeRoundTripProtection` builds.
 */
import type { RoundTripProtection } from "@birta/minimal-diff";

export type VerifyRequest =
    /** Build the parser and serializer and run both once over `text`, so the first real question is answered warm. */
    | { type: "warm"; text: string }
    /** Serialize this document, merge it into `saved`, and verify the result. */
    | {
        type: "merge";
        id: number;
        /** `ProseNode.toJSON()` of the live document, rebuilt here against the worker's own schema. */
        doc: unknown;
        saved: string;
        protection: RoundTripProtection | null;
    };

export type VerifyReply =
    | { type: "warmed" }
    /**
     * The bytes to write, `canonical` as `VerifiedMerge` defines it, and how
     * many verifying reparses this pass ran — the page stamps that count so
     * the work the sync did stays visible where it moved to.
     */
    | { type: "merged"; id: number; text: string; canonical: boolean; reparses: number }
    /** The worker cannot answer this or anything after it (its parser failed to build). */
    | { type: "failed"; id: number | null; reason: string };
