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
import type { EditorState, EditorView, Node as ProseNode } from "../pm";
import { $inputRule, $prose } from "@milkdown/utils";
import { createSuggestMenuFromRows } from "../components/pathLink/linkTargetComplete";
import { caretSuggestPlugin, type CaretSuggestSpec } from "./caretSuggest";
import {
    buildScopeFromLines,
    detectArrowExpression,
    detectCalcExpression,
    evaluateCalc,
    evaluateExpression,
    formatCalcResult,
    isCalcStructurallyValid,
} from "../utils/calc";
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

// ── `=>` living calculations: variables + offline units (MAR-196) ────────────

const calcArrowSuggestKey = new PluginKey("MD_CALC_ARROW_SUGGEST");

/**
 * Every line of prose in the document, in reading order, so a `=>` sees the
 * variable definitions (`name = value`) anywhere above or below it. Code blocks
 * are skipped (a `name = value` inside a fence is source, not a definition), and
 * hard breaks split a multi-line paragraph into separate lines while inline
 * atoms mask to ￼ (never a name or digit), keeping the scan honest.
 *
 * O(document) and run only when the debounced `=>` request fires — never on the
 * keystroke path — so a big document costs nothing until you actually type `=>`.
 */
function collectDocLines(state: EditorState): string[] {
    const lines: string[] = [];
    state.doc.descendants((node: ProseNode) => {
        if (node.type.spec.code) { return false; } // don't descend into code blocks
        if (node.isTextblock) {
            const text = node.textBetween(
                0,
                node.content.size,
                "\n",
                (leaf) => (leaf.type.name === "hardbreak" ? "\n" : "￼"),
            );
            for (const line of text.split("\n")) { lines.push(line); }
            return false; // a textblock's children are inline; text is captured
        }
        return true;
    });
    return lines;
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
        const scope = ctx ? buildScopeFromLines(collectDocLines(ctx.state)) : undefined;
        const value = evaluateCalc(query, scope);
        if (value === null) { cb([]); return; }
        const result = formatCalcResult(value);
        // Exponent results carry a letter, breaking the plain-text contract.
        cb(result.includes("e") ? [] : [result]);
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
 * document, so the file round-trips as if the number had been typed.
 */
function applyArrowResult(view: EditorView, start: number, caret: number, result: string): void {
    const region = view.state.doc.textBetween(start, caret);
    const replacement = region.replace(/=>[ \t]*$/, `=> ${result}`);
    view.dispatch(view.state.tr.insertText(replacement, start, caret).scrollIntoView());
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
 * Equation shapes in a block's text, both insertion forms:
 *  - TRAILING: `expr = result` (an operator-bearing run, its `=`, the number);
 *  - LEADING:  `result=expr` (the number the leading form inserted BEFORE its
 *    `=`; `=5+7` became `12=5+7`).
 * Broad on purpose — each hit re-validates through detectCalcExpression before
 * anything is touched. For the leading form the result token is EXCISED first:
 * `12=5+7` raw would (correctly) fail the leading boundary rule (`a=5+7` is a
 * prose assignment), but with the result removed the text reproduces exactly
 * what the original insertion validated.
 */
const TRAILING_EQ_RE = /[0-9.+\-*/%^() \t]*[0-9)][ \t]*=[ \t]*(-?\d[\d,]*(?:\.\d+)?)/g;
const LEADING_EQ_RE = /(-?\d[\d,]*(?:\.\d+)?)[ \t]*=[ \t]*([0-9.+\-*/%^() \t]*[0-9)])/g;

export const calcRefreshPlugin = $prose(() => new Plugin({
    key: new PluginKey("MD_CALC_REFRESH"),
    appendTransaction(trs, _oldState, newState) {
        if (!calcEnabled() || !calcAutoInsert()) { return null; }
        if (!trs.some((tr) => tr.docChanged)) { return null; }

        // The changed positions in the NEW doc. Each step's range is mapped
        // through the transaction's REMAINING steps so multi-step transactions
        // (a paste with normalizations) still report final-doc coordinates.
        const changed: Array<{ from: number; to: number }> = [];
        for (const tr of trs) {
            if (!tr.docChanged) { continue; }
            tr.mapping.maps.forEach((map, i) => {
                map.forEach((_a, _b, from, to) => {
                    let f = from;
                    let t = to;
                    for (let j = i + 1; j < tr.mapping.maps.length; j++) {
                        f = tr.mapping.maps[j]!.map(f);
                        t = tr.mapping.maps[j]!.map(t);
                    }
                    changed.push({ from: f, to: t });
                });
            });
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
            // This hook rides EVERY doc change while auto-insert is on; a block
            // with no "=" can hold no equation — skip before any regex work.
            if (!text.includes("=")) { continue; }

            /** Apply one refresh in this block if `resultText` went stale. */
            const refresh = (
                exprSpan: [number, number],
                resSpan: [number, number],
                resultText: string,
                validate: () => ReturnType<typeof detectCalcExpression>,
            ): boolean => {
                const localFrom = change.from - blockStart;
                const localTo = change.to - blockStart;
                // The edit must intersect the EXPRESSION side — result edits
                // are the user's override and are never fought.
                if (localTo < exprSpan[0] || localFrom > exprSpan[1]) { return false; }
                if (localFrom >= resSpan[0] && localFrom < resSpan[1]) { return false; }
                const det = validate();
                if (!det || det.result === resultText) { return false; }
                out = out.insertText(det.result, blockStart + resSpan[0], blockStart + resSpan[1]);
                return true;
            };

            let done = false;
            TRAILING_EQ_RE.lastIndex = 0;
            for (let m = TRAILING_EQ_RE.exec(text); m && !done; m = TRAILING_EQ_RE.exec(text)) {
                const runStart = m.index;
                const eqIdx = m[0].lastIndexOf("=");
                const resultText = m[1]!;
                const resStart = runStart + m[0].length - resultText.length;
                done = refresh(
                    [runStart, runStart + eqIdx],
                    [resStart, runStart + m[0].length],
                    resultText,
                    // Re-validate with the run's real left context so every
                    // detection guard (comma fragments, letters) still applies.
                    () => detectCalcExpression(text.slice(0, runStart + eqIdx + 1), { boundaryUnknown: false }),
                );
            }
            LEADING_EQ_RE.lastIndex = 0;
            for (let m = LEADING_EQ_RE.exec(text); m && !done; m = LEADING_EQ_RE.exec(text)) {
                const resultText = m[1]!;
                const exprText = m[2]!;
                const resStart = m.index;
                const resEnd = resStart + resultText.length;
                const exprStart = m.index + m[0].length - exprText.length;
                const exprEnd = m.index + m[0].length;
                done = refresh(
                    [exprStart, exprEnd],
                    [resStart, resEnd],
                    resultText,
                    // Excise the result: the remaining `…=expr` is byte-for-byte
                    // what the original leading-form insertion validated.
                    () => detectCalcExpression(text.slice(0, resStart) + text.slice(resEnd, exprEnd), { boundaryUnknown: false }),
                );
            }
            if (done) { touched = true; }
        }
        return touched ? out : null;
    },
}));
