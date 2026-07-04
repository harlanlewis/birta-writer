/**
 * Proofread plugin: iA-Writer-style Style Check + spell check.
 *
 * Flags filler words, redundancies, and clichés with a dimmed strikethrough,
 * and unknown English words with a dotted underline — all as view-only
 * ProseMirror decorations that never reach the serialized markdown.
 *
 * The whole document is rescanned on a debounce after edits (measured cost is
 * ~1 ms per 5,000 words, so incremental scanning is unnecessary). Code
 * blocks, inline code, URLs, and identifiers are excluded.
 */
import type { EditorView } from "@milkdown/prose/view";
import { Decoration, DecorationSet } from "@milkdown/prose/view";
import { Plugin, PluginKey, TextSelection } from "@milkdown/prose/state";
import type { Node as ProseNode } from "@milkdown/prose/model";
import { $prose } from "@milkdown/utils";
import type { ProofreadConfig } from "../../shared/messages";
import { compileStyleMatcher, type StyleMatcher } from "../utils/styleMatcher";
import { extractWordTokens, INLINE_PLACEHOLDER } from "../utils/spellTokenizer";
import { CLICHES, FILLERS, REDUNDANCIES } from "../proofread/wordlists";
import {
    ensureSpellLoaded,
    isSpellReady,
    isWordCorrect,
    onSpellReady,
    setIgnoredWords,
} from "../proofread/engine";
import { showSpellPopup } from "../proofread/popup";

const SCAN_DEBOUNCE_MS = 350;

type ProofreadState = {
    config: ProofreadConfig;
    decorations: DecorationSet;
};

type ProofreadMeta =
    | { type: "config"; config: ProofreadConfig }
    | { type: "decorations"; decorations: DecorationSet };

export const proofreadPluginKey = new PluginKey<ProofreadState>("proofread");

const DEFAULT_CONFIG: ProofreadConfig = {
    styleCheck: false,
    fillers: true,
    redundancies: true,
    cliches: true,
    spellCheck: false,
    ignoredWords: [],
};

function initialConfig(): ProofreadConfig {
    return { ...DEFAULT_CONFIG, ...(window.__i18n?.proofread ?? {}) };
}

/** Notify interested UI (toolbar button) that the config changed. */
function emitConfigChanged(config: ProofreadConfig): void {
    window.dispatchEvent(new CustomEvent("proofread-config-changed", { detail: config }));
}

export function getProofreadConfig(view: EditorView): ProofreadConfig {
    return proofreadPluginKey.getState(view.state)?.config ?? { ...DEFAULT_CONFIG };
}

/** Apply a config change (from the toolbar toggle or a settings sync). */
export function setProofreadConfig(view: EditorView, config: ProofreadConfig): void {
    setIgnoredWords(config.ignoredWords);
    const meta: ProofreadMeta = { type: "config", config };
    view.dispatch(view.state.tr.setMeta(proofreadPluginKey, meta));
    emitConfigChanged(config);
}

let cachedMatcher: { key: string; matcher: StyleMatcher } | null = null;

function styleMatcherFor(config: ProofreadConfig): StyleMatcher {
    const key = `${config.fillers}|${config.redundancies}|${config.cliches}`;
    if (cachedMatcher?.key !== key) {
        cachedMatcher = {
            key,
            matcher: compileStyleMatcher(
                { fillers: FILLERS, redundancies: REDUNDANCIES, cliches: CLICHES },
                { fillers: config.fillers, redundancies: config.redundancies, cliches: config.cliches },
            ),
        };
    }
    return cachedMatcher.matcher;
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

function computeDecorations(doc: ProseNode, config: ProofreadConfig): DecorationSet {
    const styleEnabled = config.styleCheck && (config.fillers || config.redundancies || config.cliches);
    const spellEnabled = config.spellCheck && isSpellReady();
    if (!styleEnabled && !spellEnabled) { return DecorationSet.empty; }

    const matcher = styleEnabled ? styleMatcherFor(config) : null;
    const decorations: Decoration[] = [];

    doc.descendants((node, pos) => {
        if (node.type.name === "code_block") { return false; }
        if (!node.isTextblock) { return true; }

        const text = blockPlainText(node);
        const base = pos + 1;

        if (matcher) {
            for (const match of matcher(text)) {
                const cls = `pf-style-hit pf-style-hit--${match.category}`;
                decorations.push(Decoration.inline(base + match.start, base + match.end,
                    { class: cls }, { class: cls }));
            }
        }
        if (spellEnabled) {
            for (const token of extractWordTokens(text)) {
                if (isWordCorrect(token.word)) { continue; }
                decorations.push(Decoration.inline(base + token.start, base + token.end,
                    { class: "pf-spell-err" }, { class: "pf-spell-err" }));
            }
        }
        return false; // textblocks contain no further textblocks
    });

    return DecorationSet.create(doc, decorations);
}

/** Find the decoration range of the given class at a document position. */
function decorationRangeAt(
    view: EditorView,
    pos: number,
    className: string,
): { from: number; to: number } | null {
    const state = proofreadPluginKey.getState(view.state);
    if (!state) { return null; }
    const hits = state.decorations
        .find(pos, pos, (spec) => ((spec as { class?: string }).class ?? "").includes(className));
    return hits.length > 0 ? { from: hits[0].from, to: hits[0].to } : null;
}

export const proofreadPlugin = $prose(() => {
    let scanTimer: ReturnType<typeof setTimeout> | null = null;

    return new Plugin<ProofreadState>({
        key: proofreadPluginKey,
        state: {
            init: () => {
                const config = initialConfig();
                setIgnoredWords(config.ignoredWords);
                return { config, decorations: DecorationSet.empty };
            },
            apply(tr, value) {
                let { config, decorations } = value;
                if (tr.docChanged) {
                    decorations = decorations.map(tr.mapping, tr.doc);
                }
                const meta = tr.getMeta(proofreadPluginKey) as ProofreadMeta | undefined;
                if (meta?.type === "config") {
                    config = meta.config;
                } else if (meta?.type === "decorations") {
                    decorations = meta.decorations;
                }
                return { config, decorations };
            },
        },
        props: {
            decorations(state) {
                return proofreadPluginKey.getState(state)?.decorations ?? DecorationSet.empty;
            },
            handleClick(view, pos, event) {
                const target = event.target as HTMLElement | null;
                if (!target?.closest?.(".pf-spell-err")) { return false; }
                const range = decorationRangeAt(view, pos, "pf-spell-err");
                if (range) { showSpellPopup(view, range.from, range.to); }
                return false; // still place the cursor
            },
            handleDoubleClick(view, pos) {
                // iA-style affordance: double-click selects the flagged phrase
                const range = decorationRangeAt(view, pos, "pf-style-hit");
                if (!range) { return false; }
                view.dispatch(view.state.tr.setSelection(
                    TextSelection.create(view.state.doc, range.from, range.to),
                ));
                return true;
            },
        },
        view(view) {
            let lastDoc: ProseNode | null = null;
            let lastConfig: ProofreadConfig | null = null;
            let destroyed = false;

            const scan = () => {
                scanTimer = null;
                if (destroyed || view.isDestroyed) { return; }
                if (view.composing) { schedule(); return; } // don't disturb IME composition
                const state = proofreadPluginKey.getState(view.state);
                if (!state) { return; }
                lastDoc = view.state.doc;
                lastConfig = state.config;
                const decorations = computeDecorations(view.state.doc, state.config);
                const meta: ProofreadMeta = { type: "decorations", decorations };
                view.dispatch(view.state.tr.setMeta(proofreadPluginKey, meta));
            };

            const schedule = () => {
                if (scanTimer !== null) { clearTimeout(scanTimer); }
                scanTimer = setTimeout(scan, SCAN_DEBOUNCE_MS);
            };

            const maybeSchedule = () => {
                const state = proofreadPluginKey.getState(view.state);
                if (!state) { return; }
                if (state.config.spellCheck && !isSpellReady()) { ensureSpellLoaded(); }
                if (view.state.doc !== lastDoc || state.config !== lastConfig) { schedule(); }
            };

            onSpellReady(() => {
                if (destroyed) { return; }
                lastDoc = null;
                maybeSchedule();
            });
            emitConfigChanged(proofreadPluginKey.getState(view.state)?.config ?? { ...DEFAULT_CONFIG });
            maybeSchedule();

            return {
                update: maybeSchedule,
                destroy() {
                    destroyed = true;
                    if (scanTimer !== null) { clearTimeout(scanTimer); }
                },
            };
        },
    });
});

/** Force a rescan (e.g. after an ignored word is added). */
export function refreshProofread(view: EditorView): void {
    const state = proofreadPluginKey.getState(view.state);
    if (!state) { return; }
    const meta: ProofreadMeta = {
        type: "decorations",
        decorations: computeDecorations(view.state.doc, state.config),
    };
    view.dispatch(view.state.tr.setMeta(proofreadPluginKey, meta));
}
