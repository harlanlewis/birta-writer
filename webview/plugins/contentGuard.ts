/**
 * webview/plugins/contentGuard.ts
 *
 * The content-conservation guard (MAR-108, data-fidelity design §3 "Layer
 * 1"): a runtime invariant at the transaction boundary that turns silent
 * data loss from block gestures into a loud, reportable no-op.
 *
 * The idea: operations whose contract is "nothing changes but position or
 * shape" — moves, duplicates, table reorders, conversions — TAG their
 * transaction (tagContentGuard). The guard's filterTransaction compares a
 * content fingerprint of the document before and after and vetoes (or, for
 * conversions, logs) any undeclared delta. ProseMirror's native drop
 * handler, which no tagged primitive routes through, is gated by its
 * `uiEvent: "drop"` meta. Untagged transactions — typing, deliberate
 * deletions, paste — cost one meta lookup and are never fingerprinted.
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
import { Plugin, PluginKey, type EditorState, type Transaction } from "@milkdown/prose/state";
import { Fragment, type Node as ProseNode } from "@milkdown/prose/model";
import type { EditorView } from "@milkdown/prose/view";
import { ReplaceAroundStep, ReplaceStep } from "@milkdown/prose/transform";
import { $prose } from "@milkdown/utils";
import type { ContentEffect } from "../blockCapabilities";
import { t } from "../i18n";
import { parseCalloutMarker } from "./callouts";
import { parseOpenFence } from "./directives";
// Runtime-only cycle (contentGuard → headingFold → blockMenu → contentGuard):
// these are only called inside filterTransaction bodies, matching the
// established headingFold ↔ blockMenu precedent.
import { foldedHiddenRanges, hiddenRangeCoversTarget } from "./headingFold";

// ── Guard mode ──────────────────────────────────────────────────────────────

/**
 * Enforcement mode per operation class.
 *
 * Moves and duplicates VETO: their contracts are exact (a move conserves
 * everything; a duplicate gains exactly its copy), the primitives already
 * carry a bespoke insert-size check for the worst case, and a vetoed gesture
 * is a harmless no-op the user simply retries.
 *
 * Conversions are WARN-ONLY for now: their expected-change declarations
 * (blockCapabilities' `contentEffect`) are new and the conversion matrix is
 * wide, so the guard soaks for a release to measure the false-positive rate
 * before it is allowed to block — a guard that vetoes legitimate edits burns
 * the same trust budget as the bugs it prevents. Note that TODAY nothing
 * tags `kind: "convert"`: every conversion runs through the gesture-scoped,
 * inherently warn-only `auditConversion` below (several paths are
 * multi-dispatch, so a per-transaction filter can't see their net effect).
 * Flipping `convert` here is therefore necessary but NOT sufficient to make
 * conversions veto — each conversion path must first become single-dispatch
 * and tag its transaction, at which point the (currently unreached) convert
 * branch in filterTransaction takes over.
 *
 * Native drops VETO: the in-document move contract is exact, and the
 * folded-target rule guards content from vanishing into display:none.
 */
export const GUARD_MODE: {
    readonly move: "veto" | "warn";
    readonly duplicate: "veto" | "warn";
    readonly convert: "veto" | "warn";
    readonly drop: "veto" | "warn";
} = {
    move: "veto",
    duplicate: "veto",
    convert: "warn",
    drop: "veto",
};

// ── Fingerprint ─────────────────────────────────────────────────────────────

/** Content fingerprint: multiset of identity strings (entry → count). */
export type Fingerprint = ReadonlyMap<string, number>;

const SEP = "\u0000";

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

// ── Tagging protocol ────────────────────────────────────────────────────────

export interface ContentGuardTag {
    kind: "move" | "convert" | "duplicate";
    /** convert: the pair's declared content effect (blockCapabilities). */
    effect?: ContentEffect;
    /** duplicate: the inserted copy — expected gain is exactly its fingerprint. */
    gained?: Fragment | ProseNode;
    /**
     * move: `marker:` keys (via `markerKeyOf`) of containers this move
     * legitimately EMPTIES — deleteRange dissolves them, marker line and all,
     * titled or not. Only declared markers are exempt from marker-loss
     * vetoes; an undeclared marker loss is the buggy-unwrap shape (children
     * survive, wrapper vanishes) and vetoes.
     */
    dissolvedMarkers?: string[];
}

export const contentGuardKey = new PluginKey("content-guard");

/** Tag a transaction so the guard holds it to its operation's contract. */
export function tagContentGuard(tr: Transaction, tag: ContentGuardTag): Transaction {
    return tr.setMeta(contentGuardKey, tag);
}

// ── Contract checks ─────────────────────────────────────────────────────────

const isText = (key: string): boolean => key.startsWith("text:");
const isAtom = (key: string): boolean => key.startsWith("atom:");
const isMarker = (key: string): boolean => key.startsWith("marker:");

/**
 * Container types `deleteRange` may legitimately dissolve when a move empties
 * them (dragging a list's last item away dissolves the list; the last child
 * out of a callout dissolves the callout, marker line included). A dissolved
 * container that still held text is caught by the text entries regardless.
 */
const DISSOLVABLE = new Set([
    "bullet_list",
    "ordered_list",
    "list_item",
    "blockquote",
    "callout",
    "container_directive",
    "notion_callout",
    "footnote_definition",
]);

/**
 * Whether lost marker bytes are the BARE/default marker for their container
 * kind — carrying no user content beyond the container's existence. Only
 * such markers may vanish under the emptied-container exemption in
 * `checkMove`: a titled callout's marker line holds user bytes (the title)
 * that live nowhere else in the doc, so losing it is content loss even when
 * every child survived — exactly the shape of a buggy unwrap. A kind absent
 * here is never exempt (footnote_definition: its label IS its identity;
 * notion_callout: the icon emoji is user bytes).
 *
 * This byte-shape heuristic is the FALLBACK for undeclared marker losses.
 * The precise path is `ContentGuardTag.dissolvedMarkers`: `moveBlocks`
 * declares the markers of containers the move actually empties (source-range
 * ancestry), and those are exempt titled or not — so a legitimate "move the
 * only child out of a titled callout" applies while a buggy unwrap (children
 * survive, wrapper vanishes) still vetoes.
 */
const MARKER_IS_DEFAULT: Record<string, (bytes: string) => boolean> = {
    // `[!kind]` (fold marker allowed — it is view state), empty title.
    callout: (bytes) => parseCalloutMarker(bytes)?.title === "",
    // Bare `:::name` open fence: no label/attrs bytes after the name.
    container_directive: (bytes) => {
        const open = parseOpenFence(bytes.split(SEP)[0] ?? "");
        return open !== null && open.rest.trim() === "";
    },
};

/** A move conserves everything, modulo dissolving containers it emptied. */
export function checkMove(
    delta: FingerprintDelta,
    dissolvedMarkers?: ReadonlySet<string>,
): string | null {
    // A move synthesizes no content, so any gain is a violation. (The empty
    // paragraph deleteRange refills a fully-emptied doc with is a blank
    // paragraph, which the fingerprint no longer counts — MAR-123 — so the
    // former `count:paragraph`-gain exemption is vestigial; a NON-blank
    // paragraph gain carries text and must still veto.)
    if (delta.gained.size > 0) {
        if (delta.gained.size > 1 || delta.gained.get("count:paragraph") !== 1) {
            const first = delta.gained.keys().next().value as string;
            return `move gained content (${first})`;
        }
    }
    for (const key of delta.lost.keys()) {
        const m = /^(count|marker):([^:]+)/.exec(key);
        if (!m || !DISSOLVABLE.has(m[2]!)) {
            return `move lost content (${key})`;
        }
        if (m[1] === "marker") {
            // Count loss is exempt for dissolvable kinds, but marker BYTES
            // are only exempt when the mover DECLARED this container as
            // emptied-by-the-move (dissolvedMarkers), or — fallback for
            // undeclared paths — when they are the kind's bare/default
            // marker. A lost undeclared non-default marker means user bytes
            // vanished (titled-callout unwrap) and vetoes even though the
            // count loss doesn't.
            if (dissolvedMarkers?.has(key)) {
                continue;
            }
            const type = m[2]!;
            const bytes = key.slice(`marker:${type}:`.length);
            if (!MARKER_IS_DEFAULT[type]?.(bytes)) {
                return `move lost container marker bytes (${key})`;
            }
        }
    }
    return null;
}

/** A duplicate loses nothing and gains exactly the declared copy. */
export function checkDuplicate(delta: FingerprintDelta, expected: Fingerprint): string | null {
    const firstLost = delta.lost.keys().next();
    if (!firstLost.done) {
        return `duplicate lost content (${firstLost.value})`;
    }
    for (const [key, count] of expected) {
        if ((delta.gained.get(key) ?? 0) !== count) {
            return `duplicate gain mismatch (expected ${count}× ${key})`;
        }
    }
    for (const [key, count] of delta.gained) {
        if ((expected.get(key) ?? 0) !== count) {
            return `duplicate gained undeclared content (${key})`;
        }
    }
    return null;
}

/** `a` is a subsequence of `b` (all of a's code units appear in b, in order). */
function isSubsequence(a: string, b: string): boolean {
    let i = 0;
    for (let j = 0; i < a.length && j < b.length; j++) {
        if (a[i] === b[j]) {
            i++;
        }
    }
    return i === a.length;
}

/**
 * Which marker category a declared FingerprintKey exempts. Keys with no
 * fingerprint footprint ("task:state" — `checked` is an attr the fingerprint
 * doesn't carry) simply map to nothing.
 */
const EFFECT_KEY_TO_MARKER_TYPE: Record<string, string> = {
    "callout:marker": "callout",
};

/**
 * A conversion may change only what its pair declared (blockCapabilities'
 * `contentEffect`). Three deliberate relaxations, documented here because
 * they are the guard's shape, not accidents:
 *   - `"conserving-modulo-marks"` (→ code fence): marks, atoms, and block
 *     markers flatten into literal markdown text inside the fence, so the
 *     serializer ADDS delimiter/escape bytes. The check is therefore
 *     directional: the source's concatenated text must survive in order as a
 *     subsequence of the target's — bytes may appear, never disappear.
 *   - Type counts are exempt for every conversion: restructuring is what a
 *     conversion IS (paragraph→list changes three counts legally), and
 *     enumerating expected counts per pair would recreate the hand-written
 *     N×N matrix the capability registry exists to kill. Loss still shows in
 *     the text/atom/marker tiers.
 *   - Gained text/atoms are allowed: conversions synthesize prose from attrs
 *     (the callout-title rescue prepends the title as a paragraph). The
 *     loss direction — user bytes vanishing — is what the guard polices.
 */
export function checkConversion(
    before: ProseNode,
    after: ProseNode,
    effect: ContentEffect,
): string | null {
    if (effect === "conserving-modulo-marks") {
        return isSubsequence(before.textContent, after.textContent)
            ? null
            : "conversion lost text (flattened source is not contained in the result)";
    }
    const delta = diffFingerprints(fingerprintDoc(before), fingerprintDoc(after));
    const declared = (list: readonly string[] | undefined): Set<string> => {
        const types = new Set<string>();
        for (const key of list ?? []) {
            const type = EFFECT_KEY_TO_MARKER_TYPE[key];
            if (type) {
                types.add(type);
            }
        }
        return types;
    };
    const droppable = declared(effect === "conserving" ? undefined : effect.drops);
    const addable = declared(effect === "conserving" ? undefined : effect.adds);
    for (const key of delta.lost.keys()) {
        if (isText(key) || isAtom(key)) {
            return `conversion lost undeclared content (${key})`;
        }
        if (isMarker(key)) {
            const type = key.split(":")[1] ?? "";
            if (!droppable.has(type)) {
                return `conversion dropped undeclared marker (${key})`;
            }
        }
    }
    for (const key of delta.gained.keys()) {
        if (isMarker(key)) {
            const type = key.split(":")[1] ?? "";
            if (!addable.has(type)) {
                return `conversion added undeclared marker (${key})`;
            }
        }
    }
    return null;
}

/**
 * Gesture-scoped conversion audit, used by `convertAt`: fingerprint before
 * the first dispatch, compare after the last. Needed because several
 * conversion paths are MULTI-dispatch (wrapProseIn replays a toolbar command
 * whose dispatch happens inside the Milkdown command system), so a
 * per-transaction filter cannot see the pair's net effect. Warn-only by
 * nature — the transactions have already applied — which is why flipping
 * conversions to veto in GUARD_MODE also requires making every conversion
 * path single-dispatch (then the tagged filterTransaction branch takes over).
 */
export function auditConversion(
    view: EditorView,
    effect: ContentEffect | null,
    run: () => boolean,
): boolean {
    const before = view.state.doc;
    const changed = run();
    const after = view.state.doc;
    if (changed && after !== before) {
        const violation = checkConversion(before, after, effect ?? "conserving");
        if (violation) {
            // Hardcoded "warn-only": this audit runs AFTER its transactions
            // applied, so it can never veto regardless of GUARD_MODE.convert
            // — interpolating the mode here would misreport what happened.
            console.error(
                `[ContentGuard] conversion flagged (warn-only audit): ${violation}; ` +
                formatFingerprintDiff(
                    diffFingerprints(fingerprintDoc(before), fingerprintDoc(after)),
                ),
            );
        }
    }
    return changed;
}

// ── Native drop gating ──────────────────────────────────────────────────────

/**
 * Text tier of a delta as CHARACTER frequencies, splits cancelled. Native
 * drops legitimately re-slice text leaves (dragging "bc" out of "abcd"
 * leaves "ad"; the drop merges into its destination leaf), so leaf-exact
 * comparison would veto legal gestures — but the character multiset is
 * conserved by any true move, and any real loss/gain (the MAR-36 payload
 * leak, a half-committed delete) still shows.
 */
function textCharDelta(delta: FingerprintDelta): {
    lost: Map<string, number>;
    gained: Map<string, number>;
} {
    const tally = (source: Map<string, number>): Map<string, number> => {
        const chars = new Map<string, number>();
        for (const [key, count] of source) {
            if (!isText(key)) {
                continue;
            }
            for (const ch of key.slice(5)) {
                chars.set(ch, (chars.get(ch) ?? 0) + count);
            }
        }
        return chars;
    };
    const lost = tally(delta.lost);
    const gained = tally(delta.gained);
    for (const [ch, n] of lost) {
        const g = gained.get(ch) ?? 0;
        const cancel = Math.min(n, g);
        if (cancel > 0) {
            if (n - cancel === 0) {
                lost.delete(ch);
            } else {
                lost.set(ch, n - cancel);
            }
            if (g - cancel === 0) {
                gained.delete(ch);
            } else {
                gained.set(ch, g - cancel);
            }
        }
    }
    return { lost, gained };
}

/** First entry matching a predicate, for violation messages. */
function firstKey(
    entries: Map<string, number>,
    match: (key: string) => boolean,
): string | null {
    for (const key of entries.keys()) {
        if (match(key)) {
            return key;
        }
    }
    return null;
}

/**
 * Gate ProseMirror's native drop transaction (`uiEvent: "drop"`), the one
 * mover that routes around every tagged primitive — a text-selection drag,
 * or a draggable atom like math_inline. Two rules:
 *
 * 1. No drop may land inside a folded-hidden range (state-derived, both fold
 *    kinds) — content committed into display:none reads as deletion.
 * 2. An IN-DOCUMENT move-drop (recognized by its pure-deletion step: PM's
 *    drop handler deletes the dragged slice before inserting; external drops
 *    are insert-only) must conserve content exactly — text as a character
 *    multiset (see textCharDelta), atoms and markers entry-exact. Type
 *    counts are exempt: replaceRange fitting legitimately synthesizes or
 *    dissolves wrappers (splitting a paragraph, closing an open list slice).
 *    External/insert-only drops are intentional content GAIN and only the
 *    loss direction is checked.
 */
function checkDrop(
    tr: Transaction,
    state: EditorState,
    delta: FingerprintDelta,
): string | null {
    // Rule 1: folded landing sites.
    const hidden = foldedHiddenRanges(state);
    if (hidden.length > 0) {
        for (let i = 0; i < tr.steps.length; i++) {
            const step = tr.steps[i]!;
            if (!(step instanceof ReplaceStep) && !(step instanceof ReplaceAroundStep)) {
                continue;
            }
            if (step.slice.size === 0) {
                continue; // pure deletion — not an insert
            }
            // Step coords live in the doc AFTER steps 0..i-1; map the hidden
            // ranges (old-state coords) forward, then apply the shared
            // open/closed rule (hiddenRangeCoversTarget: heading sections
            // half-open at `to`, callout bodies inclusive) — the same
            // registry the move primitive and the drag slot filter consume.
            const map = tr.mapping.slice(0, i);
            for (const range of hidden) {
                const mapped = {
                    pos: range.pos,
                    from: map.map(range.from, 1),
                    to: map.map(range.to, -1),
                };
                if (hiddenRangeCoversTarget(state.doc, mapped, step.from)) {
                    return "drop target is inside folded (hidden) content";
                }
            }
        }
    }
    // Rule 2: conservation.
    const chars = textCharDelta(delta);
    const lostChar = chars.lost.keys().next();
    if (!lostChar.done) {
        return `drop lost text (${JSON.stringify(lostChar.value)})`;
    }
    const lostIdentity = firstKey(delta.lost, (k) => isAtom(k) || isMarker(k));
    if (lostIdentity) {
        return `drop lost content (${lostIdentity})`;
    }
    const isMoveDrop = tr.steps.some(
        (step) => step instanceof ReplaceStep && step.slice.size === 0 && step.from < step.to,
    );
    if (isMoveDrop) {
        const gainedChar = chars.gained.keys().next();
        if (!gainedChar.done) {
            return `in-document drop gained text (${JSON.stringify(gainedChar.value)})`;
        }
        const gainedIdentity = firstKey(delta.gained, (k) => isAtom(k) || isMarker(k));
        if (gainedIdentity) {
            return `in-document drop gained content (${gainedIdentity})`;
        }
    }
    return null;
}

// ── Quiet veto notice ───────────────────────────────────────────────────────

// Advisory and quiet per docs/DESIGN_PRINCIPLES.md: a small transient status
// pill (no button, no focus steal, aria-live polite), the webview's first —
// there is no shared toast utility to reuse.
let noticeEl: HTMLElement | null = null;
let noticeTimer: ReturnType<typeof setTimeout> | undefined;

function showGuardNotice(message: string): void {
    if (typeof document === "undefined") {
        return;
    }
    if (!noticeEl || !noticeEl.isConnected) {
        noticeEl = document.createElement("div");
        noticeEl.className = "content-guard-notice";
        noticeEl.setAttribute("role", "status");
        noticeEl.setAttribute("aria-live", "polite");
        document.body.appendChild(noticeEl);
    }
    // Clear before setting: aria-live announces on CHANGE, so a repeat veto
    // with the identical message on the reused node would otherwise be
    // silent to screen readers.
    noticeEl.textContent = "";
    noticeEl.textContent = message;
    noticeEl.classList.add("content-guard-notice--visible");
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => {
        noticeEl?.classList.remove("content-guard-notice--visible");
    }, 4000);
}

// ── The plugin ──────────────────────────────────────────────────────────────

function report(kind: string, mode: "veto" | "warn", violation: string, diff: string): void {
    console.error(
        `[ContentGuard] ${kind} ${mode === "veto" ? "blocked" : "flagged"}: ${violation}; ${diff}`,
    );
}

export const contentGuardPlugin = $prose(
    () =>
        new Plugin({
            key: contentGuardKey,
            filterTransaction(tr, state) {
                if (!tr.docChanged) {
                    return true;
                }
                const tag = tr.getMeta(contentGuardKey) as ContentGuardTag | undefined;
                if (tag) {
                    let violation: string | null = null;
                    const delta = diffFingerprints(
                        fingerprintDoc(state.doc),
                        fingerprintDoc(tr.doc),
                    );
                    if (tag.kind === "convert") {
                        // Currently unreached: nothing tags kind "convert"
                        // yet — every conversion is multi-dispatch and runs
                        // through the gesture-scoped auditConversion instead.
                        // Kept deliberately as the landing pad for the future
                        // single-dispatch conversion tagging (see the
                        // GUARD_MODE doc above).
                        violation = checkConversion(
                            state.doc,
                            tr.doc,
                            tag.effect ?? "conserving",
                        );
                    } else {
                        violation =
                            tag.kind === "move"
                                ? checkMove(
                                    delta,
                                    tag.dissolvedMarkers
                                        ? new Set(tag.dissolvedMarkers)
                                        : undefined,
                                )
                                : checkDuplicate(
                                    delta,
                                    // Fragment.from: a doc's descendants pass
                                    // excludes the doc node itself, so a bare
                                    // node copy must be wrapped to count too.
                                    tag.gained
                                        ? fingerprintDoc(Fragment.from(tag.gained))
                                        : new Map(),
                                );
                    }
                    if (!violation) {
                        return true;
                    }
                    const mode = GUARD_MODE[tag.kind];
                    report(tag.kind, mode, violation, formatFingerprintDiff(delta));
                    if (mode === "veto") {
                        showGuardNotice(
                            t("Change blocked — it would have altered document content. Please report this bug."),
                        );
                        return false;
                    }
                    return true;
                }
                if (tr.getMeta("uiEvent") === "drop") {
                    const delta = diffFingerprints(
                        fingerprintDoc(state.doc),
                        fingerprintDoc(tr.doc),
                    );
                    const violation = checkDrop(tr, state, delta);
                    if (violation) {
                        report("drop", GUARD_MODE.drop, violation, formatFingerprintDiff(delta));
                        if (GUARD_MODE.drop === "veto") {
                            showGuardNotice(
                                violation.includes("folded")
                                    ? t("Drop blocked — the target is hidden inside a fold.")
                                    : t("Drop blocked — it would have altered document content."),
                            );
                            return false;
                        }
                    }
                }
                return true;
            },
        }),
);
