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
import type { EditorView } from "@milkdown/prose/view";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import { Plugin, PluginKey, TextSelection } from "@milkdown/prose/state";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { $prose } from "@milkdown/utils";
import type { HarperLint, LintBlock, LintBlockResult, ProofreadConfig } from "../../shared/messages";
import { INLINE_PLACEHOLDER } from "../../shared/proofreadFilter";
import { compileStyleMatcher, type StyleCategory, type StyleMatcher } from "../utils/styleMatcher";
import {
    AI_ARTIFACTS,
    AI_VOCABULARY,
    CLICHES,
    FILLERS,
    REDUNDANCIES,
    WORDINESS,
} from "../proofread/wordlists";
import { isLintSuppressed, setUserWords } from "../proofread/engine";
import { hideLintPopup, showLintPopup } from "../proofread/popup";
import { notifyLintBlocks } from "../messaging";
import { t } from "../i18n";

const SCAN_DEBOUNCE_MS = 350;

/** Spec attached to a Harper decoration so the popup can render it. */
export type LintSpec = {
    class: string;
    lint: HarperLint;
};

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

// Fallback when the injected __i18n.proofread snapshot is missing. Every check
// defaults ON (maintainer decision), matching the contributed setting defaults
// in package.json — see shared/__tests__/proofreadDefaultsContributions.test.ts.
export const DEFAULT_CONFIG: ProofreadConfig = {
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
]);

function initialConfig(): ProofreadConfig {
    return { ...DEFAULT_CONFIG, ...(window.__i18n?.proofread ?? {}) };
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

/** Hover explanations, one clause each — quiet middle ground between iA (nothing) and Hemingway (popups). */
function styleHitTitle(category: string): string {
    switch (category) {
        case "fillers": return t("Filler — consider removing");
        case "redundancies": return t("Redundancy — consider shortening");
        case "cliches": return t("Cliché — consider rephrasing");
        case "wordiness": return t("Wordy — consider tightening");
        case "aiVocabulary": return t("AI vocabulary — consider a plainer word");
        case "aiArtifacts": return t("AI boilerplate — consider removing");
        case "passive": return t("Passive voice — consider active");
        case "longSentences": return t("Long sentence — consider splitting");
        case "negativeParallelism": return t("AI cadence — 'not X, but Y'");
        case "ruleOfThree": return t("Rule of three — consider varying");
        case "emDash": return t("Em dash — use a spaced hyphen");
        case "nonAsciiPunct": return t("Non-ASCII punctuation — normalize to ASCII");
        case "repeated": return t("Repeated word");
        default: return "";
    }
}

/**
 * Flatten one textblock into plain text where offsets map 1:1 to document
 * positions (blockPos + 1 + offset): inline-code text is masked with spaces
 * and non-text inline nodes become placeholder characters of equal size.
 * Exported for unit testing.
 */
export function blockPlainText(block: ProseNode): string {
    let text = "";
    block.forEach((child) => {
        if (child.isText) {
            const isCode = child.marks.some((m) => m.type.name === "inlineCode");
            text += isCode ? " ".repeat(child.text?.length ?? 0) : (child.text ?? "");
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
    // The repeated-word check rides on the master switch, so style check is
    // meaningful even with all three phrase categories turned off.
    if (!config.styleCheck) { return DecorationSet.empty; }
    const matcher = styleMatcherFor(config);
    const decorations: Decoration[] = [];

    forEachTextblock(doc, (node, pos) => {
        const text = blockPlainText(node);
        const base = pos + 1;
        for (const match of matcher(text)) {
            const cls = `pf-style-hit pf-style-hit--${match.category}`
                + (FLAG_CATEGORIES.has(match.category) ? " pf-style-hit--flag" : "");
            decorations.push(Decoration.inline(base + match.start, base + match.end,
                { class: cls, title: styleHitTitle(match.category) }, { class: cls }));
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

/** Build decorations from Harper results (block keys are request-time positions). */
function buildLintDecorations(
    doc: ProseNode,
    results: LintBlockResult[],
    config: ProofreadConfig,
): DecorationSet {
    const decorations: Decoration[] = [];
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

function combine(doc: ProseNode, styleSet: DecorationSet, lintSet: DecorationSet): DecorationSet {
    const style = styleSet.find();
    const lints = lintSet.find();
    if (style.length === 0) { return lintSet; }
    if (lints.length === 0) { return styleSet; }
    return DecorationSet.create(doc, [...style, ...lints]);
}

/** Find the decoration range (+spec) of the given class at a document position. */
function decorationAt(
    view: EditorView,
    pos: number,
    className: string,
): { from: number; to: number; spec: Partial<LintSpec> } | null {
    const state = proofreadPluginKey.getState(view.state);
    if (!state) { return null; }
    const hits = state.combined
        .find(pos, pos, (spec) => ((spec as { class?: string }).class ?? "").includes(className));
    return hits.length > 0
        ? { from: hits[0].from, to: hits[0].to, spec: hits[0].spec as Partial<LintSpec> }
        : null;
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
                if (!target?.closest?.(".pf-spell-err, .pf-lint-err")) { return false; }
                const hit = decorationAt(view, pos, "pf-spell-err")
                    ?? decorationAt(view, pos, "pf-lint-err");
                if (hit?.spec.lint) { showLintPopup(view, hit.from, hit.to, hit.spec.lint); }
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

            currentApplier = (id, results) => {
                if (destroyed || view.isDestroyed) { return; }
                if (id !== lintRequestId) { return; } // stale response
                // If the doc changed since the request, positions are invalid;
                // the pending rescan will re-request.
                if (view.state.doc !== lintRequestDoc) { return; }
                const cfg = proofreadPluginKey.getState(view.state)?.config;
                const meta: ProofreadMeta = {
                    type: "lints",
                    decorations: cfg
                        ? buildLintDecorations(view.state.doc, results, cfg)
                        : DecorationSet.empty,
                };
                view.dispatch(view.state.tr.setMeta(proofreadPluginKey, meta));
            };

            const scan = () => {
                scanTimer = null;
                if (destroyed || view.isDestroyed) { return; }
                if (view.composing) { schedule(); return; } // don't disturb IME composition
                const state = proofreadPluginKey.getState(view.state);
                if (!state) { return; }
                lastDoc = view.state.doc;
                lastConfig = state.config;

                const styleDecos = computeDecorations(view.state.doc, state.config);
                if (styleDecos !== DecorationSet.empty || state.styleSet !== DecorationSet.empty) {
                    const meta: ProofreadMeta = { type: "style", decorations: styleDecos };
                    view.dispatch(view.state.tr.setMeta(proofreadPluginKey, meta));
                }

                if (state.config.spellCheck || state.config.grammarCheck) {
                    lintRequestId++;
                    lintRequestDoc = view.state.doc;
                    notifyLintBlocks(lintRequestId, collectLintBlocks(view.state.doc));
                } else if (state.lintSet !== DecorationSet.empty) {
                    const meta: ProofreadMeta = { type: "lints", decorations: DecorationSet.empty };
                    view.dispatch(view.state.tr.setMeta(proofreadPluginKey, meta));
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
                    schedule(0); // config toggles should feel instant
                } else if (view.state.doc !== lastDoc) {
                    hideLintPopup(); // edits invalidate the popup's captured range
                    schedule();
                }
            };

            emitConfigChanged(proofreadPluginKey.getState(view.state)?.config ?? { ...DEFAULT_CONFIG });
            maybeSchedule();

            return {
                update: maybeSchedule,
                destroy() {
                    destroyed = true;
                    currentApplier = null;
                    hideLintPopup();
                    if (scanTimer !== null) { clearTimeout(scanTimer); }
                },
            };
        },
    });
});

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
