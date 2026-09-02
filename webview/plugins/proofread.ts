/**
 * Proofread plugin: iA-Writer-style Style Check + Harper spelling/grammar.
 *
 * Two layers, both rendered as view-only decorations that never reach the
 * serialized markdown:
 * - Style check (instant, webview-side): fillers, redundancies, clichés,
 *   and repeated words as a dimmed strikethrough. Entries carry iA-style
 *   `~~ ~~` markers so only the deletable sub-span is struck.
 * - Spelling & grammar (async, extension host): block texts are sent to
 *   Harper over the messaging channel; findings come back with spans,
 *   messages, and suggestions and render as underlines.
 *
 * Both passes are windowed (MAR-425, MAR-426): they run over the textblocks
 * near the viewport (plugins/visibleRange.ts, the same scroll window the fold
 * gutter reads), on a debounce after edits and on the frame the window moves,
 * so their cost is the screen and not the document. The style pass is
 * computed here; the lint pass is a question to the host, so the window's
 * unknown blocks are asked for and every drawn underline is a lookup in
 * proofread/lintCache by the block's current text. A block that is never
 * scrolled to is never asked about. Everything that is STATE stays
 * document-wide: the config, the suppressions, and the review sidebar's list,
 * which is answered from whole-document walks of its own rather than from the
 * windowed sets, and which asks the host for the blocks nothing has asked
 * about yet, in slices, when it is opened. Code blocks, inline code, and
 * tech-like tokens are excluded.
 */
import type { EditorView } from "../pm";
import { isReadOnly } from "../readOnly";
import { Decoration, DecorationSet } from "../pm";
import { Plugin, PluginKey, TextSelection } from "../pm";
import type { Node as ProseNode } from "../pm";
import { $prose } from "@milkdown/utils";
import type { HarperLint, LintBlock, LintBlockResult, ProofreadConfig } from "../../shared/messages";
import { INLINE_PLACEHOLDER } from "../../shared/proofreadFilter";
import { hostHas } from "../../shared/hostProfile";
import { compileStyleMatcher, isPhraseCategory, type StyleCategory, type StyleMatch, type StyleMatcher } from "../utils/styleMatcher";
import { observeVisibleWindow, type VisibleWindow } from "./visibleRange";
import { styleCategoryLabel } from "../utils/styleCategories";
import {
    AI_ARTIFACTS,
    AI_VOCABULARY,
    CLICHES,
    FILLERS,
    REDUNDANCIES,
    WORDINESS,
} from "../proofread/wordlists";
import {
    ignoreLintSession,
    ignoreStyleSession,
    keepStylePhrase,
    isLintSuppressed,
    isStyleSuppressed,
    learnWord,
    setUserWords,
} from "../proofread/engine";
import { lintCacheGeneration, lookupLints, rememberLints } from "../proofread/lintCache";
import { hideLintPopup, showFindingsPopup, type PopupButton, type PopupFinding } from "../proofread/popup";
import { notifyLintBlocks } from "../messaging";
import { requestIdle } from "../utils/idle";
import { clearMeasures, countWork, mark, measure, measureSpan } from "../perf";
import { t } from "../i18n";

const SCAN_DEBOUNCE_MS = 350;
// Upper bound on how long after first paint the initial proofread pass may wait
// for an idle window before it runs anyway.
const FIRST_PASS_IDLE_TIMEOUT_MS = 1000;
// How long after the scroll window moves before its unknown blocks are asked
// for. The observer already commits at most once per half screen; this is what
// a flick through a long document coalesces on, so the host is asked about
// the window the reader lands on rather than every one they passed. What the
// reader sees meanwhile is not delayed by it: blocks the host has answered
// for are drawn on the frame the window moves.
const WINDOW_LINT_DELAY_MS = 150;
// How much text one slice of the review sidebar's document-wide question
// carries. A budget rather than a measurement, and in characters rather than
// blocks for the reason SpellService.swift gives: what a host's thread is held
// for is the checking, which scales with text. Sized so a slice is well short
// of a long task on either host, a hundred short blocks or a handful of
// unwrapped paragraphs; `birta-trace lint` on the Mac is where the real cost
// per slice is read. A single block always goes whole, whatever its length.
const REVIEW_SLICE_CHARS = 8000;

/**
 * True when proofreading is active: the master gate is on AND at least one
 * domain check is on. Gate off (or every domain off) ⇒ the plugin does no work.
 */
function anyProofreadEnabled(c: ProofreadConfig): boolean {
    return c.proofreadingEnabled && (c.styleCheck || c.spellCheck || c.grammarCheck);
}

/** True when a host is to be asked about anything: the gate and a lint check on. */
function lintEnabled(c: ProofreadConfig): boolean {
    return c.proofreadingEnabled && (c.spellCheck || c.grammarCheck);
}

/** Spec attached to a Harper decoration so the popup can render it. */
export type LintSpec = {
    class: string;
    lint: HarperLint;
};

/** A style-check finding, resolved to everything the popup needs. */
export type StyleFinding = {
    category: StyleCategory;
    /** Full hover/popup explanation, one clause. */
    message: string;
    /**
     * Auto-fix payload, or null when the fix is a judgment call (long
     * sentence, passive, …): null = no suggestion button; "" = a "Remove"
     * button that deletes the span; any other string replaces the span.
     */
    suggestion: string | null;
};

/** Spec attached to a style-check decoration so the popup can render it. */
export type StyleSpec = {
    class: string;
    style: StyleFinding;
};

type DecoSpec = Partial<LintSpec & StyleSpec>;

type ProofreadState = {
    config: ProofreadConfig;
    styleSet: DecorationSet;
    lintSet: DecorationSet;
    combined: DecorationSet;
    /**
     * MAR-425: the scroll window `styleSet` was built for, in document
     * positions and position-mapped through edits. Null means the whole
     * document, which is the answer with no layout engine (jsdom) and the
     * pre-windowing behavior. It is the ONE range declaration a proofreading
     * walk reads, so a second windowed walk (the lint request, MAR-426) reads
     * this field rather than measuring a window of its own.
     */
    window: VisibleWindow | null;
    /**
     * The document `styleSet` was last computed against, or null before the
     * first pass. A window commit that lands before the first pass only records
     * the window, and the pass then builds once, for it; a commit after the
     * first pass IS the build for the blocks that arrived.
     */
    styleDoc: ProseNode | null;
    /**
     * The same, for `lintSet`: null until the first answer is drawn. The lint
     * set is built from proofread/lintCache for the window, so a window commit
     * after that draws what is already known for the blocks that arrived on
     * the frame they arrive, and the plugin view asks the host about the rest.
     */
    lintDoc: ProseNode | null;
    /**
     * Bumped when the FINDINGS change (a style or lint set arrives), never
     * when the window moves: the window changes which findings are drawn, and
     * the surfaces that list them (the review sidebar) list the whole document.
     */
    revision: number;
};

type ProofreadMeta =
    | { type: "config"; config: ProofreadConfig }
    | { type: "style"; decorations: DecorationSet }
    /** Rebuild the drawn lints for the window from what the cache knows. */
    | { type: "lints" }
    | { type: "window"; window: VisibleWindow | null };

export const proofreadPluginKey = new PluginKey<ProofreadState>("proofread");

// Fallback when the injected __i18n.proofread snapshot is missing. Every style
// check defaults ON (maintainer decision): the two noisier heuristics, `passive`
// and `negativeParallelism`, still ship on, paired with the "Turn off proofreading"
// go-clean toggle for when the underlines get in the way. Kept in sync with the
// contributed setting defaults in package.json — see
// shared/__tests__/proofreadDefaultsContributions.test.ts.
export const DEFAULT_CONFIG: ProofreadConfig = {
    proofreadingEnabled: true,
    styleCheck: true,
    fillers: true,
    redundancies: true,
    cliches: true,
    wordiness: true,
    aiVocabulary: true,
    aiArtifacts: true,
    passive: true,
    negativeParallelism: true,
    longSentences: true,
    ruleOfThree: true,
    emDash: true,
    nonAsciiPunct: true,
    absolutePerf: true,
    rhythm: true,
    styleExceptions: [],
    spellCheck: true,
    grammarCheck: true,
    userWords: [],
};

/** Phrase lists keyed by category, passed to the matcher. */
const PHRASE_LISTS = {
    fillers: FILLERS,
    redundancies: REDUNDANCIES,
    cliches: CLICHES,
    wordiness: WORDINESS,
    aiVocabulary: AI_VOCABULARY,
    aiArtifacts: AI_ARTIFACTS,
} as const;

/** Per-check enabled map, in the shape compileStyleMatcher expects. */
function enabledMap(c: ProofreadConfig): Partial<Record<StyleCategory, boolean>> {
    return {
        fillers: c.fillers,
        redundancies: c.redundancies,
        cliches: c.cliches,
        wordiness: c.wordiness,
        aiVocabulary: c.aiVocabulary,
        aiArtifacts: c.aiArtifacts,
        passive: c.passive,
        longSentences: c.longSentences,
        negativeParallelism: c.negativeParallelism,
        ruleOfThree: c.ruleOfThree,
        emDash: c.emDash,
        nonAsciiPunct: c.nonAsciiPunct,
        absolutePerf: c.absolutePerf,
        rhythm: c.rhythm,
    };
}

/**
 * Non-deletable "flag" categories — a nudge to reconsider (passive, long
 * sentence, an AI cadence), not a "delete this" strikethrough. They render as
 * an underline instead. Everything else (phrase hits, repeated words) reads as
 * "read the sentence without it" and keeps the strikethrough.
 */
const FLAG_CATEGORIES = new Set<StyleCategory>([
    "passive", "longSentences", "negativeParallelism", "ruleOfThree", "emDash", "nonAsciiPunct",
    "absolutePerf", "rhythm",
]);

/**
 * The config the plugin starts on: the defaults, the host's snapshot over
 * them, and then the two domains withdrawn that no host here can answer.
 *
 * The withdrawal is the page's and not the host's, and that is the whole point.
 * Spelling and grammar are lints the page POSTS OUT for a host engine to
 * answer; style check and the repeated-word check are computed here, from a
 * table the bundle carries. So which of the four can run is decided by
 * `spellAndGrammar`, and it is decided HERE because `hostHas` is the one reader
 * of the declaration (AGENTS.md, "One declaration, one reader").
 *
 * A host that decided this for itself, by sending its own booleans, is what
 * this replaces, and it failed in the way a second declarer always can: the
 * capability was renamed in TypeScript, the shell went on testing its old
 * spelling, and the answer became a constant that no run could see. It had
 * held the whole pass off on that surface, so the style check drew nothing and
 * the Checks menu opened with its body missing.
 *
 * Left ON, the cost is not only a dead row: the scan posts `lintBlocks` on
 * every typing pause, walking the document to build a request nothing answers.
 *
 * Exported for unit testing, as `computeDecorations` is.
 */
export function initialConfig(): ProofreadConfig {
    const declared: ProofreadConfig = {
        ...DEFAULT_CONFIG,
        ...(window.__i18n?.proofread ?? {}),
        ...fromOptionKeys(window.__i18n?.proofreadOptions),
    };
    if (hostHas("spellAndGrammar")) { return declared; }
    return { ...declared, spellCheck: false, grammarCheck: false };
}

/**
 * A host's stored Checks answers, keyed the way the MENU posts them, as config
 * fields.
 *
 * One key differs between the two vocabularies and the rest are identical, so
 * this is that alias plus a filter. The filter is the load-bearing half: a key
 * the config has no field for is dropped rather than spread in, so a stale
 * stored option from an older build cannot put a property on the config that
 * every reader of it would then have to tolerate.
 */
function fromOptionKeys(options: Record<string, boolean> | undefined): Partial<ProofreadConfig> {
    if (!options) { return {}; }
    const out: Record<string, boolean> = {};
    for (const [key, value] of Object.entries(options)) {
        if (typeof value !== "boolean") { continue; }
        // The master gate is the one whose option key and config field differ.
        const field = key === "proofreading" ? "proofreadingEnabled" : key;
        // A BOOLEAN field, not merely a field that exists: `userWords` and
        // `styleExceptions` are in the config too and are arrays, and a stored
        // `userWords: true` would otherwise reach `setUserWords`, which
        // iterates it. The store is a defaults domain somebody can edit.
        if (typeof (DEFAULT_CONFIG as Record<string, unknown>)[field] === "boolean") {
            out[field] = value;
        }
    }
    return out as Partial<ProofreadConfig>;
}

/** Notify interested UI (toolbar buttons) that the config changed. */
function emitConfigChanged(config: ProofreadConfig): void {
    window.dispatchEvent(new CustomEvent("proofread-config-changed", { detail: config }));
}

export function getProofreadConfig(view: EditorView): ProofreadConfig {
    return proofreadPluginKey.getState(view.state)?.config ?? { ...DEFAULT_CONFIG };
}

/** Apply a config change (from the toolbar toggles or a settings sync). */
export function setProofreadConfig(view: EditorView, config: ProofreadConfig): void {
    setUserWords(config.userWords);
    const meta: ProofreadMeta = { type: "config", config };
    view.dispatch(view.state.tr.setMeta(proofreadPluginKey, meta));
    emitConfigChanged(config);
}

let cachedMatcher: { key: string; matcher: StyleMatcher } | null = null;

/**
 * The matcher's answer per block TEXT: the style twin of proofread/lintCache,
 * for the same reason. One keystroke changes one block, and the matcher, which
 * is the expensive half of the pass, has no reason to run again over the rest;
 * with this, what a pass regexes is what it has not seen, so a rescan behind
 * typing costs the edit and a whole-document listing (the review sidebar's)
 * costs a walk of string lookups rather than a walk of regexes.
 *
 * Keyed by the text and nothing else, so a moved paragraph keeps its answer.
 * Cleared when the MATCHER changes (styleMatcherFor recompiles on a category
 * toggle or a new exception), because the answer is the matcher's. Suppression
 * is applied downstream, over what this returns, so an ignore or a kept phrase
 * invalidates nothing here. FIFO for the lint cache's reasons, but sized above
 * the largest document the heavy perf fixtures stand in for: a FIFO smaller
 * than the document evicts every entry before the next pass reads it, which is
 * no cache at all on exactly the document it is for. (The lint cache carries
 * the same bound for the same reason.)
 */
const STYLE_CACHE_MAX = 16384;
const styleCache = new Map<string, StyleMatch[]>();

/** Forget every remembered match. Tests, and the matcher recompile. */
export function clearStyleCache(): void {
    styleCache.clear();
}

function styleMatcherFor(config: ProofreadConfig): StyleMatcher {
    const enabled = enabledMap(config);
    const key = `${JSON.stringify(enabled)}|${config.styleExceptions.join(" ")}`;
    if (cachedMatcher?.key !== key) {
        cachedMatcher = {
            key,
            matcher: compileStyleMatcher(PHRASE_LISTS, enabled, config.styleExceptions),
        };
        clearStyleCache();
    }
    return cachedMatcher.matcher;
}

/**
 * Hover explanations, one clause each - a quiet middle ground between iA
 * (nothing) and Hemingway (popups). Each must teach the actual move, never
 * restate the category name back at the reader ("passive voice -> consider
 * active" earns its interruption only if it says what to *do* instead). These
 * strings are deliberately ASCII-clean (straight quotes, spaced hyphens, no
 * ellipsis glyph) so the proofreading copy passes its own emDash / nonAsciiPunct
 * checks - the tool eats its own dog food.
 */
function styleHitTitle(category: string): string {
    switch (category) {
        case "fillers": return t("Filler - no meaning lost if you cut it");
        case "redundancies": return t("Redundancy - one word already implies the other");
        case "cliches": return t("Cliche - say it in your own words");
        case "wordiness": return t("Wordy - fewer words say the same thing");
        case "aiVocabulary": return t("AI vocabulary - prefer a plainer, specific word");
        case "aiArtifacts": return t("AI boilerplate - delete it");
        case "passive": return t("Passive voice - lead with who acts");
        case "longSentences": return t("Long sentence - break it at a natural pause");
        case "negativeParallelism": return t("AI cadence - state Y on its own");
        case "ruleOfThree": return t("Rule of three - one precise word does more");
        case "emDash": return t("Em dash - a spaced hyphen is safer everywhere");
        case "nonAsciiPunct": return t("Curly punctuation - ASCII is more portable");
        case "absolutePerf": return t("Absolute speed claim - carry the before and after");
        case "rhythm": return t("Uniform rhythm - vary the sentence lengths");
        case "repeated": return t("Repeated word - delete one");
        default: return "";
    }
}

/** Short category chip shown in the popup (and reused for grouping). */
export function styleTag(category: string): string {
    return t(styleCategoryLabel(category));
}

/**
 * Advice-only clause for the popup body - the category chip (styleTag) already
 * names the finding, so this must NOT repeat it. Each line has to earn the
 * popup: name *why* it's flagged and *what to do*, with a concrete before/after
 * where one fits. "Consider the active voice" is the anti-pattern this replaces
 * - it told the reader nothing they didn't already see in the chip. Kept
 * ASCII-clean (straight quotes, spaced hyphens, "->" arrows) so the copy passes
 * its own emDash / nonAsciiPunct checks.
 */
export function styleAdvice(category: string): string {
    switch (category) {
        case "fillers": return t("Adds emphasis but no information - the sentence means the same without it.");
        case "redundancies": return t("One word already implies the other - keep just one.");
        case "cliches": return t("A worn phrase readers skim past - say it plainly, in your own words.");
        case "wordiness": return t("Several words doing one word's job, e.g. \"due to the fact that\" -> \"because\".");
        case "aiVocabulary": return t("Reads as LLM filler - a plainer, more specific word lands harder.");
        case "aiArtifacts": return t("Leftover chatbot phrasing - delete it so the prose sounds like you.");
        case "passive": return t("The doer is hidden or trailing - lead with who acts: \"mistakes were made\" -> \"we made mistakes\".");
        case "longSentences": return t("Past ~30 words the reader loses the thread - break it at a natural pause.");
        case "negativeParallelism": return t("A stock AI rhythm - cut the negation and state the point plainly.");
        case "ruleOfThree": return t("Three stacked adjectives read as cadence, not content - one precise word does more.");
        case "emDash": return t("An em dash renders inconsistently outside the editor - a spaced hyphen is safe everywhere.");
        case "nonAsciiPunct": return t("Curly quotes and ellipses can garble in code, terminals, and diffs - ASCII stays portable.");
        case "absolutePerf": return t("A cost gets smaller, it does not vanish, so \"no longer stalls\" cannot be checked - give the before and after figures, or say what still costs.");
        case "rhythm": return t("Every sentence here runs to about the same length, which reads as machine cadence rather than your voice - let one run long and one land short, or keep it if the evenness is deliberate.");
        case "repeated": return t("The same word appears twice in a row — delete one.");
        default: return "";
    }
}

// Deterministic ASCII replacements for the non-ASCII-punctuation flag, so the
// popup can offer a one-click normalization instead of only a nudge. Keyed by
// the single flagged glyph (see findNonAsciiPunct); zero-width marks map to ""
// (a "Remove"). Curly quotes/dashes fold to their ASCII equivalents.
const ASCII_NORMALIZATION: Record<string, string> = {
    "‘": "'", "’": "'", "“": "\"", "”": "\"",
    "…": "...",
    " ": " ", " ": " ", // nbsp, thin space → ASCII space
    "​": "", "‌": "", "‍": "", // zero-width chars → remove
};

/**
 * The auto-fix a style category offers, given its flagged text. Deletable
 * "read the sentence without it" hits (phrases, repeated words) return "" (a
 * "Remove"); em dashes and non-ASCII punctuation return a concrete ASCII
 * replacement; judgment-call flags (long sentence, passive, rule of three,
 * negative parallelism) return null — those get an explanation and Ignore only.
 */
function styleSuggestion(category: StyleCategory, flagged: string): string | null {
    switch (category) {
        case "fillers":
        case "redundancies":
        case "cliches":
        case "wordiness":
        case "aiVocabulary":
        case "aiArtifacts":
        case "repeated":
            return "";
        case "nonAsciiPunct":
            return ASCII_NORMALIZATION[flagged] ?? "";
        default:
            // emDash is resolved in computeDecorations (needs the neighbouring
            // chars); longSentences/passive/ruleOfThree/negativeParallelism/
            // absolutePerf are judgment calls with no auto-fix.
            return null;
    }
}

/**
 * The spaced-hyphen replacement for a dash glyph, matched to its context so it
 * never doubles a space: "a — b" → "a - b" and "a—b" → "a - b" both land on the
 * author's spaced-hyphen convention.
 */
function emDashReplacement(text: string, start: number, end: number): string {
    const leftSpace = text[start - 1] === " ";
    const rightSpace = text[end] === " ";
    return `${leftSpace ? "" : " "}-${rightSpace ? "" : " "}`;
}

/**
 * Flatten one textblock into plain text where offsets map 1:1 to document
 * positions (blockPos + 1 + offset): inline-code text and non-text inline nodes
 * are both masked with placeholder characters of equal size. Masking code with
 * the placeholder (not spaces) is load-bearing — a run of spaces looks to Harper
 * like real prose, so masking `birta.smartLinks` as 28 spaces made it
 * emit "There are 28 spaces where there should be only one" and underline the
 * code span. The placeholder carries no such meaning and is recognized as masked
 * content by isTechSpan / the whitespace guard in harperService. Exported for
 * unit testing.
 */
export function blockPlainText(block: ProseNode): string {
    let text = "";
    block.forEach((child) => {
        if (child.isText) {
            const isCode = child.marks.some((m) => m.type.name === "inlineCode");
            text += isCode ? INLINE_PLACEHOLDER.repeat(child.text?.length ?? 0) : (child.text ?? "");
        } else {
            text += INLINE_PLACEHOLDER.repeat(child.nodeSize);
        }
    });
    return text;
}

/**
 * Walk every textblock outside code blocks that overlaps `range`, or every one
 * in the document when `range` is null. A block is visited WHOLE when any part
 * of it overlaps, so what a block yields never depends on where a window edge
 * fell across it: a windowed pass is the whole-document pass restricted to the
 * blocks it visits, byte for byte (proofreadWindow.test.ts holds that as a
 * differential). The callback may return false to stop.
 */
function forEachTextblockIn(
    doc: ProseNode,
    range: VisibleWindow | null,
    cb: (node: ProseNode, pos: number) => void | false,
): void {
    let stopped = false;
    const visit = (node: ProseNode, pos: number): boolean => {
        if (stopped) { return false; }
        if (node.type.name === "code_block") { return false; }
        if (!node.isTextblock) { return true; }
        if (cb(node, pos) === false) { stopped = true; }
        return false; // textblocks contain no further textblocks
    };
    if (range === null) {
        doc.descendants(visit);
    } else {
        doc.nodesBetween(range.from, range.to, visit);
    }
}

/**
 * Run the style matcher over the textblocks in `range` and hand every
 * unsuppressed match to `cb` with its block's plain text (an offset maps to
 * the position base + offset). `cb` returns false to stop.
 *
 * The one place the matcher runs, so its work is counted once, here.
 * `style-scan` {blocks, chars} is how many textblocks and characters the
 * matcher RAN ON in this pass: the blocks whose text the cache had not seen,
 * the way `lint-request` counts what is asked and not what is collected. On a
 * fresh document under a window that is the window's blocks; behind a
 * keystroke it is the edited block. Neither may grow with the document, which
 * `perKeystrokeWork.test.ts` holds per keystroke and `e2e/proofreadWindow`
 * holds against the document's own block count in a real browser.
 */
function forEachStyleMatch(
    doc: ProseNode,
    config: ProofreadConfig,
    range: VisibleWindow | null,
    cb: (base: number, text: string, match: StyleMatch, flagged: string) => void | false,
): void {
    const matcher = styleMatcherFor(config);
    let blocks = 0;
    let chars = 0;
    forEachTextblockIn(doc, range, (node, pos) => {
        const text = blockPlainText(node);
        let matches = styleCache.get(text);
        if (matches === undefined) {
            matches = matcher(text);
            styleCache.set(text, matches);
            while (styleCache.size > STYLE_CACHE_MAX) {
                const oldest = styleCache.keys().next();
                if (oldest.done) { break; }
                styleCache.delete(oldest.value);
            }
            blocks++;
            chars += text.length;
        }
        const base = pos + 1;
        for (const match of matches) {
            const flagged = text.slice(match.start, match.end);
            if (isStyleSuppressed(match.category, flagged)) { continue; }
            if (cb(base, text, match, flagged) === false) { return false; }
        }
    });
    countWork("style-scan", { blocks, chars });
}

/**
 * Style-check decorations (instant, synchronous) for the textblocks in
 * `window`, or the whole document when it is null. Exported for unit testing.
 */
export function computeDecorations(
    doc: ProseNode,
    config: ProofreadConfig,
    window: VisibleWindow | null = null,
): DecorationSet {
    // Gate: nothing renders unless the master proofreading switch is on and the
    // style master is on. The repeated-word check rides on the style master, so
    // style check is meaningful even with all phrase categories turned off.
    if (!config.proofreadingEnabled || !config.styleCheck) { return DecorationSet.empty; }
    const decorations: Decoration[] = [];

    forEachStyleMatch(doc, config, window, (base, text, match, flagged) => {
        const cls = "pf-style-hit"
            + (FLAG_CATEGORIES.has(match.category) ? " pf-style-hit--flag" : "");
        const suggestion = match.category === "emDash"
            ? emDashReplacement(text, match.start, match.end)
            : styleSuggestion(match.category, flagged);
        const spec: StyleSpec = {
            class: cls,
            // Popup body = advice only (the chip names the category); the
            // hover title keeps the full "category — advice" hint.
            style: { category: match.category, message: styleAdvice(match.category), suggestion },
        };
        decorations.push(Decoration.inline(base + match.start, base + match.end,
            { class: cls, title: styleHitTitle(match.category) }, spec));
    });

    return DecorationSet.create(doc, decorations);
}

/**
 * Whether the document holds any unsuppressed style hit, stopping at the
 * first. The review sidebar's tab-visibility question, answered without
 * building a set for a document that has a hit near its top.
 */
function hasStyleHit(doc: ProseNode, config: ProofreadConfig): boolean {
    if (!config.proofreadingEnabled || !config.styleCheck) { return false; }
    let found = false;
    forEachStyleMatch(doc, config, null, () => { found = true; return false; });
    return found;
}

/** Whether a block's text is something a host is ever asked about. */
function isLintable(text: string): boolean {
    return /\p{L}/u.test(text);
}

/**
 * The block texts the host should lint, for the textblocks in `range` or the
 * whole document when it is null.
 */
function collectLintBlocks(doc: ProseNode, range: VisibleWindow | null): LintBlock[] {
    const blocks: LintBlock[] = [];
    forEachTextblockIn(doc, range, (node, pos) => {
        const text = blockPlainText(node);
        if (isLintable(text)) { blocks.push({ key: pos, text }); }
    });
    return blocks;
}

/**
 * The lint decorations for the textblocks in `range` (the whole document when
 * null), from what the cache knows about each block's CURRENT text.
 *
 * This is the only way a lint is ever drawn, and it is what makes an answer
 * impossible to draw stale: the walk is over the document as it is now, so a
 * reply keyed to positions that have since moved is remembered by text and
 * drawn here at the block's current position. A block the host has not
 * answered for draws nothing, which the plugin view repairs by asking.
 */
function lintDecorationsFromCache(
    doc: ProseNode,
    range: VisibleWindow | null,
    config: ProofreadConfig,
): DecorationSet {
    if (!lintEnabled(config)) { return DecorationSet.empty; }
    const results: LintBlockResult[] = [];
    forEachTextblockIn(doc, range, (node, pos) => {
        const lints = lookupLints(blockPlainText(node));
        if (lints !== undefined && lints.length > 0) { results.push({ key: pos, lints }); }
    });
    return buildLintDecorations(doc, results, config);
}

/**
 * The blocks the host has not already answered for, each distinct text once.
 *
 * A rescan collects the window; an edit changes one block of it. Asking the
 * host only about what it has not seen is the difference between a check that
 * scales with the window and one that scales with the edit. Exported for unit
 * testing, because it is where that whole claim lives.
 *
 * Deduplicated by text as well as filtered, so a document that repeats a line
 * asks about it once. The caller pairs the answers back onto every block by
 * text, so a block dropped here still gets its findings.
 */
export function lintBlocksToAsk(blocks: readonly LintBlock[]): LintBlock[] {
    const asking = new Set<string>();
    const fresh: LintBlock[] = [];
    for (const block of blocks) {
        if (lookupLints(block.text) !== undefined) { continue; }
        if (asking.has(block.text)) { continue; }
        asking.add(block.text);
        fresh.push(block);
    }
    return fresh;
}

/**
 * Every block's findings, from the cache, once the host's answers are in it.
 *
 * `key` is the block's position in the document the request was built against,
 * which is what `buildLintDecorations` resolves nodes by, so the result carries
 * the ORIGINAL blocks' keys rather than the asked-about subset's. A text with
 * no entry resolves to no findings rather than being dropped, so a host that
 * answers short cannot leave a block's stale decorations standing. The plugin
 * draws through `lintDecorationsFromCache` instead; this is the same pairing
 * as a pure function, for the tests that hold the cache's claims.
 */
export function resolveLintResults(blocks: readonly LintBlock[]): LintBlockResult[] {
    return blocks.map(({ key, text }) => ({ key, lints: lookupLints(text) ?? [] }));
}

/** Build decorations from Harper results (block keys are request-time positions). */
function buildLintDecorations(
    doc: ProseNode,
    results: LintBlockResult[],
    config: ProofreadConfig,
): DecorationSet {
    const decorations: Decoration[] = [];
    // Gate: the master switch silences every Harper finding at once.
    if (!config.proofreadingEnabled) { return DecorationSet.empty; }
    for (const { key, lints } of results) {
        const node = doc.nodeAt(key);
        if (!node?.isTextblock) { continue; }
        const base = key + 1;
        const blockEnd = key + node.nodeSize - 1;
        for (const lint of lints) {
            // Spelling and grammar are toggled independently (one Harper pass,
            // split by lint kind). "Spelling" is the spelling bucket; everything
            // else is grammar.
            const isSpelling = lint.kind === "Spelling";
            if (isSpelling ? !config.spellCheck : !config.grammarCheck) { continue; }
            const from = base + lint.start;
            const to = base + lint.end;
            if (to > blockEnd || from >= to) { continue; }
            const text = doc.textBetween(from, to);
            if (isLintSuppressed(lint.kind, text)) { continue; }
            const cls = isSpelling ? "pf-spell-err" : "pf-lint-err";
            const spec: LintSpec = { class: cls, lint };
            decorations.push(Decoration.inline(from, to, { class: cls, title: lint.message }, spec));
        }
    }
    return DecorationSet.create(doc, decorations);
}

/** Harper's long-sentence lint carries a word count ("… is 44 words long."). */
function isHarperLongSentence(spec: DecoSpec): boolean {
    return /\bwords long\b/i.test(spec.lint?.message ?? "");
}

/**
 * Merge the style and Harper decoration sets. Overlaps are stacked (both marks
 * render, and clicking surfaces all findings), except for the one true
 * duplicate: the webview long-sentence flag is dropped where Harper's own
 * long-sentence lint already covers it (Harper carries the word count + a
 * popup). Harper only fires above ~40 words while the webview flag starts at
 * 30, so this is an overlap test, not a blanket disable — 31–40-word sentences
 * Harper never reaches keep their flag. Exported for unit testing.
 */
export function combine(doc: ProseNode, styleSet: DecorationSet, lintSet: DecorationSet): DecorationSet {
    let style = styleSet.find();
    const lints = lintSet.find();
    if (style.length === 0) { return lintSet; }
    if (lints.length === 0) { return styleSet; }
    const harperLong = lints.filter((d) => isHarperLongSentence(d.spec as DecoSpec));
    if (harperLong.length > 0) {
        style = style.filter((d) => {
            if ((d.spec as DecoSpec).style?.category !== "longSentences") { return true; }
            return !harperLong.some((h) => d.from < h.to && d.to > h.from);
        });
    }
    return DecorationSet.create(doc, [...style, ...lints]);
}

/** Find the decoration range (+spec) of the given class at a document position. */
function decorationAt(
    view: EditorView,
    pos: number,
    className: string,
): { from: number; to: number; spec: DecoSpec } | null {
    const state = proofreadPluginKey.getState(view.state);
    if (!state) { return null; }
    const hits = state.combined
        .find(pos, pos, (spec) => ((spec as { class?: string }).class ?? "").includes(className));
    return hits.length > 0
        ? { from: hits[0].from, to: hits[0].to, spec: hits[0].spec as DecoSpec }
        : null;
}

/** Replace the flagged span with `text`. */
function replaceRange(view: EditorView, from: number, to: number, text: string): void {
    view.dispatch(view.state.tr.insertText(text, from, to));
}

/**
 * Delete the flagged span, swallowing one adjacent space so the surrounding
 * words don't collide into a double space: "is really good" → "is good", not
 * "is  good". Prefers the leading space (mid-sentence words) and falls back to
 * the trailing one (sentence-initial words). Exported for unit testing.
 */
export function deleteRange(view: EditorView, from: number, to: number): void {
    const doc = view.state.doc;
    let start = from;
    let end = to;
    if (start > 0 && doc.textBetween(start - 1, start) === " ") {
        start -= 1;
    } else if (end < doc.content.size && doc.textBetween(end, end + 1) === " ") {
        end += 1;
    }
    view.dispatch(view.state.tr.delete(start, end));
}

/** Apply a suggestion: "" deletes (space-aware), anything else replaces. */
function applySuggestion(view: EditorView, from: number, to: number, suggestion: string): void {
    if (suggestion === "") { deleteRange(view, from, to); } else { replaceRange(view, from, to, suggestion); }
}

/** Build the popup section for a Harper spelling/grammar finding. */
function lintFinding(view: EditorView, from: number, to: number, lint: HarperLint): PopupFinding {
    const word = view.state.doc.textBetween(from, to);
    const buttons: PopupButton[] = [];
    // Read-only offers no fixes (MAR-53). The finding, the explanation, Add to
    // dictionary and Ignore all stand — they are what a reader wants and none
    // of them touches the document — but a suggestion button here would apply
    // an edit the transaction filter has already refused, and a popup whose
    // headline action does nothing is worse than one that never offered it.
    for (const suggestion of isReadOnly() ? [] : lint.suggestions) {
        buttons.push({
            label: suggestion === "" ? t("Remove") : suggestion,
            run: () => applySuggestion(view, from, to, suggestion),
        });
    }
    if (lint.kind === "Spelling") {
        buttons.push({ label: t("Add to dictionary"), dismiss: true, run: () => { learnWord(word); refreshProofread(view); } });
    }
    buttons.push({ label: t("Ignore"), dismiss: true, run: () => { ignoreLintSession(lint.kind, word); refreshProofread(view); } });
    return { tag: lint.kind === "Spelling" ? t("Spelling") : t("Grammar"), message: lint.message, buttons };
}

/** Build the popup section for a style-check finding. */
function styleFinding(view: EditorView, from: number, to: number, style: StyleFinding): PopupFinding {
    const word = view.state.doc.textBetween(from, to);
    const buttons: PopupButton[] = [];
    if (style.suggestion !== null && !isReadOnly()) {
        const suggestion = style.suggestion;
        buttons.push({
            label: suggestion === "" ? t("Remove") : t("Fix"),
            run: () => applySuggestion(view, from, to, suggestion),
        });
    }
    // The protect-list gesture (MAR-236): a phrase hit can be claimed as the
    // writer's own, for good, the way a spelling hit joins the dictionary.
    // Structural hits (a whole sentence, a glyph, a paragraph's rhythm) are
    // not phrases and get the session Ignore only.
    if (isPhraseCategory(style.category)) {
        buttons.push({ label: t("Keep this phrase"), dismiss: true, run: () => { keepStylePhrase(style.category, word); refreshProofread(view); } });
    }
    buttons.push({ label: t("Ignore"), dismiss: true, run: () => { ignoreStyleSession(style.category, word); refreshProofread(view); } });
    return { tag: styleTag(style.category), message: style.message, buttons };
}

/**
 * All actionable findings (style + Harper) covering `pos`, most-specific
 * (smallest span) first — so a filler inside a long sentence lists the filler
 * above the sentence. Duplicate (from,to,tag) findings are collapsed.
 */
export function findingsAt(view: EditorView, pos: number): PopupFinding[] {
    const state = proofreadPluginKey.getState(view.state);
    if (!state) { return []; }
    const hits = state.combined.find(pos, pos)
        .filter((h) => { const s = h.spec as DecoSpec; return Boolean(s.lint || s.style); })
        .sort((a, b) => (a.to - a.from) - (b.to - b.from));
    const findings: PopupFinding[] = [];
    const seen = new Set<string>();
    for (const h of hits) {
        const spec = h.spec as DecoSpec;
        const finding = spec.lint
            ? lintFinding(view, h.from, h.to, spec.lint)
            : styleFinding(view, h.from, h.to, spec.style as StyleFinding);
        const key = `${h.from}:${h.to}:${finding.tag}`;
        if (seen.has(key)) { continue; }
        seen.add(key);
        findings.push(finding);
    }
    return findings;
}

export const proofreadPlugin = $prose(() => {
    let scanTimer: ReturnType<typeof setTimeout> | null = null;

    return new Plugin<ProofreadState>({
        key: proofreadPluginKey,
        state: {
            init: () => {
                const config = initialConfig();
                setUserWords(config.userWords);
                return {
                    config,
                    styleSet: DecorationSet.empty,
                    lintSet: DecorationSet.empty,
                    combined: DecorationSet.empty,
                    window: null,
                    styleDoc: null,
                    lintDoc: null,
                    revision: 0,
                };
            },
            apply(tr, value) {
                let { config, styleSet, lintSet, combined, window, styleDoc, lintDoc, revision } = value;
                if (tr.docChanged) {
                    styleSet = styleSet.map(tr.mapping, tr.doc);
                    lintSet = lintSet.map(tr.mapping, tr.doc);
                    combined = combined.map(tr.mapping, tr.doc);
                    // The window is measured in layout coordinates but held in
                    // document positions, so it rides the edit the way the sets
                    // do (the fold plugin's convention): an insertion above the
                    // viewport would otherwise slide the decorated band off the
                    // reader's screen until the next scroll recommit.
                    if (window) {
                        window = { from: tr.mapping.map(window.from, -1), to: tr.mapping.map(window.to, 1) };
                    }
                }
                const meta = tr.getMeta(proofreadPluginKey) as ProofreadMeta | undefined;
                if (meta?.type === "config") {
                    config = meta.config;
                } else if (meta?.type === "style") {
                    styleSet = meta.decorations;
                    styleDoc = tr.doc;
                    combined = combine(tr.doc, styleSet, lintSet);
                    revision++;
                } else if (meta?.type === "lints") {
                    lintSet = lintDecorationsFromCache(tr.doc, window, config);
                    lintDoc = tr.doc;
                    combined = combine(tr.doc, styleSet, lintSet);
                    revision++;
                } else if (meta?.type === "window") {
                    window = meta.window;
                    // After the first pass the commit IS the build for the blocks
                    // that arrived, synchronously, so a block scrolled into view
                    // is decorated on the frame the window moved: the style set
                    // computed, the lint set looked up. Before it, the window is
                    // only recorded and the pass builds once, for it. The
                    // findings did not change, so `revision` does not move.
                    if (styleDoc !== null) {
                        styleSet = computeDecorations(tr.doc, config, window);
                        styleDoc = tr.doc;
                    }
                    if (lintDoc !== null) {
                        lintSet = lintDecorationsFromCache(tr.doc, window, config);
                        lintDoc = tr.doc;
                    }
                    if (styleDoc !== null || lintDoc !== null) {
                        combined = combine(tr.doc, styleSet, lintSet);
                    }
                }
                return { config, styleSet, lintSet, combined, window, styleDoc, lintDoc, revision };
            },
        },
        props: {
            decorations(state) {
                return proofreadPluginKey.getState(state)?.combined ?? DecorationSet.empty;
            },
            handleClick(view, pos, event) {
                const target = event.target as HTMLElement | null;
                if (!target?.closest?.(".pf-style-hit, .pf-spell-err, .pf-lint-err")) { return false; }
                // One popup for every finding under the cursor — style and Harper,
                // stacked most-specific-first — so overlaps are all reachable.
                showFindingsPopup(view, pos, findingsAt(view, pos));
                return false; // still place the cursor
            },
            handleDoubleClick(view, pos) {
                // iA-style affordance: double-click selects the struck span
                const hit = decorationAt(view, pos, "pf-style-hit");
                if (!hit) { return false; }
                view.dispatch(view.state.tr.setSelection(
                    TextSelection.create(view.state.doc, hit.from, hit.to),
                ));
                return true;
            },
        },
        view(view) {
            let lastDoc: ProseNode | null = null;
            let lastConfig: ProofreadConfig | null = null;
            let destroyed = false;
            let lintRequestId = 0;
            // The blocks each open WINDOW request asked the host about, keyed
            // by request id so a reply can be matched to the request it answers
            // even after a newer one has gone out. What a reply carries is an
            // answer about TEXT, and text does not go stale: not when a newer
            // request has gone out, and not when the document has moved under
            // the positions the answer is keyed to. So every reply is
            // remembered, and what is DRAWN is never taken from a reply at all
            // but looked up for the current window over the current document
            // (`lintDecorationsFromCache`), which cannot be stale in position.
            //
            // Bounded, because a host that never answers must not accumulate
            // requests without limit. What the bound gives up: with three
            // requests open the oldest is evicted, and when its reply arrives
            // nothing is remembered from it, so its blocks are asked about again
            // the next time a window or a rescan covers them. That is the whole
            // cost, a repeated question. Nothing is drawn wrongly, because
            // nothing is drawn from a reply, and nothing on screen goes missing
            // for long, because the newest request is always the one for the
            // window the reader is on and it is never the one evicted.
            const lintRequests = new Map<number, LintBlock[]>();
            const MAX_OPEN_LINT_REQUESTS = 2;
            // The review sidebar's document-wide question, asked in slices with
            // one in flight at a time (its own slot, outside the bound above, so
            // a flick through the document cannot evict it), and the slices
            // still to send. `askReview` fills the queue; a reply sends the next.
            let reviewRequest: { id: number; blocks: LintBlock[] } | null = null;
            let reviewQueue: LintBlock[][] = [];
            // The window path's coalescing timer, and the latch that keeps it
            // closed until the first pass has asked for its own window.
            let windowLintTimer: ReturnType<typeof setTimeout> | null = null;
            let firstPassDone = false;
            // The first proofread pass is deferred off the mount/paint path and
            // run on idle AFTER the editor is visible (see below): proofreading
            // is decoration only and must never block interactivity, nor appear
            // as a jarring change the instant the user touches a ready-looking
            // editor — annotations settle in on their own. `firstPassReady` gates
            // the scan closed until that idle arm (or a deliberate config toggle)
            // opens it, so a transaction fired during mount can't run it early.
            let firstPassReady = false;
            let firstPassIdle: { cancel: () => void } | null = null;
            // One-shot latch for the launch-time `proofread` measure below.
            let firstScanMarked = false;
            // Rolling window for the repeating `proofread-rescan` measure, in
            // the `instrumentTransactions` tradition: rescans fire at most once
            // per debounce pause, so 1000 is hours of editing, but a long-lived
            // tab must not retain one PerformanceMeasure per pause forever.
            let sinceClearRescan = 0;

            /** Draw the window's lints from what is now known. */
            const redrawLints = () => {
                if (destroyed || view.isDestroyed) { return; }
                if (!proofreadPluginKey.getState(view.state)) { return; }
                const meta: ProofreadMeta = { type: "lints" };
                view.dispatch(view.state.tr.setMeta(proofreadPluginKey, meta));
            };

            /**
             * Hand `blocks` to the host under a fresh id. How much this hands
             * across the boundary is counted here, as blocks and characters:
             * the host's checker is not free and is not always on a spare
             * thread, so this number IS the cost. Per keystroke it must not
             * grow with the document (`perKeystrokeWork.test.ts`), and over a
             * mount it must not grow past a small multiple of the screen
             * (`e2e/proofreadWindow`, and the nightly heavy-fixture gate).
             */
            const post = (blocks: LintBlock[]): number => {
                lintRequestId++;
                countWork("lint-request", {
                    blocks: blocks.length,
                    chars: blocks.reduce((n, b) => n + b.text.length, 0),
                });
                notifyLintBlocks(lintRequestId, blocks);
                return lintRequestId;
            };

            /**
             * Ask the host about the blocks in `range` it has not answered for.
             * Returns whether anything was asked; when nothing was, every block
             * in the range is already known and the caller decides whether a
             * redraw is owed (the first pass) or has already happened (a window
             * commit, which drew from the cache in `apply`).
             */
            const askAbout = (range: VisibleWindow | null): boolean => {
                const asking = lintBlocksToAsk(collectLintBlocks(view.state.doc, range));
                if (asking.length === 0) {
                    countWork("lint-request", { blocks: 0, chars: 0 });
                    return false;
                }
                lintRequests.set(post(asking), asking);
                // Oldest first, so what is dropped is the request least likely
                // to still be answered.
                while (lintRequests.size > MAX_OPEN_LINT_REQUESTS) {
                    const oldest = lintRequests.keys().next();
                    if (oldest.done) { break; }
                    lintRequests.delete(oldest.value);
                }
                return true;
            };

            const sendNextReviewSlice = () => {
                if (reviewRequest !== null) { return; }
                const slice = reviewQueue.shift();
                if (!slice) { return; }
                reviewRequest = { id: post(slice), blocks: slice };
            };

            currentReviewer = (unknown) => {
                if (destroyed || view.isDestroyed) { return; }
                // What an open request is already asking about is left to it.
                const inFlight = new Set<string>();
                for (const blocks of lintRequests.values()) {
                    for (const b of blocks) { inFlight.add(b.text); }
                }
                for (const b of reviewRequest?.blocks ?? []) { inFlight.add(b.text); }
                reviewQueue = sliceByChars(
                    unknown.filter((b) => !inFlight.has(b.text)).map(({ key, text }) => ({ key, text })),
                    REVIEW_SLICE_CHARS,
                );
                sendNextReviewSlice();
            };

            currentApplier = (id, results) => {
                if (destroyed || view.isDestroyed) { return; }
                let asked = lintRequests.get(id);
                if (asked) {
                    lintRequests.delete(id);
                } else if (reviewRequest?.id === id) {
                    asked = reviewRequest.blocks;
                    reviewRequest = null;
                }
                // No open request under this id: one this view never made, one
                // already answered (the entry is deleted above, so a duplicate
                // reply lands here), or one the bound dropped.
                if (!asked) { return; }
                // Remembered by text, whatever has happened to the positions
                // since. Discarding a reply because the document moved on is
                // how a person who opens a long note and types before the
                // annotations settle would pay for the same check twice.
                const askedText = new Map(asked.map((b) => [b.key, b.text]));
                for (const { key, lints } of results) {
                    const text = askedText.get(key);
                    if (text !== undefined) { rememberLints(text, lints); }
                }
                sendNextReviewSlice();
                // Drawn for the window the reader is on now, over the document
                // as it is now. A reply the reader has scrolled away from still
                // moves `revision`, which is what tells the review sidebar its
                // document-wide list has more to show.
                redrawLints();
            };

            // MAR-425: the style decorations are built for the scroll window,
            // measured by the same observer the fold gutter and the line numbers
            // each hold an instance of (plugins/visibleRange.ts). Inert until
            // start(), which the first pass calls rather than view(): a window
            // arriving before first paint would pull the decorations' DOM in
            // front of the paint mark, and the pass already sits in the
            // post-paint idle window. Starting it from the pass is also what
            // keeps a disabled feature at zero cost: no listener and no
            // measurement until a check is on and a pass runs.
            const visibleWindow = observeVisibleWindow(view, (next) => {
                if (destroyed || view.isDestroyed) { return; }
                const meta: ProofreadMeta = { type: "window", window: next };
                view.dispatch(view.state.tr.setMeta(proofreadPluginKey, meta).setMeta("addToHistory", false));
            });

            const scan = () => {
                scanTimer = null;
                if (destroyed || view.isDestroyed) { return; }
                if (!firstPassReady) { return; } // gated until the idle arm (or a config toggle)
                if (view.composing) { schedule(); return; } // don't disturb IME composition
                if (!proofreadPluginKey.getState(view.state)) { return; }
                // The trackers first, so the window commit's own transaction
                // (dispatched synchronously by start() on the first call) is not
                // read by maybeSchedule as a config change still to be scanned.
                lastDoc = view.state.doc;
                lastConfig = proofreadPluginKey.getState(view.state)!.config;

                // The FIRST completed scan is the launch-time cost: the windowed
                // style walk and lint collection, the decoration build and its
                // dispatch, landing on the frames just after first
                // paint where no launch span reaches. Marked once so `pnpm perf`
                // can attribute it — but the span only means anything if the
                // harness's fixtures actually trip checks (MAR-310); a pass that
                // finds nothing measures the cheap half.
                const firstPass = !firstScanMarked;
                if (firstPass) { firstScanMarked = true; mark("proofread-start"); }
                // Every LATER completed scan stamps `proofread-rescan` instead:
                // the debounced rescan behind typing. It sits outside `tx-apply`
                // (it is not a keystroke's dispatch), so without its own span
                // the only instrument that sees it is `block`, which is reported
                // and never gated (MAR-314). A separate name keeps the
                // launch-time `proofread` measure meaning exactly "the first
                // pass" for `pnpm perf`.
                const scanStart = performance.now();

                // Synchronous on the first call, inside the span above so the
                // window's own measurement is part of the first pass's cost, and
                // the state read next already holds the window: the pass builds
                // once, for it. A no-op on every later call.
                visibleWindow.start();
                const state = proofreadPluginKey.getState(view.state)!;

                const styleDecos = computeDecorations(view.state.doc, state.config, state.window);
                if (styleDecos !== DecorationSet.empty || state.styleSet !== DecorationSet.empty) {
                    const meta: ProofreadMeta = { type: "style", decorations: styleDecos };
                    view.dispatch(view.state.tr.setMeta(proofreadPluginKey, meta));
                }

                if (lintEnabled(state.config)) {
                    // The window's blocks, and only the ones the host has not
                    // answered for. Nothing new to ask about means the answer is
                    // already known, so it is drawn here rather than after a
                    // round trip: the path a rescan takes when an edit only moved
                    // text, and the path every block but one takes when it did
                    // not. A pending window request is cancelled, because this
                    // just asked for the same window.
                    if (windowLintTimer !== null) { clearTimeout(windowLintTimer); windowLintTimer = null; }
                    if (!askAbout(state.window)) { redrawLints(); }
                } else if (state.lintSet !== DecorationSet.empty) {
                    redrawLints(); // rebuilds under the gate, which is empty
                }
                firstPassDone = true;

                if (firstPass) {
                    mark("proofread-end");
                    measure("proofread", "proofread-start", "proofread-end");
                } else {
                    if (++sinceClearRescan > 1000) {
                        clearMeasures("proofread-rescan");
                        sinceClearRescan = 1;
                    }
                    measureSpan("proofread-rescan", scanStart, performance.now());
                }
            };

            const schedule = (delay = SCAN_DEBOUNCE_MS) => {
                if (scanTimer !== null) { clearTimeout(scanTimer); }
                scanTimer = setTimeout(scan, delay);
            };

            // The window moved: what is known for the blocks that arrived was
            // drawn in `apply`; ask the host about the rest, coalesced so a
            // flick asks once, where it lands. Not the scan, on purpose: that
            // recomputes and re-dispatches the style set (moving `revision`,
            // which the sidebar reads as new findings) and stamps the rescan
            // measure the typing harness attributes to edits.
            const scheduleWindowLint = () => {
                if (windowLintTimer !== null) { clearTimeout(windowLintTimer); }
                windowLintTimer = setTimeout(() => {
                    windowLintTimer = null;
                    if (destroyed || view.isDestroyed) { return; }
                    const state = proofreadPluginKey.getState(view.state);
                    if (!state || !lintEnabled(state.config)) { return; }
                    askAbout(state.window);
                }, WINDOW_LINT_DELAY_MS);
            };

            const maybeSchedule = () => {
                const state = proofreadPluginKey.getState(view.state);
                if (!state) { return; }
                if (state.config !== lastConfig) {
                    firstPassReady = true; // a deliberate config toggle runs immediately
                    schedule(0); // config toggles should feel instant
                } else if (view.state.doc !== lastDoc) {
                    hideLintPopup(); // edits invalidate the popup's captured range
                    schedule();
                }
            };

            // Seed the trackers to the opened document's state so pre-interaction
            // transactions (plugin normalizations) don't read as a config change
            // and slip past the interaction gate.
            lastDoc = view.state.doc;
            lastConfig = proofreadPluginKey.getState(view.state)?.config ?? null;
            emitConfigChanged(proofreadPluginKey.getState(view.state)?.config ?? { ...DEFAULT_CONFIG });
            // Arm the first pass on idle, after the editor has painted — so
            // annotations settle in without blocking mount or reacting to the
            // user's first touch. Skipped entirely when every check is off: a
            // fully-disabled feature schedules nothing, walks nothing, and never
            // loads the grammar engine. Enabling a check later runs it via the
            // config-change path in maybeSchedule.
            if (lastConfig && anyProofreadEnabled(lastConfig)) {
                firstPassIdle = requestIdle(() => {
                    firstPassReady = true;
                    schedule(0);
                }, FIRST_PASS_IDLE_TIMEOUT_MS);
            }

            // The review sidebar's Proofreading tab is refreshed SOLELY by this
            // event (it does not ride the ToC's per-frame doc-change path, whose
            // O(findings) re-read grows with the document). It must therefore
            // fire whenever the findings actually change — async Harper results,
            // style rescans, ignore/learn rebuilds — all of which land as meta
            // transactions that bump `revision` WITHOUT changing the document.
            // Plain typing only remaps the sets and a scroll only moves the
            // window; neither moves `revision`, so neither reaches this path.
            let lastRevision = proofreadPluginKey.getState(view.state)?.revision ?? 0;
            return {
                update(_view, prevState) {
                    maybeSchedule();
                    const state = proofreadPluginKey.getState(view.state);
                    const revision = state?.revision ?? 0;
                    if (revision !== lastRevision) {
                        window.dispatchEvent(new CustomEvent(PROOFREAD_FINDINGS_CHANGED));
                    }
                    lastRevision = revision;
                    // A window COMMIT, told from the window riding an edit by the
                    // document: an edit maps the window to a new object and
                    // changes the document, a commit changes only the window.
                    // Closed until the first pass has asked for its own window,
                    // which the pass commits synchronously on its way in.
                    if (firstPassDone && state && view.state.doc === prevState.doc
                        && state.window !== proofreadPluginKey.getState(prevState)?.window) {
                        scheduleWindowLint();
                    }
                },
                destroy() {
                    destroyed = true;
                    currentApplier = null;
                    currentReviewer = null;
                    visibleWindow.destroy();
                    firstPassIdle?.cancel();
                    hideLintPopup();
                    if (scanTimer !== null) { clearTimeout(scanTimer); }
                    if (windowLintTimer !== null) { clearTimeout(windowLintTimer); }
                },
            };
        },
    });
});

/**
 * Window event the review sidebar's Proofreading tab listens for: the live
 * decoration set changed in a way the doc-change refresh path won't catch
 * (async Harper results, or an ignore/learn rebuild). See the plugin's `update`
 * hook for why it never fires on ordinary typing.
 */
export const PROOFREAD_FINDINGS_CHANGED = "proofread-findings-changed";

/**
 * A proofreading finding resolved to what the review list shows — text, chip,
 * advice — minus the view-bound actions. `kind` is the lint kind ("Spelling",
 * "Grammar", …) or the style category; it is both the dedupe discriminator and
 * what routes the Ignore/Learn action, so a spelling and a style hit on the same
 * span neither collapse into one nor share an action.
 */
export interface ProofreadFinding {
    from: number;
    to: number;
    domain: "spelling" | "grammar" | "style";
    /** Short category chip. */
    tag: string;
    /** The flagged text. */
    text: string;
    /** One-clause explanation. */
    message: string;
    /** Spelling only: offer "Add to dictionary". */
    canLearn: boolean;
    /** Lint kind or style category — the dedupe key and action routing. */
    kind: string;
}

/** One row for the Proofreading review list: a finding plus its view-bound actions. */
export interface ProofreadFindingRow extends ProofreadFinding {
    /** Session-ignore this finding, then rebuild the decoration set. */
    ignore: () => void;
    /** Spelling only: add the word to the dictionary, then rebuild. */
    learn?: () => void;
}

/**
 * Resolve a proofreading decoration set into the review list's findings —
 * document order (narrowest span first at a shared start, as the popup picker
 * does), duplicates sharing a (from, to, kind) identity collapsed. PURE: no
 * view or plugin-state access — the flagged text arrives via `getText` — so the
 * risky ordering / dedup / routing is unit-testable against a hand-built
 * DecorationSet. `listProofreadFindings` is the thin wrapper that binds the
 * ignore/learn actions to a live view.
 */
export function describeFindings(
    combined: DecorationSet,
    getText: (from: number, to: number) => string,
): ProofreadFinding[] {
    const hits = combined
        .find()
        .filter((h) => { const s = h.spec as DecoSpec; return Boolean(s.lint || s.style); })
        .sort((a, b) => a.from - b.from || (a.to - a.from) - (b.to - b.from));
    const findings: ProofreadFinding[] = [];
    const seen = new Set<string>();
    for (const h of hits) {
        const spec = h.spec as DecoSpec;
        const kind = spec.lint ? spec.lint.kind : spec.style!.category;
        const key = `${h.from}:${h.to}:${kind}`;
        if (seen.has(key)) { continue; }
        seen.add(key);
        const text = getText(h.from, h.to);
        if (spec.lint) {
            const isSpelling = spec.lint.kind === "Spelling";
            findings.push({
                from: h.from, to: h.to,
                domain: isSpelling ? "spelling" : "grammar",
                tag: isSpelling ? t("Spelling") : t("Grammar"),
                text, message: spec.lint.message, canLearn: isSpelling, kind,
            });
        } else {
            const style = spec.style!;
            findings.push({
                from: h.from, to: h.to, domain: "style",
                tag: styleTag(style.category), text, message: style.message,
                canLearn: false, kind,
            });
        }
    }
    return findings;
}

/**
 * The style set for the WHOLE document, for the surfaces that list findings
 * rather than draw them: the review sidebar's Proofreading tab, and whether
 * that tab is shown at all. The plugin's own set is windowed (MAR-425), and a
 * list that shrank as the reader scrolled would be a defect, so those two read
 * this instead. Memoized on the document, the config and the suppression
 * epoch, so a sidebar that is open costs one walk per edit pause rather than
 * one per event; it is computed only when a sidebar asks, never on the mount
 * path, a keystroke or a scroll. The walk itself is over every block, but the
 * matcher runs only on the blocks the style cache has not seen, so behind an
 * edit it regexes the edited block and looks the rest up.
 */
let documentStyle: {
    doc: ProseNode;
    config: ProofreadConfig;
    epoch: number;
    set: DecorationSet;
} | null = null;

/** Bumped by every suppression change (ignore, keep, learn): part of the memo's key. */
let suppressionEpoch = 0;

function documentStyleMemo(view: EditorView, config: ProofreadConfig): DecorationSet | null {
    const memo = documentStyle;
    return memo && memo.doc === view.state.doc && memo.config === config && memo.epoch === suppressionEpoch
        ? memo.set
        : null;
}

function documentStyleSet(view: EditorView, config: ProofreadConfig): DecorationSet {
    const memoized = documentStyleMemo(view, config);
    if (memoized) { return memoized; }
    const set = computeDecorations(view.state.doc, config, null);
    documentStyle = { doc: view.state.doc, config, epoch: suppressionEpoch, set };
    return set;
}

function anyFinding(set: DecorationSet): boolean {
    return set.find().some((h) => {
        const s = h.spec as DecoSpec;
        return Boolean(s.lint || s.style);
    });
}

/** A block no host has been asked about, as the review's request and its position. */
type UnknownBlock = LintBlock & { end: number };

/**
 * The lint twin of the style memo: the document-wide lint set for the
 * surfaces that list findings, built from the cache, and the blocks the cache
 * has no answer for, which are what listing the document has to ask about.
 * Keyed on the cache's generation as well, because answers arrive without the
 * document changing.
 */
let documentLint: {
    doc: ProseNode;
    config: ProofreadConfig;
    epoch: number;
    generation: number;
    set: DecorationSet;
    unknown: UnknownBlock[];
} | null = null;

const NO_REVIEW = { set: DecorationSet.empty, unknown: [] as UnknownBlock[] };

function documentLintReview(view: EditorView, config: ProofreadConfig): { set: DecorationSet; unknown: UnknownBlock[] } {
    if (!lintEnabled(config)) { return NO_REVIEW; }
    const memo = documentLint;
    if (memo && memo.doc === view.state.doc && memo.config === config
        && memo.epoch === suppressionEpoch && memo.generation === lintCacheGeneration()) {
        return memo;
    }
    const doc = view.state.doc;
    const results: LintBlockResult[] = [];
    const unknown: UnknownBlock[] = [];
    const seen = new Set<string>();
    forEachTextblockIn(doc, null, (node, pos) => {
        const text = blockPlainText(node);
        if (!isLintable(text)) { return; }
        const lints = lookupLints(text);
        if (lints === undefined) {
            if (!seen.has(text)) {
                seen.add(text);
                unknown.push({ key: pos, end: pos + node.nodeSize, text });
            }
        } else if (lints.length > 0) {
            results.push({ key: pos, lints });
        }
    });
    const set = buildLintDecorations(doc, results, config);
    documentLint = { doc, config, epoch: suppressionEpoch, generation: lintCacheGeneration(), set, unknown };
    return documentLint;
}

/**
 * Whether a textblock wholly outside `w` is one no host has been asked about,
 * stopping at the first. Blocks that overlap the window are the plugin's own
 * to ask about and are not counted.
 */
function hasUnaskedOutside(doc: ProseNode, w: VisibleWindow): boolean {
    let found = false;
    const probe = (node: ProseNode, pos: number): void | false => {
        if (pos + node.nodeSize > w.from && pos < w.to) { return; } // overlaps the window
        const text = blockPlainText(node);
        if (isLintable(text) && lookupLints(text) === undefined) { found = true; return false; }
    };
    if (w.from > 0) { forEachTextblockIn(doc, { from: 0, to: w.from }, probe); }
    if (!found && w.to < doc.content.size) { forEachTextblockIn(doc, { from: w.to, to: doc.content.size }, probe); }
    return found;
}

/**
 * Whether any proofreading finding is live in the DOCUMENT — the review
 * sidebar's tab-visibility check. Cheapest answer first: a finding already
 * built (a lint or a style hit in the window) says yes without a walk, and the
 * memos answer when they are fresh. Only a document with no built finding is
 * walked, each probe stopping at its first hit; one with none has then been
 * walked whole, which is the empty set, so the memos are filled from it.
 *
 * A block outside the window that no host has been asked about is an answer
 * of "not yet" rather than "no", and it counts as yes: the tab is the one
 * surface that asks for the rest of the document, so hiding it on the strength
 * of blocks nobody has looked at would make the document-wide review
 * unreachable on exactly the documents it is for. Blocks inside the window
 * are being asked about by the plugin itself and do not count, so a note that
 * fits its window shows the tab only once a finding is known, as before. It
 * is asked before the walks because on a long document it is answered at the
 * window's edge, and it is what makes the walks below rare there.
 */
export function hasProofreadFindings(view: EditorView): boolean {
    const state = proofreadPluginKey.getState(view.state);
    if (!state) { return false; }
    if (anyFinding(state.lintSet) || anyFinding(state.styleSet)) { return true; }
    const w = state.window;
    if (w !== null && lintEnabled(state.config) && hasUnaskedOutside(view.state.doc, w)) { return true; }
    const memoized = documentStyleMemo(view, state.config);
    if (memoized ? anyFinding(memoized) : hasStyleHit(view.state.doc, state.config)) { return true; }
    if (!memoized) {
        documentStyle = { doc: view.state.doc, config: state.config, epoch: suppressionEpoch, set: DecorationSet.empty };
    }
    return anyFinding(documentLintReview(view, state.config).set);
}

/**
 * Every live proofreading finding (style + Harper spelling/grammar) in the
 * whole document, document-ordered, resolved to what the review sidebar needs
 * plus the same Ignore/Learn actions the in-text popup offers. Both halves are
 * the whole-document memos above rather than the plugin's windowed sets (the
 * pure core is describeFindings).
 *
 * Listing the document is the one thing that wants the whole document's lint
 * answer, so asking for what no host has been asked about yet is part of
 * listing it: the blocks are handed to the plugin view, which asks in slices,
 * and each answer moves `revision`, which is what brings the list back here
 * until nothing is unknown. A block never scrolled to and never listed is
 * never asked about.
 */
export function listProofreadFindings(view: EditorView): ProofreadFindingRow[] {
    const state = proofreadPluginKey.getState(view.state);
    if (!state) { return []; }
    const review = documentLintReview(view, state.config);
    if (review.unknown.length > 0) { currentReviewer?.(review.unknown); }
    const combined = combine(view.state.doc, documentStyleSet(view, state.config), review.set);
    return describeFindings(combined, (from, to) => view.state.doc.textBetween(from, to)).map((f) => ({
        ...f,
        ignore: () => {
            if (f.domain === "style") { ignoreStyleSession(f.kind as StyleCategory, f.text); }
            else { ignoreLintSession(f.kind, f.text); }
            refreshProofread(view);
        },
        learn: f.canLearn ? () => { learnWord(f.text); refreshProofread(view); } : undefined,
    }));
}

/** The active view's lint-result applier (rebound on editor recreation). */
let currentApplier: ((id: number, results: LintBlockResult[]) => void) | null = null;

/**
 * The active view's taker of the review sidebar's document-wide question: the
 * blocks no host has answered for, which it asks about in slices.
 */
let currentReviewer: ((unknown: readonly LintBlock[]) => void) | null = null;

/**
 * Cut `blocks` into runs of at most `budget` characters, in order. A block
 * longer than the budget is a run of its own, because a block is the smallest
 * thing a host can be asked about and a budget that refused one would never
 * finish. Exported for unit testing.
 */
export function sliceByChars(blocks: readonly LintBlock[], budget: number): LintBlock[][] {
    const slices: LintBlock[][] = [];
    let slice: LintBlock[] = [];
    let spent = 0;
    for (const block of blocks) {
        if (slice.length > 0 && spent + block.text.length > budget) {
            slices.push(slice);
            slice = [];
            spent = 0;
        }
        slice.push(block);
        spent += block.text.length;
    }
    if (slice.length > 0) { slices.push(slice); }
    return slices;
}

/** Entry point for lintResults messages from the extension host. */
export function applyLintResults(id: number, results: LintBlockResult[]): void {
    currentApplier?.(id, results);
}

/** Force a style rescan and lint re-request (e.g. after dictionary changes). */
export function refreshProofread(view: EditorView): void {
    const state = proofreadPluginKey.getState(view.state);
    if (!state) { return; }
    suppressionEpoch++;
    const meta: ProofreadMeta = {
        type: "style",
        decorations: computeDecorations(view.state.doc, state.config, state.window),
    };
    view.dispatch(view.state.tr.setMeta(proofreadPluginKey, meta));
    // The lints likewise: rebuilt for the window from what is known, under the
    // suppressions as they now stand, so an ignored finding is gone at once.
    const lintMeta: ProofreadMeta = { type: "lints" };
    view.dispatch(view.state.tr.setMeta(proofreadPluginKey, lintMeta));
}
