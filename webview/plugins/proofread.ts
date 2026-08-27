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
 * The whole document is rescanned on a debounce after edits. Code blocks,
 * inline code, and tech-like tokens are excluded.
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
import { compileStyleMatcher, isPhraseCategory, type StyleCategory, type StyleMatcher } from "../utils/styleMatcher";
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
import { lookupLints, rememberLints } from "../proofread/lintCache";
import { hideLintPopup, showFindingsPopup, type PopupButton, type PopupFinding } from "../proofread/popup";
import { notifyLintBlocks } from "../messaging";
import { requestIdle } from "../utils/idle";
import { clearMeasures, countWork, mark, measure, measureSpan } from "../perf";
import { t } from "../i18n";

const SCAN_DEBOUNCE_MS = 350;
// Upper bound on how long after first paint the initial proofread pass may wait
// for an idle window before it runs anyway.
const FIRST_PASS_IDLE_TIMEOUT_MS = 1000;

/**
 * True when proofreading is active: the master gate is on AND at least one
 * domain check is on. Gate off (or every domain off) ⇒ the plugin does no work.
 */
function anyProofreadEnabled(c: ProofreadConfig): boolean {
    return c.proofreadingEnabled && (c.styleCheck || c.spellCheck || c.grammarCheck);
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
};

type ProofreadMeta =
    | { type: "config"; config: ProofreadConfig }
    | { type: "style"; decorations: DecorationSet }
    | { type: "lints"; decorations: DecorationSet };

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

function styleMatcherFor(config: ProofreadConfig): StyleMatcher {
    const enabled = enabledMap(config);
    const key = `${JSON.stringify(enabled)}|${config.styleExceptions.join(" ")}`;
    if (cachedMatcher?.key !== key) {
        cachedMatcher = {
            key,
            matcher: compileStyleMatcher(PHRASE_LISTS, enabled, config.styleExceptions),
        };
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

/** Walk every textblock outside code blocks. */
function forEachTextblock(doc: ProseNode, cb: (node: ProseNode, pos: number) => void): void {
    doc.descendants((node, pos) => {
        if (node.type.name === "code_block") { return false; }
        if (!node.isTextblock) { return true; }
        cb(node, pos);
        return false; // textblocks contain no further textblocks
    });
}

/** Style-check decorations (instant, synchronous). Exported for unit testing. */
export function computeDecorations(doc: ProseNode, config: ProofreadConfig): DecorationSet {
    // Gate: nothing renders unless the master proofreading switch is on and the
    // style master is on. The repeated-word check rides on the style master, so
    // style check is meaningful even with all phrase categories turned off.
    if (!config.proofreadingEnabled || !config.styleCheck) { return DecorationSet.empty; }
    const matcher = styleMatcherFor(config);
    const decorations: Decoration[] = [];

    forEachTextblock(doc, (node, pos) => {
        const text = blockPlainText(node);
        const base = pos + 1;
        for (const match of matcher(text)) {
            const flagged = text.slice(match.start, match.end);
            if (isStyleSuppressed(match.category, flagged)) { continue; }
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
        }
    });

    return DecorationSet.create(doc, decorations);
}

/** Collect the block texts Harper should lint. */
function collectLintBlocks(doc: ProseNode): LintBlock[] {
    const blocks: LintBlock[] = [];
    forEachTextblock(doc, (node, pos) => {
        const text = blockPlainText(node);
        if (/\p{L}/u.test(text)) { blocks.push({ key: pos, text }); }
    });
    return blocks;
}

/**
 * The blocks the host has not already answered for, each distinct text once.
 *
 * A rescan collects the whole document; an edit changes one block of it. Asking
 * the host only about what it has not seen is the difference between a check
 * that scales with the document and one that scales with the edit. Exported for
 * unit testing, because it is where that whole claim lives.
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
 * answers short cannot leave a block's stale decorations standing.
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
                };
            },
            apply(tr, value) {
                let { config, styleSet, lintSet, combined } = value;
                if (tr.docChanged) {
                    styleSet = styleSet.map(tr.mapping, tr.doc);
                    lintSet = lintSet.map(tr.mapping, tr.doc);
                    combined = combined.map(tr.mapping, tr.doc);
                }
                const meta = tr.getMeta(proofreadPluginKey) as ProofreadMeta | undefined;
                if (meta?.type === "config") {
                    config = meta.config;
                } else if (meta?.type === "style") {
                    styleSet = meta.decorations;
                    combined = combine(tr.doc, styleSet, lintSet);
                } else if (meta?.type === "lints") {
                    lintSet = meta.decorations;
                    combined = combine(tr.doc, styleSet, lintSet);
                }
                return { config, styleSet, lintSet, combined };
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
            let lintRequestDoc: ProseNode | null = null;
            // Every block of the document the open request was built against,
            // not the subset the host was asked about: the answer has to be
            // rebuilt for the whole document, or the blocks left out of the
            // request would lose their decorations for having been unchanged.
            // Keyed by request id rather than held as one list, so a reply can
            // be matched to the request it answers even after a newer one has
            // gone out. A reply the page can no longer DRAW from still carries
            // findings worth keeping, and dropping those is what makes the next
            // scan ask the host the same whole-document question again.
            //
            // Bounded, because a host that never answers must not accumulate a
            // copy of the document per request.
            //
            // What the bound gives up, stated because two is not "enough" in
            // general: with three requests open, the oldest is evicted and its
            // reply's findings are discarded and asked for again. Nothing is
            // drawn wrongly by that, and the reason is worth keeping: every
            // request asks about everything not already cached, so a later
            // request's blocks are a superset of an evicted one's, and the id
            // being DRAWN from is always the newest, which is never the one
            // evicted. So the cost of the bound is a repeated question, never a
            // wrong or missing decoration.
            const lintRequests = new Map<number, LintBlock[]>();
            const MAX_OPEN_LINT_REQUESTS = 2;
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

            currentApplier = (id, results) => {
                if (destroyed || view.isDestroyed) { return; }
                const asked = lintRequests.get(id);
                // No open request under this id: one this view never made, one
                // already answered (the entry is deleted below, so a duplicate
                // reply lands here), or one the bound above dropped.
                if (!asked) { return; }
                lintRequests.delete(id);
                // The findings are kept FIRST, before either staleness check
                // below, and that order is the point rather than an accident.
                // What the host sent back is an answer about TEXT, and text does
                // not go stale: not when a newer request has gone out, and not
                // when the document has moved under the positions the answer is
                // keyed to. Only the POSITIONS go stale. Discarding a whole
                // reply for either reason is how a person who opens a long note
                // and types before the annotations settle pays for the same
                // whole-document check twice.
                const askedText = new Map(asked.map((b) => [b.key, b.text]));
                for (const { key, lints } of results) {
                    const text = askedText.get(key);
                    if (text !== undefined) { rememberLints(text, lints); }
                }
                // Positions ARE stale in both cases, so nothing is drawn from
                // them; the pending rescan rebuilds, and now finds these answers
                // already known.
                if (id !== lintRequestId) { return; }
                if (view.state.doc !== lintRequestDoc) { return; }
                const cfg = proofreadPluginKey.getState(view.state)?.config;
                const meta: ProofreadMeta = {
                    type: "lints",
                    decorations: cfg
                        ? buildLintDecorations(view.state.doc,
                                               resolveLintResults(asked), cfg)
                        : DecorationSet.empty,
                };
                view.dispatch(view.state.tr.setMeta(proofreadPluginKey, meta));
            };

            const scan = () => {
                scanTimer = null;
                if (destroyed || view.isDestroyed) { return; }
                if (!firstPassReady) { return; } // gated until the idle arm (or a config toggle)
                if (view.composing) { schedule(); return; } // don't disturb IME composition
                const state = proofreadPluginKey.getState(view.state);
                if (!state) { return; }
                lastDoc = view.state.doc;
                lastConfig = state.config;

                // The FIRST completed scan is the launch-time cost: a whole-document
                // walk plus the decoration build and its dispatch, landing on the
                // frames just after first paint where no launch span reaches. Marked
                // once so `pnpm perf` can attribute it — but the span only means
                // anything if the harness's fixtures actually trip checks
                // (MAR-310); a pass that finds nothing measures the cheap half.
                const firstPass = !firstScanMarked;
                if (firstPass) { firstScanMarked = true; mark("proofread-start"); }
                // Every LATER completed scan stamps `proofread-rescan` instead:
                // the debounced whole-document rescan behind typing. It sits
                // outside `tx-apply` (it is not a keystroke's dispatch), so
                // without its own span the only instrument that sees it is
                // `block`, which is reported and never gated (MAR-314). A
                // separate name keeps the launch-time `proofread` measure
                // meaning exactly "the first pass" for `pnpm perf`.
                const scanStart = performance.now();

                const styleDecos = computeDecorations(view.state.doc, state.config);
                if (styleDecos !== DecorationSet.empty || state.styleSet !== DecorationSet.empty) {
                    const meta: ProofreadMeta = { type: "style", decorations: styleDecos };
                    view.dispatch(view.state.tr.setMeta(proofreadPluginKey, meta));
                }

                if (state.config.proofreadingEnabled && (state.config.spellCheck || state.config.grammarCheck)) {
                    lintRequestId++;
                    lintRequestDoc = view.state.doc;
                    const requested = collectLintBlocks(view.state.doc);
                    lintRequests.set(lintRequestId, requested);
                    // Oldest first, so what is dropped is the request least
                    // likely to still be answered.
                    while (lintRequests.size > MAX_OPEN_LINT_REQUESTS) {
                        const oldest = lintRequests.keys().next();
                        if (oldest.done) { break; }
                        lintRequests.delete(oldest.value);
                    }
                    const asking = lintBlocksToAsk(requested);
                    // How much this rescan is about to hand across the host
                    // boundary, as a count. The host's checker is not free and
                    // is not always on a spare thread, so this number IS the
                    // cost, and it must not grow with the document when the edit
                    // did not (`webview/__tests__/perKeystrokeWork.test.ts`).
                    countWork("lint-request", {
                        blocks: asking.length,
                        chars: asking.reduce((n, b) => n + b.text.length, 0),
                    });
                    // Nothing new to ask about: the answer is already known, so
                    // it is applied here rather than after a round trip the host
                    // would spend a whole-document check answering. This is the
                    // path a rescan takes when an edit only moved text, and the
                    // path every block but one takes when it did not.
                    if (asking.length === 0) {
                        currentApplier?.(lintRequestId, []);
                    } else {
                        notifyLintBlocks(lintRequestId, asking);
                    }
                } else if (state.lintSet !== DecorationSet.empty) {
                    const meta: ProofreadMeta = { type: "lints", decorations: DecorationSet.empty };
                    view.dispatch(view.state.tr.setMeta(proofreadPluginKey, meta));
                }

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
            // transactions that change `combined` WITHOUT changing the document.
            // Gating on `doc === lastEmitDoc` keeps plain typing (which only
            // remaps `combined`) off this path, so there's no per-keystroke work.
            let lastCombined = proofreadPluginKey.getState(view.state)?.combined ?? null;
            let lastEmitDoc: ProseNode = view.state.doc;
            return {
                update() {
                    maybeSchedule();
                    const combined = proofreadPluginKey.getState(view.state)?.combined ?? null;
                    const doc = view.state.doc;
                    if (combined !== lastCombined && doc === lastEmitDoc) {
                        window.dispatchEvent(new CustomEvent(PROOFREAD_FINDINGS_CHANGED));
                    }
                    lastCombined = combined;
                    lastEmitDoc = doc;
                },
                destroy() {
                    destroyed = true;
                    currentApplier = null;
                    firstPassIdle?.cancel();
                    hideLintPopup();
                    if (scanTimer !== null) { clearTimeout(scanTimer); }
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
 * Whether any proofreading finding is live — the review sidebar's tab-visibility
 * check. Deliberately cheaper than listProofreadFindings: one decoration-set
 * enumeration with an early exit, no text reads, no row building.
 */
export function hasProofreadFindings(view: EditorView): boolean {
    const state = proofreadPluginKey.getState(view.state);
    if (!state) { return false; }
    return state.combined.find().some((h) => {
        const s = h.spec as DecoSpec;
        return Boolean(s.lint || s.style);
    });
}

/**
 * Every live proofreading finding (style + Harper spelling/grammar), document
 * -ordered, resolved to what the review sidebar needs plus the same Ignore/Learn
 * actions the in-text popup offers. Reads the plugin's `combined` decoration
 * set; computes nothing new (the pure core is describeFindings).
 */
export function listProofreadFindings(view: EditorView): ProofreadFindingRow[] {
    const state = proofreadPluginKey.getState(view.state);
    if (!state) { return []; }
    return describeFindings(state.combined, (from, to) => view.state.doc.textBetween(from, to)).map((f) => ({
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

/** Entry point for lintResults messages from the extension host. */
export function applyLintResults(id: number, results: LintBlockResult[]): void {
    currentApplier?.(id, results);
}

/** Force a style rescan and lint re-request (e.g. after dictionary changes). */
export function refreshProofread(view: EditorView): void {
    const state = proofreadPluginKey.getState(view.state);
    if (!state) { return; }
    const meta: ProofreadMeta = {
        type: "style",
        decorations: computeDecorations(view.state.doc, state.config),
    };
    view.dispatch(view.state.tr.setMeta(proofreadPluginKey, meta));
    // Drop suppressed lints immediately by rebuilding from the current set
    const kept = state.lintSet.find().filter((d) => {
        const spec = d.spec as Partial<LintSpec>;
        if (!spec.lint) { return true; }
        return !isLintSuppressed(spec.lint.kind, view.state.doc.textBetween(d.from, d.to));
    });
    const lintMeta: ProofreadMeta = {
        type: "lints",
        decorations: DecorationSet.create(view.state.doc, kept),
    };
    view.dispatch(view.state.tr.setMeta(proofreadPluginKey, lintMeta));
}
