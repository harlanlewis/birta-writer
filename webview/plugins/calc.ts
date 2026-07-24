/**
 * Inline-calc ProseMirror wiring: the advisory `=` suggestion ("Math Notes",
 * MAR-177), the advisory `=>` living-calculation suggestion (MAR-196), and
 * the opt-in auto-insert input rule. The evaluation and the deliberately-
 * narrow caret detection live in webview/utils/calc.ts (a safe hand-written
 * parser — never eval/Function, no network, no LLM); the answer-maintenance
 * engine (refresh, variable cascade, withdrawal) lives in ./calcRefresh.ts,
 * which imports this module's shared helpers (blockCalcText, scopeUpTo, the
 * gates).
 *
 * - Advisory mode reuses the shared caret-suggestion controller
 *   (caretSuggest.ts, the same machinery behind link/wikilink autocomplete):
 *   debounce, stale-reply generations, Escape suppression, capture-phase
 *   Enter/Tab handling, IME safety. The controller refuses code blocks and
 *   inline code, `autoActivate` pre-selects the lone result so Tab confirms
 *   it (Enter deliberately stays a newline), and accepting at a stale answer
 *   REPLACES the old number (staleResultLengthAfter). The `=` fetch is
 *   synchronous; the `=>` fetch awaits the lazy unit engine.
 * - Auto-insert mode is a plain input rule: when the `=` is typed to
 *   complete an expression, it appends `= <result>` right then.
 *
 * Everything here is gated on `birta.calc.enabled` (baked into
 * window.__i18n at panel load, like smartLinks). A disabled feature costs
 * nothing: `match` / the rule handler return null on the first property
 * read, so no menu, no evaluation, no work runs.
 */
import { InputRule, PluginKey } from "../pm";
import type { EditorState, EditorView, Node as ProseNode } from "../pm";
import { $inputRule, $prose } from "@milkdown/utils";
import { createSuggestMenuFromRows } from "../components/pathLink/linkTargetComplete";
import { CARET_CONTEXT_WINDOW, caretSuggestPlugin, type CaretSuggestSpec } from "./caretSuggest";
import {
    ARITHMETIC_CLASS,
    buildScopeFromLines,
    detectArrowExpression,
    detectCalcExpression,
    ensureCalcUnits,
    evaluateCalc,
    evaluateExpression,
    formatCalcResult,
    isCalcStructurallyValid,
} from "../utils/calc";
import { notifySetCalcAutoInsert } from "../messaging";
import { t } from "../i18n";

/** calc is on by default; both flags are baked into __i18n at panel load. */
export function calcEnabled(): boolean {
    return window.__i18n?.calcEnabled ?? true;
}
/** Auto-insert is opt-in (advisory by default). */
export function calcAutoInsert(): boolean {
    return window.__i18n?.calcAutoInsert ?? false;
}

/** The settings row's label — a function so i18n resolves at menu build. */
function alwaysInsertLabel(): string {
    return t("Always insert result");
}

// ── Advisory mode (caret suggestion) ─────────────────────────────────────────

const calcSuggestKey = new PluginKey("MD_CALC_SUGGEST");

const calcSuggestSpec: CaretSuggestSpec = {
    match(textBefore, ctx) {
        if (!calcEnabled()) { return null; }
        const det = detectCalcExpression(textBefore, { boundaryUnknown: ctx?.truncated ?? false });
        if (!det) { return null; }
        // Auto-insert mode owns the TRAILING form via its input rule (the
        // final `=` marks the expression finished). The LEADING form (`=5+7`)
        // has no finishing keystroke — the user may still be typing digits —
        // so it stays advisory even in auto-insert mode.
        if (calcAutoInsert() && /=[ \t]*$/.test(textBefore)) { return null; }
        // query carries the pure expression; the result is recomputed where
        // needed (deterministic, so no need to thread it through the controller).
        return { length: det.length, query: det.expr };
    },

    shouldSuggest: (query) => evaluateExpression(query) !== null,

    // Synchronous: compute now and call back immediately. Never async, never
    // networked — the whole point of calc is determinism.
    fetch(query, cb) {
        const value = evaluateExpression(query);
        const result = value === null ? null : formatCalcResult(value);
        cb(result === null ? [] : [result]);
    },

    buildMenu(items, match, anchor, onPick) {
        const results = items as string[];
        if (results.length === 0) { return null; }
        const result = results[0];
        // Row 1: the answer — the row text IS the pick value (inserted
        // verbatim), so it shows just the number with the confirm key as a
        // right-aligned hint; the full equation is the hover title.
        // Row 2: a settings action — flip birta.calc.autoInsert so every
        // future `=` inserts without this menu. Only reachable here (the
        // menu never shows once auto-insert is on), so no "off" state needed.
        return createSuggestMenuFromRows(
            [
                { text: result, title: `${match.query} = ${result}`, hint: "Tab" },
                {
                    text: alwaysInsertLabel(),
                    title: t("Insert the answer the moment you type = (birta.calc.autoInsert)"),
                    action: true,
                },
            ],
            anchor,
            onPick,
            // The one moment a user provably wants inline math is the only
            // in-product surface that can teach the richer form.
            { footer: t("=> also computes — with variables and unit conversions") },
        );
    },

    pick(view, match, picked) {
        if (picked === alwaysInsertLabel()) {
            // Settings row: turn auto-insert on (local gate now, persisted
            // via the write-back), and complete the CURRENT ask too — the
            // user was mid-equation; leaving it unanswered would read as a
            // broken pick.
            if (window.__i18n) { window.__i18n.calcAutoInsert = true; }
            notifySetCalcAutoInsert(true);
            const value = evaluateExpression(match.query);
            const result = value === null ? null : formatCalcResult(value);
            if (result !== null) {
                applyCalcResult(view, match.start, match.caret, result);
            }
            return;
        }
        applyCalcResult(view, match.start, match.caret, picked);
    },

    // The lone advisory result is pre-selected so Tab confirms it without an
    // arrow key. Enter deliberately keeps its newline meaning (the pre-highlight
    // must not capture the user's first Enter) — see caretSuggest.ts's
    // autoActivate handling.
    autoActivate: true,
};

/**
 * Answer the matched span, form-aware (the region's own shape says which):
 * - trailing `<expr> =` → `<expr> = <result>` (spacing after `=` normalized);
 * - leading `=<expr>` → `<result>=<expr>` — the region starts with `=`, and
 *   the result lands verbatim before it (`=5+7` → `12=5+7`).
 * Plain text only — nothing calc-specific persists in the document.
 */
function applyCalcResult(view: EditorView, start: number, caret: number, result: string): void {
    const region = view.state.doc.textBetween(start, caret);
    const leading = region.startsWith("=");
    const replacement = leading
        ? `${result}${region}`
        : region.replace(/=[ \t]*$/, `= ${result}`);
    // Trailing form only: consume a stale answer after the caret so
    // re-accepting at `expr =| old` replaces the old number (the leading
    // form writes BEFORE the `=`, where nothing stale can sit).
    const end = leading ? caret : caret + staleResultLengthAfter(view.state, caret);
    view.dispatch(view.state.tr.insertText(replacement, start, end).scrollIntoView());
}

/** Advisory inline-calc plugin (registered beside the other caret suggestions). */
export const calcSuggestPlugin = $prose(() =>
    caretSuggestPlugin(calcSuggestKey, calcSuggestSpec),
);

// ── `=>` living calculations: variables + offline units (MAR-196) ────────────

const calcArrowSuggestKey = new PluginKey("MD_CALC_ARROW_SUGGEST");

/**
 * The variable scope a `=>` at `caret` resolves against: every `name = value`
 * definition from the document start up to the caret, in reading order. Only
 * definitions ABOVE the cursor count, so a `=>` never resolves against one that
 * appears after it — the value shown matches what a reader sees scanning down to
 * that line, and a later redefinition can't retroactively change an earlier
 * result.
 *
 * Skips code blocks (a `name = value` in a fence is source, not a definition)
 * and headings (a title is not a data line); hard breaks split a paragraph into
 * lines while inline atoms mask to ￼ (never a name or digit). Everything at or
 * after the caret is pruned before any text work, so the scan pays only for the
 * document ABOVE the cursor, not the whole file — and runs only on the debounced
 * request, never the keystroke path.
 */
function scopeUpToCaret(state: EditorState): Map<string, number> {
    return scopeUpTo(state, state.selection.from);
}

/**
 * A textblock's calc-visible text, offset-preserving: every char maps 1:1 to
 * a document position after blockStart. Hard breaks become `\n` (so LINES are
 * real — a definition on the second hardbreak line is a definition), inline
 * atoms mask to `￼` (never an operand), and INLINE-CODE text masks to `￼`
 * per character — `` `x = 4` `` is source: not a definition, not an equation,
 * exactly like a code block.
 */
export function blockCalcText(node: ProseNode): string {
    let text = "";
    node.forEach((child) => {
        if (child.isText) {
            text += child.marks.some((m) => m.type.spec.code)
                ? "￼".repeat(child.text?.length ?? 0)
                : child.text ?? "";
        } else if (child.type.name === "hardbreak") {
            text += "\n";
        } else {
            text += "￼".repeat(child.nodeSize);
        }
    });
    return text;
}

/** The same scope, cut at an arbitrary document position (the refresh path
 * resolves each `=>` equation against the definitions above ITS line, not the
 * caret's). */
export function scopeUpTo(state: EditorState, upTo: number): Map<string, number> {
    const lines: string[] = [];
    state.doc.descendants((node: ProseNode, pos: number) => {
        if (pos >= upTo) { return false; } // node starts at/after the cut — prune
        if (node.type.spec.code || node.type.name === "heading") { return false; }
        if (node.isTextblock) {
            const blockStart = pos + 1;
            const end = Math.min(node.content.size, upTo - blockStart);
            for (const line of blockCalcText(node).slice(0, end).split("\n")) {
                lines.push(line);
            }
            return false; // a textblock's children are inline; text is captured
        }
        return true;
    });
    return buildScopeFromLines(lines);
}

/**
 * The `=>` advisory suggestion: typing `<expr> =>` offers the computed value,
 * confirmed with Tab (Enter stays a newline, like the `=` path). The expression
 * may reference variables defined anywhere in the document and use offline unit
 * conversions (`3 km in mi =>`). Detection is block-local (the expression ends
 * at the caret); only variable RESOLUTION needs the whole document, done in
 * `fetch` where the editor state is available.
 */
const calcArrowSpec: CaretSuggestSpec = {
    match(textBefore, ctx) {
        if (!calcEnabled()) { return null; }
        const det = detectArrowExpression(textBefore, { boundaryUnknown: ctx?.truncated ?? false });
        return det ? { length: det.length, query: det.expr } : null;
    },

    // Structural validity only (variables assumed resolvable); the real
    // resolution happens in fetch against the document scope.
    shouldSuggest: (query) => isCalcStructurallyValid(query),

    fetch(query, cb, ctx) {
        // The unit engine is a lazy chunk (calcUnits.ts); load it before
        // evaluating so `3 km in mi =>` works on first use. The controller
        // tolerates a late cb (stale-reply generations), and a failed load
        // degrades to arithmetic-only — conversions yield null, nothing shown.
        // Known, accepted window: during the FIRST chunk load only, a doc
        // rewrite that keeps the match alive (an external-sync replay editing
        // a definition above) can surface a value computed against the
        // pre-rewrite state; the next transaction's 200ms re-request corrects
        // it, and every later call resolves in a microtask (no window).
        void ensureCalcUnits().catch(() => undefined).then(() => {
            const scope = ctx ? scopeUpToCaret(ctx.state) : undefined;
            const value = evaluateCalc(query, scope);
            if (value === null) { cb([]); return; }
            const result = formatCalcResult(value);
            cb(result === null ? [] : [result]);
        });
    },

    buildMenu(items, match, anchor, onPick) {
        const results = items as string[];
        if (results.length === 0) { return null; }
        const result = results[0];
        return createSuggestMenuFromRows(
            [{ text: result, title: `${match.query} => ${result}`, hint: "Tab" }],
            anchor,
            onPick,
        );
    },

    pick(view, match, picked) {
        applyArrowResult(view, match.start, match.caret, picked);
    },

    // Pre-select the lone advisory result so Tab confirms it; Enter keeps its
    // newline meaning (see caretSuggest.ts autoActivate handling).
    autoActivate: true,
    // The `=>` construct can coincide with the structural list-merge advisory at
    // the same caret; the one the user is actively typing wins.
    yieldsToOpenMenus: true,
};

/**
 * Write the result after the `=>`, normalizing spacing to `<expr> => <result>`.
 * Plain text only — like the `=` path, nothing calc-specific persists in the
 * document, so the file round-trips as if the number had been typed. An old
 * answer sitting just AFTER the caret (`expr =>| stale` — the caret parked at
 * the arrow of an already-answered equation) is consumed, so re-accepting
 * REPLACES the stale number instead of inserting beside it.
 */
function applyArrowResult(view: EditorView, start: number, caret: number, result: string): void {
    const region = view.state.doc.textBetween(start, caret);
    const replacement = region.replace(/=>[ \t]*$/, `=> ${result}`);
    const end = caret + staleResultLengthAfter(view.state, caret);
    view.dispatch(view.state.tr.insertText(replacement, start, end).scrollIntoView());
}

/**
 * Length of a stale answer directly after `caret` in the same block —
 * optional spaces then a plain number (the only shape calc ever writes).
 * Zero when what follows is anything else; atoms mask to ￼ and hard breaks
 * to a newline-like leaf, neither of which a number can match through.
 */
function staleResultLengthAfter(state: EditorState, caret: number): number {
    const $caret = state.doc.resolve(caret);
    const rest = $caret.parent.textBetween(
        $caret.parentOffset,
        $caret.parent.content.size,
        undefined,
        "￼",
    );
    return /^[ \t]*-?\d(?:[\d,]*\d)?(?:\.\d+)?/.exec(rest)?.[0].length ?? 0;
}

/** Advisory `=>` living-calculation plugin. */
export const calcArrowSuggestPlugin = $prose(() =>
    caretSuggestPlugin(calcArrowSuggestKey, calcArrowSpec),
);

// ── Auto-insert mode (input rule) ────────────────────────────────────────────

/**
 * A trailing arithmetic run ending in the just-typed `=`. Broad on purpose —
 * the handler validates that the run is a real, operator-bearing expression via
 * detectCalcExpression, so a false shape (a bare number, a letter mixed in)
 * falls through to normal typing.
 */
const CALC_AUTOINSERT_REGEX = new RegExp(`[${ARITHMETIC_CLASS} \\t]*=$`);

/**
 * When `birta.calc.autoInsert` is on, typing the `=` that completes an
 * expression inserts `= <result>` immediately. Input rules already skip code
 * blocks (Milkdown's runner checks `$from.parent.type.spec.code`); the handler
 * re-checks to be safe.
 *
 * The typed `=` is part of the regex match but NOT yet in the document, and a
 * rule that returns a transaction suppresses the default insertion of that
 * character — so the transaction must re-add the `=`. `end` is the caret before
 * the `=`; inserting `= <result>` there turns `12*4` + typed `=` into
 * `12*4= 48`, matching the advisory mode's output exactly.
 */
export const calcAutoInsertPlugin = $inputRule(() =>
    new InputRule(CALC_AUTOINSERT_REGEX, (state, match, start, end) => {
        if (!calcEnabled() || !calcAutoInsert()) { return null; }
        const $end = state.doc.resolve(end);
        if ($end.parent.type.spec.code) { return null; }
        // NEVER detect against match[0]: it is the already-stripped arithmetic
        // run, so its position 0 is always the run start and the left-boundary
        // guards can never fire — `1,000 + 2=` would evaluate the fragment
        // `000 + 2` and auto-insert a WRONG `= 2`. Rebuild the REAL context
        // (the same window the caret-suggest path sees, plus the just-typed `=`
        // that is not in the doc yet) so the guards see the comma/letter before
        // the run, and flag the window edge when the block is longer than that.
        const textBefore =
            $end.parent.textBetween(
                Math.max(0, $end.parentOffset - CARET_CONTEXT_WINDOW),
                $end.parentOffset,
                undefined,
                "￼",
            ) + "=";
        const det = detectCalcExpression(textBefore, {
            boundaryUnknown: $end.parentOffset > CARET_CONTEXT_WINDOW,
        });
        if (!det) { return null; }
        return state.tr.insertText(`= ${det.result}`, end);
    }),
);
