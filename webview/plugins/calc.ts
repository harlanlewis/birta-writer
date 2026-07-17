/**
 * Inline calc-on-`=` — deterministic arithmetic at the caret ("Math Notes",
 * MAR-177).
 *
 * Typing an arithmetic expression immediately followed by `=` (e.g. `12 * 4 =`,
 * `(3 + 4) / 2 =`) computes the result and offers it. By default the result is
 * ADVISORY: a single-row suggestion the user confirms with Return or Tab, which
 * writes the number into the document as ordinary text. It never silently
 * mutates the line. The opt-in `birta.calc.autoInsert` setting flips this to
 * insert-on-`=` via an input rule instead.
 *
 * The evaluation and the deliberately-narrow caret detection live in
 * webview/utils/calc.ts (a safe hand-written parser — never eval/Function, no
 * network, no LLM); this module is only the ProseMirror wiring:
 *
 * - Advisory mode reuses the shared caret-suggestion controller (caretSuggest.ts,
 *   the same machinery behind link/wikilink autocomplete): debounce, stale-reply
 *   generations, Escape suppression, capture-phase Enter/Tab handling, IME
 *   safety. The controller already refuses code blocks and inline code, so calc
 *   never fires inside them. Its `fetch` is synchronous (compute, call back
 *   immediately — no async, no network), and `autoActivate` pre-selects the lone
 *   result so Return/Tab confirm it without an arrow key first.
 * - Auto-insert mode is a plain input rule: when the `=` is typed to complete an
 *   expression, it appends `= <result>` right then, keeping what the user typed.
 *
 * Both paths are gated on `birta.calc.enabled` (baked into window.__i18n at
 * panel load, like smartLinks). A disabled feature costs nothing: `match` /
 * the rule handler return null on the first property read, so no menu, no
 * evaluation, no work runs.
 */
import { InputRule, Plugin, PluginKey } from "../pm";
import type { EditorView } from "../pm";
import { $inputRule, $prose } from "@milkdown/utils";
import { createSuggestMenuFromRows } from "../components/pathLink/linkTargetComplete";
import { caretSuggestPlugin, type CaretSuggestSpec } from "./caretSuggest";
import { detectCalcExpression, evaluateExpression, formatCalcResult } from "../utils/calc";

/** calc is on by default; both flags are baked into __i18n at panel load. */
function calcEnabled(): boolean {
    return window.__i18n?.calcEnabled ?? true;
}
/** Auto-insert is opt-in (advisory by default). */
function calcAutoInsert(): boolean {
    return window.__i18n?.calcAutoInsert ?? false;
}

// ── Advisory mode (caret suggestion) ─────────────────────────────────────────

const calcSuggestKey = new PluginKey("MD_CALC_SUGGEST");

const calcSuggestSpec: CaretSuggestSpec = {
    match(textBefore) {
        // Off, or the user opted into auto-insert: no advisory menu at all.
        if (!calcEnabled() || calcAutoInsert()) { return null; }
        const det = detectCalcExpression(textBefore);
        if (!det) { return null; }
        // query carries the pure expression; the result is recomputed where
        // needed (deterministic, so no need to thread it through the controller).
        return { length: det.length, query: det.expr };
    },

    shouldSuggest: (query) => evaluateExpression(query) !== null,

    // Synchronous: compute now and call back immediately. Never async, never
    // networked — the whole point of calc is determinism.
    fetch(query, cb) {
        const value = evaluateExpression(query);
        cb(value === null ? [] : [formatCalcResult(value)]);
    },

    buildMenu(items, match, anchor, onPick) {
        const results = items as string[];
        if (results.length === 0) { return null; }
        const result = results[0];
        // One row: the answer. The row text IS the pick value (inserted
        // verbatim), so it shows just the number; the full equation is the
        // hover title for context.
        return createSuggestMenuFromRows(
            [{ text: result, title: `${match.query} = ${result}` }],
            anchor,
            onPick,
        );
    },

    pick(view, match, picked) {
        applyCalcResult(view, match.start, match.caret, picked);
    },

    // The lone advisory result is pre-selected so Return/Tab confirm it without
    // an arrow key; here Enter picks rather than splitting the paragraph, a
    // deliberate divergence from the link/wikilink lists (documented in
    // caretSuggest.ts's autoActivate).
    autoActivate: true,
};

/**
 * Replaces the matched `<expr> =` span with `<expr> = <result>`: keeps the
 * expression the user typed and their spacing, normalizes the run right after
 * `=` to a single space, and appends the result. Plain text only — nothing
 * calc-specific persists in the document.
 */
function applyCalcResult(view: EditorView, start: number, caret: number, result: string): void {
    const region = view.state.doc.textBetween(start, caret);
    const replacement = region.replace(/=[ \t]*$/, `= ${result}`);
    view.dispatch(view.state.tr.insertText(replacement, start, caret).scrollIntoView());
}

/** Advisory inline-calc plugin (registered beside the other caret suggestions). */
export const calcSuggestPlugin = $prose(() =>
    caretSuggestPlugin(calcSuggestKey, calcSuggestSpec),
);

// ── Auto-insert mode (input rule) ────────────────────────────────────────────

/**
 * A trailing arithmetic run ending in the just-typed `=`. Broad on purpose —
 * the handler validates that the run is a real, operator-bearing expression via
 * detectCalcExpression, so a false shape (a bare number, a letter mixed in)
 * falls through to normal typing.
 */
const CALC_AUTOINSERT_REGEX = /[0-9.+\-*/%^() \t]*=$/;

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
        if (state.doc.resolve(start).parent.type.spec.code) { return null; }
        // detectCalcExpression wants the text as it looks WITH the `=`; match[0]
        // already ends in `=` (the just-typed char is included in the match).
        const det = detectCalcExpression(match[0]);
        if (!det) { return null; }
        return state.tr.insertText(`= ${det.result}`, end);
    }),
);
