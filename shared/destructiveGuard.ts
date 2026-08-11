/**
 * destructiveGuard.ts — the destructive-change tripwire (MAR-114, fidelity
 * layer 4).
 *
 * Layers 1–3 (the minimal-diff merge, round-trip protection, and the webview
 * content guard) prevent the destructive writes they can see coming. This
 * layer assumes one of them failed: when a single webview-produced content
 * replacement removes a large share of the document's significant lines, the
 * provider keeps the prior full text in a one-slot store and logs a
 * structured dev-console warning, and "Birta Writer: Restore Previous
 * Content" hands the text back. Cheap insurance, not a snapshot system —
 * VS Code undo, hot exit, and the webview's own history remain the primary
 * backstops.
 *
 * Threshold stance: the tripwire cannot distinguish a legitimate mass delete
 * from a serializer bug, and it does not need to — a false positive costs a
 * dev-console line and a slot overwrite (the user sees nothing), while a
 * false negative costs the recovery path. So it is deliberately sensitive.
 */

/** Floor: ordinary edits in small documents never trip. */
export const TRIPWIRE_MIN_LINES = 8;
/** Relative arm: losing a tenth of the document in one tick trips. */
export const TRIPWIRE_MIN_FRACTION = 0.1;
/** Absolute arm: a loss this large trips regardless of document size. */
export const TRIPWIRE_ABSOLUTE_LINES = 200;

/** Non-blank lines — the same significance rule the minimal-diff engine uses. */
export function countSignificantLines(text: string): number {
    let count = 0;
    for (const line of text.split("\n")) {
        if (line.trim() !== "") { count++; }
    }
    return count;
}

export interface TripwireVerdict {
    tripped: boolean;
    /** Net significant lines lost by the replacement (negative = growth). */
    removed: number;
    beforeSig: number;
    afterSig: number;
}

/** Judge one whole-document content replacement (before → after). */
export function judgeReplacement(before: string, after: string): TripwireVerdict {
    const beforeSig = countSignificantLines(before);
    const afterSig = countSignificantLines(after);
    const removed = beforeSig - afterSig;
    const tripped =
        removed >= TRIPWIRE_MIN_LINES &&
        (removed >= beforeSig * TRIPWIRE_MIN_FRACTION || removed >= TRIPWIRE_ABSOLUTE_LINES);
    return { tripped, removed, beforeSig, afterSig };
}
