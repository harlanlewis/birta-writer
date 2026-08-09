/**
 * webview/utils/verifiedMerge.ts (MAR-343)
 *
 * The save pipeline's last gate: what we are about to write to disk must
 * reopen as the document the user is looking at.
 *
 * `plugins/reparseHazard.ts` already asks that question of a block move, and
 * refuses the gesture when the answer is no. It asks it of the SERIALIZER's
 * output. The bytes that actually reach disk are the serializer's output MERGED
 * into the saved file (`applyMinimalChanges`), and the merge runs after that
 * check — so a merge that introduces damage of its own is invisible to every
 * gate upstream of it. Measured on `four-space-outline.md`: every damaged
 * (source, target) pair in the fixture's reachable move space serializes
 * CLEANLY and is corrupted only once merged.
 *
 * The engine defends itself where it can, by comparing its output against the
 * text the diff ran on (`FormatProfile.lineRoles`). That check is blind by
 * construction to damage the round-trip REPAIR introduces, because both sides
 * of its comparison descend from the repaired text and carry the defect alike;
 * `losesOpaqueContent` closes one specific case of it (MAR-326). This closes
 * the general one, and it can afford to be general precisely because it is not
 * a heuristic: it reparses and compares content, the same oracle the corpus
 * gate asserts.
 *
 * Rules that were measured and rejected before landing this, over 4890 corpus
 * merges (2742 of which ran a repair) — recorded so they are not re-proposed:
 *
 *   - "the repair changed a line's role": fires on 720 merges, 705 of them
 *     benign. Repairs change roles for a living, which is the same reason
 *     MAR-326 rejected it.
 *   - "the repair made a line shallower" / "changed a line's list depth":
 *     37 and 43 firings, and between them they catch ONE of the sixteen
 *     damaged merges. `listDepths` has no model of the indented-code threshold
 *     that does the damage, and giving it one is a parser living in the
 *     classifier.
 *   - "the repair gained opaque lines": 162 firings, catching NONE. The
 *     classifier deliberately reads indented code inside a list item as prose
 *     (MAR-131, so Logseq tab outlines stay depth-normalized), so the very
 *     construct that appears here is one it cannot see.
 *
 * WHEN A DOCUMENT IS ALREADY BROKEN, THIS MUST STAY QUIET. A file whose round
 * trip is dirty before the edit would otherwise degrade to canonical bytes on
 * every single save, discarding its own spelling forever. So the fallback is
 * taken only when the serializer's own text is CLEAN and the merged text is
 * not: that is the merge introducing damage, which is the only thing this
 * owns. Pre-existing damage belongs to the refuse lane and to the serializer.
 */
import type { Node as ProseNode } from "../pm";
import {
    applyMinimalChangesDetailed,
    serializerFallback,
    type FormatProfile,
    type RoundTripProtection,
} from "@birta/minimal-diff";
import { diffFingerprints, fingerprintDoc, formatFingerprintDiff } from "../plugins/fingerprints";

/** Parse markdown with the real parser; null when the parser refuses. */
export type ParseMarkdown = (markdown: string) => ProseNode | null;

const CLEAN = "lost: (none); gained: (none)";

/** Does `text` reopen holding exactly `live`'s content? */
function reopensAs(live: ProseNode, text: string, parse: ParseMarkdown): boolean {
    let doc: ProseNode | null;
    try {
        doc = parse(text);
    } catch {
        return false; // a parser throw is a failure to reopen, not a crash to propagate
    }
    if (!doc) {
        return false;
    }
    return (
        formatFingerprintDiff(diffFingerprints(fingerprintDoc(live), fingerprintDoc(doc))) === CLEAN
    );
}

/**
 * `applyMinimalChanges`, with the merged bytes verified against the live
 * document before they are handed on.
 *
 * Returns the merged text in every case except the one this exists for: the
 * merge damaged content that the serializer alone would have carried
 * faithfully. There the serializer's own text is written instead — the same
 * degradation the engine's internal self-checks take, and the same trade the
 * whole engine prefers: canonicalization churn is a diff the user can see and
 * undo, and silent structural loss is not.
 *
 * COST is one extra parse of the merged bytes, and a second one only on the
 * rare occasion the first came back dirty. It is charged ONLY to saves whose
 * merge relocated content — a block move — because that is the population the
 * damage lives in; an ordinary edit returns before the first parse. It rides
 * the sync path (typing pause, max-wait, save), never the keystroke path.
 */
export function mergeVerified(
    saved: string,
    serialized: string,
    profile: FormatProfile,
    protection: RoundTripProtection | null,
    live: ProseNode,
    parse: ParseMarkdown,
): string {
    const { text: merged, relocatedContent } = applyMinimalChangesDetailed(
        saved,
        serialized,
        profile,
        protection,
    );
    // The cost gate. Verifying means parsing the whole document a second time,
    // on top of the O(document) serialize the save already pays, and without
    // this gate every typing-pause sync of every file would pay it.
    //
    // Relocation is what makes the merge dangerous: saved bytes land beside
    // neighbours they were never spelled for, and the repair respells some of
    // them and not others. An in-place edit moves nothing, so its keeps keep
    // their own neighbours. Every damaged pair measured for MAR-343 was a block
    // move, and the engine gates its own depth-sensitive self-check on the same
    // signal for the same reason.
    if (!relocatedContent) {
        return merged;
    }
    const fallback = serializerFallback(saved, serialized);
    // The merge already chose the serializer's text (an internal self-check
    // tripped, or there was nothing saved to preserve). Both candidates are
    // the same bytes, so every branch below returns them; this only saves the
    // parse. It is an optimization and no test pins it, deliberately — there
    // is no behaviour here to pin.
    if (merged === fallback) {
        return merged;
    }
    if (reopensAs(live, merged, parse)) {
        return merged;
    }
    // The merged bytes are dirty. Only the merge's OWN damage is ours to
    // overrule: if the serializer is dirty too, the document was already
    // broken and writing canonical bytes would not fix it, while discarding
    // the file's spelling on every save certainly would hurt.
    return reopensAs(live, fallback, parse) ? fallback : merged;
}
