/**
 * webview/plugins/fingerprints.ts
 *
 * The content fingerprint (MAR-108): the identity-multiset oracle both
 * fidelity layers compare documents with — contentGuard's transaction-
 * boundary conservation checks and reparseHazard's save-survival check.
 * A neutral module so those two never import each other for it: the guard
 * consumes the hazard check (a designed refusal lane) while the hazard
 * check consumes this oracle, one direction each.
 *
 * The fingerprint is a sorted multiset (Map entry → count) built in one
 * doc.descendants pass:
 *   - every text leaf, byte-exact (`text:`);
 *   - every atom's identity bytes (`atom:`) — image src/alt/title, math
 *     source, raw inline html, wiki-link raw, footnote labels;
 *   - every identity-bearing container's marker bytes (`marker:`) — callout
 *     marker line, notion-callout head, directive fence lines, footnote
 *     definition label;
 *   - a count per node type (`count:`).
 * Marker bytes and type counts are non-negotiable: the historical
 * `/tip`-destroys-outer-callout bug (B6, commit e4d01a6) had no text-leaf
 * delta at all — only a marker line and a container count vanished.
 */
import type { Fragment, Node as ProseNode } from "../pm";

// ── Fingerprint ─────────────────────────────────────────────────────────────

/** Content fingerprint: multiset of identity strings (entry → count). */
export type Fingerprint = ReadonlyMap<string, number>;

export const SEP = "\u0000";

/**
 * Identity bytes per atom type. A type missing here is still count-tracked;
 * these entries additionally pin the CONTENT the atom carries in attrs
 * (invisible to text-leaf comparison).
 */
const ATOM_IDENTITY: Record<string, (node: ProseNode) => string> = {
    image: (n) => [n.attrs["src"], n.attrs["alt"], n.attrs["title"]].join(SEP),
    image_ref: (n) => [n.attrs["identifier"], n.attrs["label"], n.attrs["alt"]].join(SEP),
    html: (n) => String(n.attrs["value"] ?? ""),
    // Constant identity: a hardbreak carries no attrs, but the atom entry
    // promotes it from the count tier (which native drops exempt) to the
    // entry-exact tier drops enforce — without it, a move-drop into a
    // context that discards a hard line break silently loses a newline.
    hardbreak: () => "",
    // Math source is real text content (MAR-74); the entry pins the atom's
    // identity as a unit on top of the text leaves inside it.
    math_inline: (n) => n.textContent,
    wiki_link: (n) => String(n.attrs["raw"] ?? ""),
    footnote_reference: (n) => String(n.attrs["label"] ?? ""),
    link_definition: (n) =>
        [n.attrs["identifier"], n.attrs["url"], n.attrs["title"] ?? ""].join(SEP),
};

/** Marker bytes per identity-bearing container type (the B6 net). */
const MARKER_IDENTITY: Record<string, (node: ProseNode) => string> = {
    // The raw marker line carries kind, fold marker, and title bytes.
    callout: (n) => String(n.attrs["marker"] ?? ""),
    notion_callout: (n) => [n.attrs["icon"], n.attrs["kind"]].join(SEP),
    // Fence COLON COUNT is structural, not content: nesting a directive
    // legitimately lengthens the outer fence (`::::` outside `:::`, MAR-120),
    // so it is normalized to `:::` before comparison — the identity is the
    // fence name + label/attrs, which IS user content. (Normalized to `:::`
    // rather than stripped so the bytes still parse via parseOpenFence in
    // MARKER_IS_DEFAULT below.)
    container_directive: (n) =>
        [
            String(n.attrs["openFence"] ?? "").replace(/^:+/, ":::"),
            String(n.attrs["closeFence"] ?? "").replace(/^:+/, ":::"),
        ].join(SEP),
    footnote_definition: (n) => String(n.attrs["label"] ?? ""),
};

/**
 * The fingerprint `marker:` key for a container node, or null for types that
 * carry no marker identity. Exported so movers can DECLARE the markers of
 * containers a move legitimately empties (see `ContentGuardTag.dissolvedMarkers`).
 */
export function markerKeyOf(node: ProseNode): string | null {
    const marker = MARKER_IDENTITY[node.type.name];
    return marker ? `marker:${node.type.name}:${marker(node)}` : null;
}

/**
 * A CONTENTLESS paragraph — empty, or holding nothing but hard breaks — that
 * is NOT a table cell. Markdown has no syntax for one (the editor deliberately
 * emits no `<br />` filler to stay pure Markdown — see serialization.ts), so
 * it always degrades to blank lines and never survives a save→reopen. It is
 * therefore not content: a move that relocates one (which then vanishes on
 * save), or a container's auto-fill blank being absorbed when real content
 * joins it, loses zero user bytes. The fingerprint skips it so the guard's
 * oracle matches that reality (MAR-123) rather than flagging a phantom
 * `count:paragraph` loss. Table cells legitimately hold break-only / empty
 * content that DOES round-trip (MAR-17), so they are excluded.
 */
export function isBlankParagraph(node: ProseNode, parent: ProseNode | null): boolean {
    if (node.type.name !== "paragraph") {
        return false;
    }
    if (parent?.type.name.startsWith("table")) {
        return false;
    }
    if (node.content.size === 0) {
        return true;
    }
    let blank = true;
    node.forEach((child: ProseNode) => {
        if (child.type.name !== "hardbreak") {
            blank = false;
        }
    });
    return blank;
}

/**
 * Fingerprint a document (or any node/fragment) in one descendants pass.
 * O(doc); runs only for tagged/drop transactions, never on typing.
 */
export function fingerprintDoc(content: ProseNode | Fragment): Fingerprint {
    const fp = new Map<string, number>();
    const add = (key: string): void => {
        fp.set(key, (fp.get(key) ?? 0) + 1);
    };
    content.descendants((node: ProseNode, _pos: number, parent: ProseNode | null) => {
        if (node.isText) {
            // No count entry for text nodes: leaf boundaries are
            // presentational (marks split them); the bytes are the identity.
            add(`text:${node.text ?? ""}`);
            return true;
        }
        // A contentless paragraph carries no bytes and cannot round-trip, so
        // it is not fingerprinted (neither its count nor a hardbreak-only
        // body) — the oracle must not treat its save-time disappearance as
        // loss (MAR-123). Skipping its subtree drops the break atoms too.
        if (isBlankParagraph(node, parent)) {
            return false;
        }
        const name = node.type.name;
        const atom = ATOM_IDENTITY[name];
        if (atom) {
            add(`atom:${name}:${atom(node)}`);
        }
        const markerKey = markerKeyOf(node);
        if (markerKey) {
            add(markerKey);
        }
        add(`count:${name}`);
        return true;
    });
    return fp;
}

export interface FingerprintDelta {
    /** Entries present in `before` beyond their count in `after`. */
    lost: Map<string, number>;
    /** Entries present in `after` beyond their count in `before`. */
    gained: Map<string, number>;
}

/** The multiset difference between two fingerprints, both directions. */
export function diffFingerprints(before: Fingerprint, after: Fingerprint): FingerprintDelta {
    const lost = new Map<string, number>();
    const gained = new Map<string, number>();
    for (const [key, count] of before) {
        const other = after.get(key) ?? 0;
        if (count > other) {
            lost.set(key, count - other);
        }
    }
    for (const [key, count] of after) {
        const other = before.get(key) ?? 0;
        if (count > other) {
            gained.set(key, count - other);
        }
    }
    return { lost, gained };
}

/** Compact human-readable delta for console diagnostics. */
export function formatFingerprintDiff(delta: FingerprintDelta): string {
    const clip = (key: string): string => (key.length > 80 ? `${key.slice(0, 77)}…` : key);
    const side = (entries: Map<string, number>): string =>
        entries.size === 0
            ? "(none)"
            : [...entries].map(([key, n]) => `${n > 1 ? `${n}× ` : ""}${clip(key)}`).join(", ");
    return `lost: ${side(delta.lost)}; gained: ${side(delta.gained)}`;
}
