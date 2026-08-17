/**
 * webview/blockCapabilities.ts
 *
 * The single module that answers "can this block become that?" (MAR-109).
 *
 * Every schema node type declares a handful of facts about ITSELF
 * (BLOCK_CAPABILITIES); the legality of a conversion pair is DERIVED from
 * shape compatibility (deriveConversion), then filtered by small explicit
 * override tables. This leans on ProseMirror's own structural grammar
 * instead of fighting it: textblocks retype via setBlockType/setNodeMarkup,
 * wrappers wrap/unwrap, atoms and composites don't retype at all.
 *
 * Why declarations, not an N×N matrix: a hand-maintained matrix rots
 * silently under type creep — a new node type absent from it is
 * indistinguishable from a deliberate "converts to nothing". Here, a type
 * missing from the registry is a RED BUILD (see
 * webview/__tests__/blockCapabilities.test.ts), so "not convertible" is
 * always a decision, never an omission.
 *
 * Node TYPES get capability declarations (coverage-complete); node
 * INSTANCES get a conversion kind via `kindOf` (task lists are bullet lists
 * with `checked` attrs; image-only paragraphs are visual blocks, not
 * prose — MAR-79). Kinds are the UI vocabulary the block menu and slash
 * registry share.
 *
 * The concrete converters (retype/unwrap/itemize/fence) live in
 * components/blockMenu/turnInto.ts; `convertAt` dispatches to them on the
 * shape pair, so the mechanism is derived along with the legality.
 */
import type { EditorView } from "./pm";
import type { Node as ProseNode } from "./pm";
import { getHeadingLevel, isTextBearingParagraph, setHeadingLevelAt } from "./plugins/headingFold";
import type { GetEditor } from "./editorCommands";
// Runtime-only cycle (turnInto imports this module's kind probes back for
// its legacy predicate); both sides touch the other only inside function
// bodies, matching the contentGuard ↔ headingFold precedent.
import {
    containerToList,
    joinAdjacentWrappersIn,
    retypeContainer,
    retypeList,
    turnIntoCodeBlock,
    turnRangeIntoCodeBlock,
    unwrapContainerTo,
    unwrapListTo,
    wrapListIn,
    wrapProseIn,
} from "./components/blockMenu";
import { BlockRangeSelection } from "./plugins/blockRange";
import { TextSelection } from "./pm";
// Runtime-only cycle (contentGuard → headingFold → this module →
// contentGuard); both are only called inside convertAt's and convertRange's
// bodies.
import { auditConversion, tagContentGuard } from "./plugins/contentGuard";

// ── Vocabulary ──────────────────────────────────────────────────────────────

/**
 * The convertible top-level kinds — the Turn-into UI vocabulary.
 *
 * `directive` and `notionCallout` are the two container syntaxes that are
 * structurally callouts and are spelled differently (`:::note …:::` and
 * `<aside>…</aside>`). They keep kinds of their OWN rather than normalizing
 * into `callout`, because the menu's current row states what the block IS: a
 * directive told it was a callout would both misname itself and lose the
 * conversion INTO a real GFM callout, which is the migration gesture the
 * kinds exist to offer. The mechanism is shared regardless (retypeContainer
 * does not care which wrapper it started from).
 */
export type ConversionKind =
    | "paragraph"
    | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
    | "bulletList" | "orderedList" | "taskList"
    | "blockquote" | "callout" | "codeBlock"
    | "directive" | "notionCallout";

export const ALL_KINDS: readonly ConversionKind[] = [
    "paragraph",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "bulletList", "orderedList", "taskList",
    "blockquote", "callout", "codeBlock",
    "directive", "notionCallout",
];

const HEADING_KINDS: readonly ConversionKind[] = ["h1", "h2", "h3", "h4", "h5", "h6"];

/** Structural shape — decides WHICH conversion mechanism can apply. */
export type BlockShape =
    | "textblock"   // inline* content; retypes via setBlockType/setNodeMarkup
    | "wrapper"     // block+ content; wrap / unwrap / retype-in-place
    | "list"        // item-structured wrapper; retype + per-item attr sweep
    | "composite"   // rigid structured children (table); no generic transform
    | "leaf"        // no content (hr, link_definition)
    | "inline"      // not a block at all; out of scope structurally
    | "structural"; // doc, table_row, list_item, … — never user-addressable

/** What the content IS — decides what survives a conversion. */
export type ContentClass =
    | "prose"       // formatted inline text
    | "blocks"      // nested blocks
    | "verbatim"    // uninterpreted text (code, math source)
    | "data"        // structured data (table cells, task state)
    | "none";

/**
 * Fingerprint-key vocabulary for content effects: the closed set of things a
 * conversion can declare it drops or adds. Closed on purpose. Two consumers
 * hang a `Record<FingerprintKey, …>` off it (the guard's marker map in
 * plugins/contentGuard.ts and the menu's loss notes in blockMenu/menu.ts), so
 * a key added here without words for the user, or without the guard knowing
 * which marker it exempts, is a compile error rather than a silent audit
 * failure or a row with no warning.
 */
export type FingerprintKey =
    | "task:state"       // list_item `checked`
    | "callout:marker"   // a GFM callout's `> [!KIND]` line (kind, title, fold)
    | "directive:name"   // a `:::name` container's name
    | "notion:icon";     // a Notion aside callout's leading icon

/**
 * Declared content effect of a conversion — data only for now; MAR-108's
 * data-fidelity content guard is the consumer.
 */
export type ContentEffect =
    | "conserving"                  // moves, retypes: fingerprint identical
    | "conserving-modulo-marks"     // e.g. → code fence: marks flatten to literal markdown text
    | { drops?: FingerprintKey[]; adds?: FingerprintKey[] };

export interface BlockCapability {
    shape: BlockShape;
    content: ContentClass;
    /**
     * The conversion kind(s) instances of this type can present as, or a
     * classifier when it depends on the instance (bullet_list → bulletList
     * vs taskList; paragraph → paragraph vs null for image-only
     * paragraphs). `null` ⇒ instances never enter the Turn-into vocabulary
     * (they get an actions-only menu). `kindOf` is the ONLY reader of this
     * field — the function/string discriminate lives in one place.
     */
    kind: ConversionKind | ((node: ProseNode) => ConversionKind | null) | null;
    /** May instances be converted away? */
    source: boolean;
    /** May instances be a conversion result? */
    target: boolean;
}

// Shorthands for the never-convertible coverage rows, so declaring a new
// structural/inline type is one word, not five decisions.
export const STRUCTURAL: BlockCapability =
    { shape: "structural", content: "none", kind: null, source: false, target: false };
export const INLINE: BlockCapability =
    { shape: "inline", content: "none", kind: null, source: false, target: false };

// ── Instance classifiers (the `kind` field's function arm) ─────────────────

/** A bullet list whose items carry `checked` renders (and serializes) as a
 * task list — the single probe shared by the menu and the gutter glyphs. */
export function isTaskListNode(node: ProseNode): boolean {
    const first = node.firstChild;
    return node.type.name === "bullet_list" && first !== null && first.attrs["checked"] != null;
}

function classifyParagraph(node: ProseNode): ConversionKind | null {
    return isTextBearingParagraph(node) ? "paragraph" : null;
}

function classifyHeading(node: ProseNode): ConversionKind {
    return `h${Math.min(Math.max(getHeadingLevel(node), 1), 6)}` as ConversionKind;
}

function classifyBulletList(node: ProseNode): ConversionKind {
    return isTaskListNode(node) ? "taskList" : "bulletList";
}

// ── The registry ────────────────────────────────────────────────────────────

/**
 * Five facts per schema node type. Coverage is exhaustive by test: every
 * name in `schema.nodes` must appear here, and every key here must exist in
 * the schema (webview/__tests__/blockCapabilities.test.ts).
 */
export const BLOCK_CAPABILITIES: Record<string, BlockCapability> = {
    // Textblocks
    paragraph:   { shape: "textblock", content: "prose",    kind: classifyParagraph,  source: true,  target: true },
    heading:     { shape: "textblock", content: "prose",    kind: classifyHeading,    source: true,  target: true },
    // code_block → anything needs a per-block re-parse; the source-peek work
    // (MAR-20) is the natural home for flipping `source` to true.
    code_block:  { shape: "textblock", content: "verbatim", kind: "codeBlock",        source: false, target: true },

    // Block wrappers (block+ content)
    blockquote:  { shape: "wrapper",   content: "blocks",   kind: "blockquote",       source: true,  target: true },
    callout:     { shape: "wrapper",   content: "blocks",   kind: "callout",          source: true,  target: true },
    // Callouts in another spelling. Convertible AWAY (the wrapper rules give
    // directive ⇄ quote ⇄ callout ⇄ list for free), never a target: nothing
    // in the editor authors these syntaxes, and making them targets would add
    // two rows to every block's Turn-into menu for a spelling most documents
    // never use. Flipping `target` is one word if that changes.
    container_directive: { shape: "wrapper", content: "blocks", kind: "directive",     source: true,  target: false },
    notion_callout:      { shape: "wrapper", content: "blocks", kind: "notionCallout", source: true,  target: false },
    // Identity-bearing (numbering, back-references): converting away needs
    // its own design (design doc §10.6).
    footnote_definition: { shape: "wrapper", content: "blocks", kind: null,           source: false, target: false },

    // Lists
    bullet_list:  { shape: "list",     content: "blocks",   kind: classifyBulletList, source: true,  target: true },
    ordered_list: { shape: "list",     content: "blocks",   kind: "orderedList",      source: true,  target: true },

    // Composites and leaves
    table:           { shape: "composite", content: "data", kind: null, source: false, target: false },
    hr:              { shape: "leaf",      content: "none", kind: null, source: false, target: false },
    link_definition: { shape: "leaf",      content: "data", kind: null, source: false, target: false },

    // Structural / inline coverage — declared so the exhaustiveness test
    // passes, and so "not convertible" is a decision, not an omission.
    doc: STRUCTURAL,
    list_item: STRUCTURAL,
    table_row: STRUCTURAL,
    table_header_row: STRUCTURAL,
    table_cell: STRUCTURAL,
    table_header: STRUCTURAL,
    text: INLINE,
    image: INLINE,
    image_ref: INLINE,
    hardbreak: INLINE,
    html: INLINE,
    math_inline: INLINE,
    wiki_link: INLINE,
    footnote_reference: INLINE,

    // MDX (format #2, MAR-42): opaque code islands. Never convertible — the
    // source bytes are a single attr the editor preserves verbatim, so there
    // is no prose to re-shape into anything.
    mdx_block:  { shape: "leaf", content: "data", kind: null, source: false, target: false },
    mdx_inline: INLINE,
};

// ── Kind probes ─────────────────────────────────────────────────────────────

/** The conversion kind of a node instance, or null for blocks the Turn-into
 * vocabulary can't name. The registry's only `kind`-field reader. */
export function kindOf(node: ProseNode): ConversionKind | null {
    const capability = BLOCK_CAPABILITIES[node.type.name];
    if (!capability || capability.kind === null) {
        return null;
    }
    return typeof capability.kind === "function" ? capability.kind(node) : capability.kind;
}

/** The conversion kind of the block at `pos`, or null (actions-only menu). */
export function conversionKindAt(view: EditorView, pos: number): ConversionKind | null {
    const node = view.state.doc.nodeAt(pos);
    return node ? kindOf(node) : null;
}

// ── Derivation ──────────────────────────────────────────────────────────────

/** The node type a kind retypes INTO — how a kind borrows its declaration. */
const TYPE_BY_KIND: Record<ConversionKind, string> = {
    paragraph: "paragraph",
    h1: "heading", h2: "heading", h3: "heading",
    h4: "heading", h5: "heading", h6: "heading",
    bulletList: "bullet_list", taskList: "bullet_list", orderedList: "ordered_list",
    blockquote: "blockquote", callout: "callout", codeBlock: "code_block",
    directive: "container_directive", notionCallout: "notion_callout",
};

function capabilityOfKind(kind: ConversionKind): BlockCapability {
    return BLOCK_CAPABILITIES[TYPE_BY_KIND[kind]]!;
}

/**
 * Deny overrides win over any derivation — the escape hatch for
 * "structurally possible but semantically nonsense". Empty today: every
 * nonsense pair is already non-derivable. Exists so the first
 * semantically-wrong derivable pair costs one line.
 */
const DENIED: ReadonlySet<`${ConversionKind}->${ConversionKind}`> = new Set([]);

type Converter = (
    view: EditorView,
    pos: number,
    target: ConversionKind,
    getEditor: GetEditor,
) => boolean;

interface Override {
    from: ConversionKind;
    to: ConversionKind;
    effect: ContentEffect;
    /** Instance predicate — the pair is offered only when it holds. */
    when?: (node: ProseNode) => boolean;
    /** Bespoke position-targeted converter. */
    convert: Converter;
}

/**
 * Allow overrides add back specific pairs the shapes can't derive, each
 * with a bespoke converter and declared content effect — the seam for smart
 * conversions (future: code_block → anything via re-parse when MAR-20's
 * source-peek lands). Empty today.
 */
const OVERRIDES: readonly Override[] = [];

interface DerivedConversion {
    effect: ContentEffect;
    /** Instance predicate (derivation rule 5) — must hold on the source node. */
    when?: (node: ProseNode) => boolean;
}

/** Quote/callout → list requires all-paragraph content (each direct child
 * becomes an item); anything else bails rather than guessing. */
function allParagraphChildren(node: ProseNode): boolean {
    let allParagraphs = node.childCount > 0;
    node.forEach((child) => {
        if (child.type.name !== "paragraph") {
            allParagraphs = false;
        }
    });
    return allParagraphs;
}

/** Content-effect helper: what a kind's own baggage is called. */
function effectBetween(source: ConversionKind, target: ConversionKind): ContentEffect {
    const drops: FingerprintKey[] = [];
    const adds: FingerprintKey[] = [];
    if (source === "taskList" && target !== "taskList") {
        drops.push("task:state");
    }
    if (target === "taskList" && source !== "taskList") {
        adds.push("task:state");
    }
    // A titled callout's title is rescued as leading prose on the way out
    // (see withCalloutTitle in turnInto.ts); the marker line itself drops.
    if (source === "callout" && target !== "callout") {
        drops.push("callout:marker");
    }
    if (target === "callout" && source !== "callout") {
        adds.push("callout:marker");
    }
    // The two other container spellings. A directive's fence (its name
    // spelling and any attributes) and a Notion callout's icon have nowhere to
    // go in any target. A callout target does keep the KIND where the callout
    // alias table already resolves the name or icon (`:::warning` becomes
    // `[!WARNING]`, see turnInto's calloutAttrsFor); what drops is the fence
    // or icon itself, which is what these keys name.
    if (source === "directive" && target !== "directive") {
        drops.push("directive:name");
    }
    if (source === "notionCallout" && target !== "notionCallout") {
        drops.push("notion:icon");
    }
    if (drops.length === 0 && adds.length === 0) {
        return "conserving";
    }
    return {
        ...(drops.length > 0 && { drops }),
        ...(adds.length > 0 && { adds }),
    };
}

/**
 * Type-level legality of `source → target`, derived in rule order (design
 * doc §3.2). Returns the pair's content effect (and instance predicate, if
 * any), or null when the pair never derives.
 */
function deriveConversion(
    source: ConversionKind,
    target: ConversionKind,
): DerivedConversion | null {
    // Rule 0: the diagonal is always legal — the block menu's filled
    // "current type" row depends on it (a no-op pick, not a conversion).
    if (source === target) {
        return { effect: "conserving" };
    }
    // Rule 1: deny overrides win regardless of shape.
    if (DENIED.has(`${source}->${target}`)) {
        return null;
    }
    const from = capabilityOfKind(source);
    const to = capabilityOfKind(target);
    if (!from.source) {
        return null; // e.g. code_block until MAR-20 flips the flag
    }
    // Rule 2: verbatim sink — every `source: true` block has a serializer-
    // faithful markdown form to put inside a fence. Keys on the DECLARATION,
    // not the shape: "could this become a code fence?" is answered by
    // flipping one declared flag, never by a rule change.
    if (target === "codeBlock") {
        return { effect: "conserving-modulo-marks" };
    }
    if (!to.target || from.content === "verbatim") {
        return null;
    }
    // Rule 3: same shape ⇒ retype in place.
    if (from.shape === to.shape &&
        (from.shape === "textblock" || from.shape === "wrapper" || from.shape === "list")) {
        return { effect: effectBetween(source, target) };
    }
    // Rule 4: wrapper/list ⇄ textblock ⇒ wrap/unwrap.
    if ((from.shape === "wrapper" || from.shape === "list") && to.shape === "textblock") {
        return { effect: effectBetween(source, target) };
    }
    if (from.shape === "textblock" && (to.shape === "wrapper" || to.shape === "list")) {
        return { effect: effectBetween(source, target) };
    }
    // Rule 5: wrapper ⇄ list ⇒ conditional restructure. List → wrapper wraps
    // the whole list (items travel intact); wrapper → list itemizes each
    // paragraph child, so it carries an instance predicate.
    if (from.shape === "list" && to.shape === "wrapper") {
        return { effect: effectBetween(source, target) };
    }
    if (from.shape === "wrapper" && to.shape === "list") {
        return { effect: effectBetween(source, target), when: allParagraphChildren };
    }
    // Rule 6: composite, leaf, inline, structural (and everything else)
    // derive nothing. Not "denied" — they simply never derive; no rule has
    // to be written to keep them illegal.
    return null;
}

/**
 * The declared content effect of a legal `source → target` pair, or null
 * when the pair never derives. Data only for now — MAR-108's content guard
 * is the consumer.
 */
export function contentEffectOf(
    source: ConversionKind,
    target: ConversionKind,
): ContentEffect | null {
    const override = OVERRIDES.find((entry) => entry.from === source && entry.to === target);
    if (override) {
        return override.effect;
    }
    return deriveConversion(source, target)?.effect ?? null;
}

// ── The public predicate and dispatcher ─────────────────────────────────────

/**
 * Whether converting the block at `pos` to `target` is offered: classify
 * the instance, derive the pair, then check any instance predicate.
 * (Absorbs the block menu's hand-written `canTurnInto`.)
 */
export function canConvert(view: EditorView, pos: number, target: ConversionKind): boolean {
    const source = conversionKindAt(view, pos);
    if (source === null) {
        return false;
    }
    const override = OVERRIDES.find((entry) => entry.from === source && entry.to === target);
    const derived = override ?? deriveConversion(source, target);
    if (!derived) {
        return false;
    }
    if (derived.when) {
        const node = view.state.doc.nodeAt(pos);
        return node !== null && derived.when(node);
    }
    return true;
}

function headingLevelOf(kind: ConversionKind): number {
    const idx = HEADING_KINDS.indexOf(kind);
    return idx === -1 ? 0 : idx + 1;
}

/**
 * Convert the block at `pos` to `target`. The mechanism is derived along
 * with the legality: the shape pair names which transform runs, overrides
 * carry their own converter. Position-targeted throughout; refocuses the
 * editor. No-ops (returns false) when the conversion isn't offered or
 * nothing changes. (Absorbs the block menu's `turnBlockInto`.)
 */
export function convertAt(
    view: EditorView,
    pos: number,
    target: ConversionKind,
    getEditor: GetEditor,
): boolean {
    if (!canConvert(view, pos, target)) {
        return false;
    }
    const source = conversionKindAt(view, pos);
    if (source === null || source === target) {
        return false; // the filled current row is a legal no-op pick
    }
    const override = OVERRIDES.find((entry) => entry.from === source && entry.to === target);
    // Content-guard audit (MAR-108): the pair's declared effect is the
    // contract; undeclared deltas are logged (warn-only — see GUARD_MODE).
    // Gesture-scoped rather than per-transaction because the wrap path
    // dispatches through replayed toolbar commands (multi-dispatch).
    const changed = auditConversion(view, contentEffectOf(source, target), () => {
        if (override) {
            return override.convert(view, pos, target, getEditor);
        }
        if (target === "codeBlock") {
            return turnIntoCodeBlock(view, pos, getEditor);
        }
        const fromShape = capabilityOfKind(source).shape;
        const toShape = capabilityOfKind(target).shape;
        if (fromShape === "textblock" && toShape === "textblock") {
            return setHeadingLevelAt(view, pos, headingLevelOf(target));
        } else if (fromShape === "textblock") {
            return wrapProseIn(view, pos, source, target, getEditor);
        } else if (fromShape === "list" && toShape === "list") {
            return retypeList(view, pos, target);
        } else if (fromShape === "list" && toShape === "textblock") {
            return unwrapListTo(view, pos, headingLevelOf(target));
        } else if (fromShape === "list" && toShape === "wrapper") {
            return wrapListIn(view, pos, target);
        } else if (fromShape === "wrapper" && toShape === "textblock") {
            return unwrapContainerTo(view, pos, headingLevelOf(target));
        } else if (fromShape === "wrapper" && toShape === "list") {
            return containerToList(view, pos, target);
        } else if (fromShape === "wrapper" && toShape === "wrapper") {
            return retypeContainer(view, pos, target);
        }
        return false;
    });
    if (changed) {
        view.focus();
    }
    return changed;
}


// ── A run of blocks ─────────────────────────────────────────────────────────

/** The positions of the whole top-level blocks `range` covers, in document
 * order: the unit a block-range selection or a fold-expanded cover names
 * (`selectionCoverRange`). Depth-0 boundaries only; anything else is empty. */
export function coveredBlockPositions(doc: ProseNode, range: { from: number; to: number }): number[] {
    const positions: number[] = [];
    doc.forEach((_node, offset) => {
        if (offset >= range.from && offset < range.to) {
            positions.push(offset);
        }
    });
    return positions;
}

/**
 * Whether EVERY block in the run may become `target`: the intersection of
 * the covered blocks' legal targets, never apply-where-legal ("Structure
 * travels whole", docs/DESIGN_PRINCIPLES.md). A block with no conversion
 * kind at all (a table, a rule, an image paragraph) empties the intersection,
 * so a run that includes one offers no Turn-into rows rather than converting
 * around it. False for a run of fewer than two blocks: that is `canConvert`.
 */
export function canConvertRange(
    view: EditorView,
    range: { from: number; to: number },
    target: ConversionKind,
): boolean {
    const positions = coveredBlockPositions(view.state.doc, range);
    return positions.length > 1 && positions.every((pos) => canConvert(view, pos, target));
}

/** The one content effect a run conversion declares: the union of every
 * covered pair's drops and adds, or the fence's flatten when that is the
 * target (it subsumes every marker drop, since the markers become text). */
function rangeContentEffect(sources: readonly ConversionKind[], target: ConversionKind): ContentEffect {
    const drops = new Set<FingerprintKey>();
    const adds = new Set<FingerprintKey>();
    for (const source of sources) {
        const effect = contentEffectOf(source, target);
        if (effect === "conserving-modulo-marks") {
            return effect;
        }
        if (effect !== null && effect !== "conserving") {
            effect.drops?.forEach((key) => drops.add(key));
            effect.adds?.forEach((key) => adds.add(key));
        }
    }
    if (drops.size === 0 && adds.size === 0) {
        return "conserving";
    }
    return {
        ...(drops.size > 0 && { drops: [...drops] }),
        ...(adds.size > 0 && { adds: [...adds] }),
    };
}

/**
 * The span over which two documents differ, at top-level block granularity:
 * the leading and trailing children they share (node identity first, then
 * structural equality) are excluded, and what is left is the edit. Null when
 * they are the same document.
 */
function changedTopLevelSpan(
    before: ProseNode,
    after: ProseNode,
): { beforeFrom: number; beforeTo: number; afterFrom: number; afterTo: number } | null {
    let prefix = 0;
    while (
        prefix < before.childCount && prefix < after.childCount &&
        before.child(prefix).eq(after.child(prefix))
    ) {
        prefix++;
    }
    let suffix = 0;
    while (
        suffix < before.childCount - prefix && suffix < after.childCount - prefix &&
        before.child(before.childCount - 1 - suffix).eq(after.child(after.childCount - 1 - suffix))
    ) {
        suffix++;
    }
    if (prefix === before.childCount && prefix === after.childCount) {
        return null;
    }
    const startOf = (doc: ProseNode, index: number): number => {
        let pos = 0;
        for (let i = 0; i < index; i++) {
            pos += doc.child(i).nodeSize;
        }
        return pos;
    };
    return {
        beforeFrom: startOf(before, prefix),
        beforeTo: startOf(before, before.childCount - suffix),
        afterFrom: startOf(after, prefix),
        afterTo: startOf(after, after.childCount - suffix),
    };
}

/**
 * Convert every block in the run to `target`, as one transaction and one
 * undo step. Each block converts by its own registry rule (`convertAt`,
 * walking the run bottom-up so the positions above stay valid), and then the
 * run is consolidated the way one gesture over the same selection would have
 * left it: adjacent same-type wrappers or lists the conversion produced join
 * into one, and a code-fence target fences the run's markdown as one block
 * (both in components/blockMenu/turnInto.ts). A block already of the target
 * kind converts to nothing and still joins. Refuses (returns false, no
 * dispatch) unless `canConvertRange` holds, or when nothing would change.
 *
 * One transaction is achieved by REPLAY, not by hoping history groups the
 * pieces: the per-block converters dispatch to the view themselves (some by
 * replaying toolbar commands), so the run is converted live, the span the
 * document differs over read back (`changedTopLevelSpan`, which also
 * catches a neighbour the list auto-join pulled the run into), the view
 * rewound to the state before the gesture, and that span applied as a
 * single replace. That transaction carries
 * the content guard's convert tag with the union of the pairs' declared
 * effects (MAR-108), so the guard sees the whole gesture as one contract.
 * prosemirror-history's own grouping would need every step to touch the
 * previous one's range, and a covered block that is already the target
 * kind breaks that chain; the replay owes it nothing.
 *
 * The replay is not inert: every `appendTransaction` plugin runs again over
 * it, against the state BEFORE the gesture rather than the state each live
 * step saw. A plugin whose verdict depends on the old document (the list
 * auto-join's fidelity gate) can therefore answer differently on the replay
 * than it did live, and the live result must not lean on such a verdict.
 * The one known case, a marker-less list absorbing an authored one, is
 * closed at the join itself (`joinListBoundary` carries the marker up), and
 * pinned by the marker-split tests in convertRange.test.ts.
 */
export function convertRange(
    view: EditorView,
    range: { from: number; to: number },
    target: ConversionKind,
    getEditor: GetEditor,
): boolean {
    if (!canConvertRange(view, range, target)) {
        return false;
    }
    const stateBefore = view.state;
    const positions = coveredBlockPositions(stateBefore.doc, range);
    const sources = positions
        .map((pos) => conversionKindAt(view, pos))
        .filter((kind): kind is ConversionKind => kind !== null);
    const keepRunSelected = stateBefore.selection instanceof BlockRangeSelection;

    // 1. Convert live, block by block, bottom-up.
    let changed = false;
    if (target === "codeBlock") {
        changed = turnRangeIntoCodeBlock(view, range, getEditor);
    } else {
        for (const pos of [...positions].reverse()) {
            if (conversionKindAt(view, pos) === target) {
                continue;
            }
            changed = convertAt(view, pos, target, getEditor) || changed;
        }
    }
    // Where the document differs now, at top-level granularity: the run,
    // widened to any neighbour a conversion or an appended plugin
    // transaction (the list auto-join) pulled it into. Every block outside
    // this span is the same node it was, by identity.
    if (capabilityOfKind(target).shape === "wrapper") {
        const span = changedTopLevelSpan(stateBefore.doc, view.state.doc);
        if (span) {
            changed = joinAdjacentWrappersIn(view, { from: span.afterFrom, to: span.afterTo }, TYPE_BY_KIND[target]) || changed;
        }
    }
    const span = changed ? changedTopLevelSpan(stateBefore.doc, view.state.doc) : null;
    if (!span) {
        return false;
    }

    // 2. Read the result back, rewind, and apply it as ONE transaction. The
    // result stays selected the way the run was: as a block range, or as a
    // text selection spanning it, so the next chord acts on what was just
    // converted rather than on a caret parked at its end.
    const result = view.state.doc.slice(span.afterFrom, span.afterTo);
    view.updateState(stateBefore);
    let tr = stateBefore.tr.replaceWith(span.beforeFrom, span.beforeTo, result.content);
    const resultTo = span.beforeFrom + result.content.size;
    if (keepRunSelected) {
        const selection = BlockRangeSelection.tryCreate(tr.doc, span.beforeFrom, resultTo);
        if (selection) {
            tr = tr.setSelection(selection);
        }
    } else if (stateBefore.selection instanceof TextSelection && !stateBefore.selection.empty) {
        tr = tr.setSelection(TextSelection.between(
            tr.doc.resolve(span.beforeFrom), tr.doc.resolve(resultTo)));
    }
    view.dispatch(
        tagContentGuard(tr, { kind: "convert", effect: rangeContentEffect(sources, target) })
            .scrollIntoView(),
    );
    view.focus();
    return true;
}
