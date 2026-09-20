/**
 * shared/okf.ts
 *
 * The Open Knowledge Format's provenance fields, READ out of the frontmatter
 * entries `parseTabularFrontmatter` already produced. Nothing here writes, and
 * nothing here parses: the block's own bytes are the panel's business, and a
 * field this module does not recognize is a field it leaves alone.
 *
 * That is the spec's rule rather than ours. A consumer must not reject a
 * document for an unknown field or a missing one, and every field but `type`
 * is optional, so every accessor below answers null instead of throwing and no
 * shape is required to be present before another is read.
 *
 * Two things are deliberately not here. Actor strings are classified by prefix
 * only (`human:`, `team:`, `process:`, anything else being a tool), because the
 * tier below is the only question the editor asks of an actor and a fuller
 * model would be a vocabulary nobody reads. And the tier is mechanical, never
 * a judgement: `team:` is not `human:`, so a team's signature confirms a
 * machine-checked document rather than a reviewed one.
 */

import { parseQuotedToken } from "./frontmatterTable";
import type { FmEntry, FmNestedItem } from "./frontmatterTable";

/** `status`, which the spec closes to exactly these three. */
export type OkfStatus = "draft" | "stable" | "deprecated";

/**
 * How far a document's `verified` list goes, in the spec's own tiers.
 *
 * `unverified` is the tier of a document that claims an origin and carries no
 * countersignature, which includes the shape the spec does not describe: a
 * `verified` block holding no actor at all confirms nothing, so it is read as
 * the absence it amounts to rather than as a signature.
 */
export type OkfTrust = "unverified" | "machine" | "human";

export type OkfProvenance = {
    status: OkfStatus | null;
    /** `stale_after` exactly as the file spells it. */
    staleAfter: string | null;
    /**
     * Null when the block makes no origin claim for a tier to qualify.
     *
     * `generated` is read for its presence and not for its actor. Who produced
     * a document is a row of the panel's own table, directly above whatever
     * reads this; the tier is the fact that is derived rather than written
     * down, and is therefore the one worth carrying out of here.
     */
    trust: OkfTrust | null;
};

const STATUSES: readonly string[] = ["draft", "stable", "deprecated"];

/** A leaf's or entry's value with its quotes taken off. Verbatim text otherwise. */
function unquote(value: string): string {
    return parseQuotedToken(value.trim()).value;
}

function findEntry(entries: FmEntry[], key: string): FmEntry | undefined {
    return entries.find((e) => e.key === key);
}

/** Every mapping under a nested value, whichever of the three shapes spelled it. */
function nestedItems(entry: FmEntry | undefined): FmNestedItem[] {
    return entry?.nested?.items ?? [];
}

/** One leaf's value inside a mapping, or null when the mapping has no such key. */
function leaf(item: FmNestedItem, key: string): string | null {
    const found = item.leaves.find((l) => l.key === key);
    return found ? unquote(found.value) : null;
}

/** Does this actor string name a person? The `human:` prefix is the whole test. */
function isHumanActor(actor: string): boolean {
    return actor.startsWith("human:");
}

/**
 * The tier `verified` earns, given whether an origin was claimed at all.
 *
 * Read `verified` first: a countersigned document is tiered by its signatures
 * whether or not it says where it came from.
 */
function readTrust(entries: FmEntry[]): OkfTrust | null {
    const verified = findEntry(entries, "verified");
    if (verified) {
        const actors = nestedItems(verified)
            .map((item) => leaf(item, "by"))
            .filter((by): by is string => by !== null && by !== "");
        if (actors.some(isHumanActor)) { return "human"; }
        if (actors.length > 0) { return "machine"; }
        return "unverified";
    }
    return findEntry(entries, "generated") ? "unverified" : null;
}

/**
 * The provenance an OKF block declares, or null when it declares none.
 *
 * Null is the ordinary answer. `title` and `tags` are frontmatter's common
 * vocabulary rather than this format's, so the presence of a provenance field
 * is what makes a block OKF here: a recognized `status`, a `stale_after`, a
 * `generated`, or a `verified`. `type` is the spec's one required field and is
 * deliberately not part of that test, in both directions: a note carrying
 * `generated` and no `type` has still told the reader where it came from, and
 * a `type` on its own has told them nothing.
 */
export function readOkfProvenance(entries: FmEntry[]): OkfProvenance | null {
    const statusValue = unquote(findEntry(entries, "status")?.value ?? "");
    // An unrecognized `status` is somebody else's field under the same name,
    // so it is not read at all rather than shown in a vocabulary it is not in.
    const status = STATUSES.includes(statusValue) ? (statusValue as OkfStatus) : null;

    const staleRaw = unquote(findEntry(entries, "stale_after")?.value ?? "");
    const staleAfter = staleRaw === "" ? null : staleRaw;

    const trust = readTrust(entries);

    if (status === null && staleAfter === null && trust === null) { return null; }
    return { status, staleAfter, trust };
}

/**
 * The day `stale_after` names, when that moment has passed at `now`.
 *
 * Null covers every other answer, the three being indistinguishable to a
 * reader and none of them worth a cue: no `stale_after`, a datetime the
 * platform cannot read, and a deadline still ahead. A date the editor cannot
 * parse is the spec's case for leaving a document alone rather than the
 * editor's case for calling it broken.
 *
 * The moment the field names is the last one still fresh, since the field
 * says what is true AFTER it. The distinction is a millisecond wide and is
 * kept because the word is not ambiguous.
 *
 * What comes back is the file's own text, never a reformat: a document that
 * spells its deadline one way must not be quoted back in another. The time of
 * day is dropped only where the value opens with a calendar date, since
 * `Date.parse` also accepts spellings whose first ten characters are the
 * middle of a word.
 */
export function okfStaleSince(provenance: OkfProvenance, now: number): string | null {
    const raw = provenance.staleAfter;
    if (raw === null) { return null; }
    const at = Date.parse(raw);
    if (Number.isNaN(at) || at >= now) { return null; }
    return /^\d{4}-\d{2}-\d{2}/.test(raw) ? raw.slice(0, 10) : raw;
}
