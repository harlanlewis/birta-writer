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
import type { EditorView } from "@milkdown/prose/view";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { getHeadingLevel, setHeadingLevelAt } from "./plugins/headingFold";
import type { GetEditor } from "./editorCommands";
// Runtime-only cycle (turnInto imports this module's kind probes back for
// its legacy predicate); both sides touch the other only inside function
// bodies, matching the headingFold ↔ blockMenu precedent.
import {
    containerToList,
    retypeContainer,
    retypeList,
    turnIntoCodeBlock,
    unwrapContainerTo,
    unwrapListTo,
    wrapListIn,
    wrapProseIn,
} from "./components/blockMenu/turnInto";

// ── Vocabulary ──────────────────────────────────────────────────────────────

/** The convertible top-level kinds — the Turn-into UI vocabulary. */
export type ConversionKind =
    | "paragraph"
    | "h1" | "h2" | "h3" | "h4" | "h5" | "h6"
    | "bulletList" | "orderedList" | "taskList"
    | "blockquote" | "callout" | "codeBlock";

export const ALL_KINDS: readonly ConversionKind[] = [
    "paragraph",
    "h1", "h2", "h3", "h4", "h5", "h6",
    "bulletList", "orderedList", "taskList",
    "blockquote", "callout", "codeBlock",
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
 * Fingerprint-key vocabulary for content effects. MAR-108's content guard
 * will own (and type) this vocabulary; until then keys are free-form
 * strings kept deliberately coarse.
 */
export type FingerprintKey = string;

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

/**
 * True when a paragraph carries actual text content — at least one inline
 * child that is neither an image nor an html atom, ignoring whitespace-only
 * text. Image-only and HTML-only paragraphs are visual blocks, not prose
 * (MAR-79), so they get an actions-only menu.
 */
export function isTextBearingParagraph(node: ProseNode): boolean {
    if (node.childCount === 0) {
        return true; // a blank line the user is about to type on
    }
    let sawAtom = false;
    let sawContent = false;
    node.forEach((child) => {
        const name = child.type.name;
        if (name === "image" || name === "html") {
            sawAtom = true;
            return;
        }
        if (child.isText && !child.text?.trim()) {
            return;
        }
        sawContent = true;
    });
    // Whitespace-only paragraphs (no atoms at all) are still prose — only a
    // paragraph whose real content is images/html is a visual block.
    return sawContent || !sawAtom;
}

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
    // Deliberately conversion-less today (they get actions-only menus, as
    // before this registry existed). Offering directive/notion-callout
    // conversions — structurally free via the wrapper rules — is MAR-115.
    container_directive: { shape: "wrapper", content: "blocks", kind: null,           source: false, target: false },
    notion_callout:      { shape: "wrapper", content: "blocks", kind: null,           source: false, target: false },
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
    let changed = false;
    if (override) {
        changed = override.convert(view, pos, target, getEditor);
    } else if (target === "codeBlock") {
        changed = turnIntoCodeBlock(view, pos, getEditor);
    } else {
        const fromShape = capabilityOfKind(source).shape;
        const toShape = capabilityOfKind(target).shape;
        if (fromShape === "textblock" && toShape === "textblock") {
            changed = setHeadingLevelAt(view, pos, headingLevelOf(target));
        } else if (fromShape === "textblock") {
            changed = wrapProseIn(view, pos, source, target, getEditor);
        } else if (fromShape === "list" && toShape === "list") {
            changed = retypeList(view, pos, target);
        } else if (fromShape === "list" && toShape === "textblock") {
            changed = unwrapListTo(view, pos, headingLevelOf(target));
        } else if (fromShape === "list" && toShape === "wrapper") {
            changed = wrapListIn(view, pos, target);
        } else if (fromShape === "wrapper" && toShape === "textblock") {
            changed = unwrapContainerTo(view, pos, headingLevelOf(target));
        } else if (fromShape === "wrapper" && toShape === "list") {
            changed = containerToList(view, pos, target);
        } else if (fromShape === "wrapper" && toShape === "wrapper") {
            changed = retypeContainer(view, pos, target);
        }
    }
    if (changed) {
        view.focus();
    }
    return changed;
}
