/**
 * components/frontmatter/provenance.ts
 *
 * The provenance label: what a block's Open Knowledge Format fields say about
 * where this document came from and whether it has gone stale, drawn in the
 * panel's bottom row beside the collapse toggle.
 *
 * It is a label and never a control. Nothing here is clickable, nothing is
 * persisted, and no byte of the block is touched: the reader takes the entries
 * the panel has already parsed and hands back words. The row it joins survives
 * the panel collapsing, which is the point, since a document's freshness is
 * the one thing worth seeing without opening the table.
 *
 * Staleness is carried by the words rather than by a colour. Every colour in
 * this editor already means something (`docs/DESIGN_PRINCIPLES.md`: hue names
 * the source of a finding, and the warning tint is spoken for by a computed
 * value whose premise moved), and this label sits among plain chrome chips
 * where a tinted one would read as the panel being in an error state rather
 * than as the document making a claim about itself.
 *
 * A block the table cannot describe has no entries, so it has no label either.
 * Its fields are on screen verbatim in the raw editor directly above, which is
 * where a reader looks for them; the tier and the expiry, which are read
 * rather than written down, are what such a block does not get.
 */

import { t } from "../../i18n";
import { okfStaleSince, readOkfProvenance } from "../../../shared/okf";
import type { FmEntry } from "../../../shared/frontmatterTable";
import type { OkfProvenance, OkfStatus, OkfTrust } from "../../../shared/okf";

/** Between segments: a separator that is not punctuation in any segment. */
const SEPARATOR = " · ";

const STATUS_LABELS: Record<OkfStatus, string> = {
    draft: "Draft",
    stable: "Stable",
    deprecated: "Deprecated",
};

/**
 * The tier, named for what it says about the signatures rather than for how
 * much to trust them. `verified` is the field's own word, so the three read as
 * one vocabulary and a reader who has seen the block knows which field they
 * came from.
 */
const TRUST_LABELS: Record<OkfTrust, string> = {
    unverified: "Unverified",
    machine: "Machine-verified",
    human: "Human-verified",
};

/**
 * The label's text, or null when the block has nothing to say.
 *
 * Segments run from the document's own declaration to what the editor derived:
 * the status it claims, the tier its signatures earn, then the deadline it has
 * passed. `now` is the caller's, so the expiry is testable without a clock.
 */
export function provenanceLabel(provenance: OkfProvenance, now: number): string | null {
    const segments: string[] = [];
    if (provenance.status) { segments.push(t(STATUS_LABELS[provenance.status])); }
    if (provenance.trust) { segments.push(t(TRUST_LABELS[provenance.trust])); }
    const staleSince = okfStaleSince(provenance, now);
    if (staleSince) { segments.push(`${t("Stale since")} ${staleSince}`); }
    return segments.length === 0 ? null : segments.join(SEPARATOR);
}

/**
 * The label element for a parsed block, or null when there is nothing to draw.
 *
 * Null is the answer for every document that is not carrying provenance, which
 * is most of them, so the caller appends nothing rather than an empty node.
 */
export function createProvenanceLabel(entries: FmEntry[], now: number): HTMLElement | null {
    const provenance = readOkfProvenance(entries);
    if (!provenance) { return null; }
    const text = provenanceLabel(provenance, now);
    if (!text) { return null; }

    const el = document.createElement("span");
    el.className = "fm-provenance";
    el.textContent = text;
    return el;
}
