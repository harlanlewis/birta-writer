/**
 * Inline calc-on-`=` — deterministic arithmetic at the caret ("Math Notes",
 * MAR-177).
 *
 * Typing an arithmetic expression immediately followed by `=` (e.g. `12 * 4 =`,
 * `(3 + 4) / 2 =`) computes the result and offers it. By default the result is
 * ADVISORY: a single-row suggestion the user confirms with Tab, which writes
 * the number into the document as ordinary text. Return is deliberately left
 * free to start a new line — the pre-highlighted row never captures the user's
 * Enter (see caretSuggest.ts handleKeydown). It never silently mutates the
 * line. The opt-in `birta.calc.autoInsert` setting flips this to insert-on-`=`
 * via an input rule instead.
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
 *   result so Tab confirms it without an arrow key first (Enter stays a newline).
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
import { notifySetCalcAutoInsert } from "../messaging";
import { t } from "../i18n";

/** calc is on by default; both flags are baked into __i18n at panel load. */
function calcEnabled(): boolean {
    return window.__i18n?.calcEnabled ?? true;
}
/** Auto-insert is opt-in (advisory by default). */
function calcAutoInsert(): boolean {
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
        cb(value === null ? [] : [formatCalcResult(value)]);
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
            if (value !== null) {
                applyCalcResult(view, match.start, match.caret, formatCalcResult(value));
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
    const replacement = region.startsWith("=")
        ? `${result}${region}`
        : region.replace(/=[ \t]*$/, `= ${result}`);
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
        const $end = state.doc.resolve(end);
        if ($end.parent.type.spec.code) { return null; }
        // NEVER detect against match[0]: it is the already-stripped arithmetic
        // run, so its position 0 is always the run start and the left-boundary
        // guards can never fire — `1,000 + 2=` would evaluate the fragment
        // `000 + 2` and auto-insert a WRONG `= 2`. Rebuild the REAL context
        // (the last ≤500 chars of the block, plus the just-typed `=` that is
        // not in the doc yet) so the guards see the comma/letter before the
        // run, and flag the window edge when the block is longer than that.
        const textBefore =
            $end.parent.textBetween(
                Math.max(0, $end.parentOffset - 500),
                $end.parentOffset,
                undefined,
                "￼",
            ) + "=";
        const det = detectCalcExpression(textBefore, {
            boundaryUnknown: $end.parentOffset > 500,
        });
        if (!det) { return null; }
        return state.tr.insertText(`= ${det.result}`, end);
    }),
);

// ── Auto-insert mode: refresh a stale answer when its expression is edited ──

/**
 * `expr = result` runs in a block's text: an operator-bearing arithmetic run,
 * its `=`, and the number after it. Broad on purpose — each hit is re-validated
 * through detectCalcExpression (with the run's REAL left context, so the
 * comma/letter guards still apply) before anything is touched.
 */
const EQUATION_RE = /[0-9.+\-*/%^() \t]*[0-9)][ \t]*=[ \t]*(-?\d[\d,]*(?:\.\d+)?)/g;

/**
 * With `birta.calc.autoInsert` on, editing the EXPRESSION side of an existing
 * `expr = result` recomputes and rewrites the result — `3+4= 7` edited to
 * `4+4= 7` becomes `4+4= 8` in the same undo step as the edit. Guardrails:
 *
 *  - Auto-insert mode only. Advisory mode never rewrites the document without
 *    a confirmation (the consent rule) — a deliberately "wrong" hand-typed
 *    equation must survive there.
 *  - Only when the edit touches the expression, never when it touches the
 *    result: hand-editing the answer is the user overriding the machine, and
 *    the machine must not fight back.
 *  - Only when the run still validates as real arithmetic (mid-edit states
 *    like `4+= 7` leave the text alone until the expression is whole again).
 */
export const calcRefreshPlugin = $prose(() => new Plugin({
    key: new PluginKey("MD_CALC_REFRESH"),
    appendTransaction(trs, _oldState, newState) {
        if (!calcEnabled() || !calcAutoInsert()) { return null; }
        if (!trs.some((tr) => tr.docChanged)) { return null; }

        // The changed positions in the NEW doc, coalesced per transaction step.
        const changed: Array<{ from: number; to: number }> = [];
        for (const tr of trs) {
            if (!tr.docChanged) { continue; }
            for (const map of tr.mapping.maps) {
                map.forEach((_a, _b, from, to) => { changed.push({ from, to }); });
            }
        }
        if (changed.length === 0) { return null; }

        let out = newState.tr;
        let touched = false;
        const seenBlocks = new Set<number>();
        for (const change of changed) {
            const pos = Math.min(change.from, newState.doc.content.size);
            const $pos = newState.doc.resolve(pos);
            if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) { continue; }
            const blockStart = $pos.start();
            if (seenBlocks.has(blockStart)) { continue; }
            seenBlocks.add(blockStart);
            // Inline atoms mask to a char arithmetic can't contain, keeping
            // offsets 1:1 with positions (the proofread/notes masking contract).
            const text = $pos.parent.textBetween(0, $pos.parent.content.size, undefined, "￼");

            EQUATION_RE.lastIndex = 0;
            for (let m = EQUATION_RE.exec(text); m; m = EQUATION_RE.exec(text)) {
                const runStart = m.index;
                const eqIdx = m[0].lastIndexOf("=");
                const resultText = m[1]!;
                const resultStart = runStart + m[0].length - resultText.length;
                const resultEnd = runStart + m[0].length;
                // The edit must intersect the run BEFORE the result token —
                // expression edits refresh; result edits are the user's.
                const localFrom = change.from - blockStart;
                const localTo = change.to - blockStart;
                if (localTo < runStart || localFrom >= resultStart) { continue; }
                // Re-validate with the run's real left context so every
                // detection guard (comma fragments, letters) still applies.
                const det = detectCalcExpression(text.slice(0, runStart + eqIdx + 1), { boundaryUnknown: false });
                if (!det) { continue; }
                if (det.result === resultText) { continue; }
                out = out.insertText(det.result, blockStart + resultStart, blockStart + resultEnd);
                touched = true;
                break; // one refresh per block per pass keeps mapping simple
            }
        }
        return touched ? out : null;
    },
}));
