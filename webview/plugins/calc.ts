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
import { CARET_CONTEXT_WINDOW, caretSuggestPlugin, type CaretSuggestSpec } from "./caretSuggest";
import { EXTERNAL_SYNC_META } from "./docChange";
import {
    ARITHMETIC_CLASS,
    buildScopeFromLines,
    detectArrowExpression,
    detectCalcExpression,
    ensureCalcUnits,
    evaluateCalc,
    evaluateExpression,
    expressionUsesVariables,
    findRefreshEquations,
    formatCalcResult,
    isCalcStructurallyValid,
    parseDefinition,
    type EquationSpan,
} from "../utils/calc";
import { calcUnitsReady } from "../utils/calcUnits";
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
function blockCalcText(node: ProseNode): string {
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
function scopeUpTo(state: EditorState, upTo: number): Map<string, number> {
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

// ── Refresh: keep an inserted answer true to its (edited) equation ──────────
//
// One consent model, every form: an EXISTING equation whose expression side
// the user just edited updates in place whenever calc is enabled — for `=`
// and leading forms when their own expression changes, and for
// `expr => result` also when a `name = value` definition ABOVE it changes
// (the variable cascade). `birta.calc.autoInsert` governs only whether typing
// `=` INSERTS an answer unprompted; maintenance of an answer that already
// exists is not insertion — the consent was given when the answer was
// accepted, and a stale number the user just invalidated is the thing the
// feature exists to prevent. Result-side edits remain the user's override in
// every form and are never fought; equations inside inline code are source.

/**
 * Whether any line of a block's text is a `name = value` definition whose
 * right-hand side READS as a calc expression. The structural gate is what
 * keeps prose like `a = b means the assignment operator` from triggering the
 * document-below cascade on every keystroke — a definition that could never
 * contribute a value can never stale an answer.
 */
function blockHasDefinition(text: string): boolean {
    if (!text.includes("=")) { return false; }
    return text.split("\n").some((line) => {
        const def = parseDefinition(line);
        return def !== null && isCalcStructurallyValid(def.rhs);
    });
}

export const calcRefreshPlugin = $prose(() => new Plugin({
    key: new PluginKey("MD_CALC_REFRESH"),
    appendTransaction(trs, _oldState, newState) {
        if (!calcEnabled()) { return null; }
        if (!trs.some((tr) => tr.docChanged)) { return null; }
        // An external-sync transaction replays an edit made OUTSIDE this
        // editor (the raw text editor, a git checkout). Whatever result the
        // on-disk author wrote is THEIR text — rewriting it here would dirty
        // the document the instant it synced in, with no user action, and
        // fight the file on disk. Same exemption anchorSync applies.
        if (trs.some((tr) => tr.getMeta(EXTERNAL_SYNC_META))) { return null; }

        // The changed positions in the FINAL doc: each step's range is mapped
        // through its transaction's remaining steps, then through every LATER
        // transaction — coordinates from trs[0] are meaningless against
        // newState if trs[1] inserted text before them.
        const changed: Array<{ from: number; to: number }> = [];
        trs.forEach((tr, k) => {
            if (!tr.docChanged) { return; }
            tr.mapping.maps.forEach((map, i) => {
                map.forEach((_a, _b, from, to) => {
                    let f = from;
                    let t = to;
                    for (let j = i + 1; j < tr.mapping.maps.length; j++) {
                        f = tr.mapping.maps[j]!.map(f);
                        t = tr.mapping.maps[j]!.map(t);
                    }
                    for (let j = k + 1; j < trs.length; j++) {
                        f = trs[j]!.mapping.map(f);
                        t = trs[j]!.mapping.map(t);
                    }
                    changed.push({ from: f, to: t });
                });
            });
        });
        if (changed.length === 0) { return null; }

        let out = newState.tr;
        let touched = false;
        const seenBlocks = new Set<number>();
        // Spans already rewritten this pass (`blockStart:resStart`), so the
        // variable cascade never re-touches what the local pass refreshed.
        const refreshed = new Set<string>();
        // Earliest document position whose block held an edited definition —
        // every `=>` equation from there DOWN may have gone stale.
        let cascadeFrom = -1;

        /**
         * Recompute one candidate; rewrite its result if stale. True if
         * rewritten. `scope` (cascade only) is the incrementally-built scope
         * at the candidate's line — without it, arrows resolve via a fresh
         * scopeUpTo walk.
         */
        const refresh = (
            blockStart: number,
            text: string,
            cand: EquationSpan,
            scope?: Map<string, number>,
        ): boolean => {
            const key = `${blockStart}:${cand.res[0]}`;
            if (refreshed.has(key)) { return false; }
            let result: string | null = null;
            if (cand.form === "arrow") {
                // The arrow's own detection re-derives the expression with the
                // full boundary discipline; its value resolves against the
                // definitions above ITS line — never the caret's.
                const det = detectArrowExpression(text.slice(0, cand.expr[1] + 2), {
                    boundaryUnknown: false,
                });
                if (!det) { return false; }
                const value = evaluateCalc(
                    det.expr,
                    scope ?? scopeUpTo(newState, blockStart + cand.expr[0]),
                );
                result = value === null ? null : formatCalcResult(value);
                // A unit conversion before the lazy engine loads can't compute
                // — kick the load off so the NEXT edit refreshes (this hook is
                // synchronous and cannot await).
                if (result === null && !calcUnitsReady()) { void ensureCalcUnits().catch(() => undefined); }
            } else {
                // Advisory mode: a `=` result followed by a WORD reads as
                // prose annotation ("Dec 24-26 = 3 days off") far more often
                // than a maintained answer — leave it alone. Auto-insert mode
                // opted into aggressive maintenance and keeps full reach.
                if (!calcAutoInsert()) {
                    const tail = text.slice(cand.res[1]);
                    // Whitespace is excluded from the accepting class, or the
                    // `[ \t]*` would backtrack and let a space "satisfy"
                    // non-letter while a word still follows.
                    if (!/^[ \t]*($|[^\p{L}\p{N} \t])/u.test(tail)) { return false; }
                }
                const det = cand.form === "trailing"
                    // Re-validate with the run's real left context so every
                    // detection guard (comma fragments, letters) still applies.
                    ? detectCalcExpression(text.slice(0, cand.expr[1] + 1), { boundaryUnknown: false })
                    // Excise the result: the remaining `…=expr` is byte-for-byte
                    // what the original leading-form insertion validated.
                    : detectCalcExpression(
                        text.slice(0, cand.res[0]) + text.slice(cand.res[1], cand.expr[1]),
                        { boundaryUnknown: false },
                    );
                result = det?.result ?? null;
            }
            if (result === null) { return false; }
            // Compare comma-blind: `1,500` for a recomputed `1500` is the
            // same value in the user's grouping style — leave it alone.
            if (result === cand.resultText.replace(/,/g, "")) { return false; }
            // Positions were computed against newState; map them through the
            // steps THIS transaction has already accumulated (an earlier
            // refresh may have shifted them — unmapped, a second rewrite
            // lands at corrupt offsets).
            out = out.insertText(
                result,
                out.mapping.map(blockStart + cand.res[0]),
                out.mapping.map(blockStart + cand.res[1]),
            );
            refreshed.add(key);
            touched = true;
            return true;
        };

        for (const change of changed) {
            const pos = Math.min(change.from, newState.doc.content.size);
            const $pos = newState.doc.resolve(pos);
            if (!$pos.parent.isTextblock || $pos.parent.type.spec.code) { continue; }
            const blockStart = $pos.start();
            if (seenBlocks.has(blockStart)) { continue; }
            seenBlocks.add(blockStart);
            // Offset-preserving masked text: atoms and inline-code to ￼
            // (never operands, never equations), hardbreaks to real lines.
            const text = blockCalcText($pos.parent);
            // This hook rides EVERY doc change; a block with no "=" can hold
            // no equation and no definition — skip before any scan work.
            if (!text.includes("=")) { continue; }

            // An edited definition can stale every `=>` below it.
            if (blockHasDefinition(text)) {
                cascadeFrom = cascadeFrom === -1 ? blockStart : Math.min(cascadeFrom, blockStart);
            }

            const localFrom = Math.max(0, change.from - blockStart);
            const localTo = Math.min(text.length, Math.max(localFrom, change.to - blockStart));
            // Bounded, backtracking-free scan around the change (utils/calc.ts
            // explains why this is not a regex); every candidate is re-validated
            // through the full detection discipline before anything is touched.
            for (const cand of findRefreshEquations(text, localFrom, localTo, CARET_CONTEXT_WINDOW)) {
                // The edit must intersect the EXPRESSION side — result edits
                // are the user's override and are never fought.
                if (localTo < cand.expr[0] || localFrom > cand.expr[1]) { continue; }
                if (localFrom >= cand.res[0] && localFrom < cand.res[1]) { continue; }
                if (refresh(blockStart, text, cand)) { break; } // one local per block
            }
        }

        // The variable cascade: recompute the variable-bearing `=>` equations
        // at or below the edited definition. ONE scope, built incrementally
        // as the walk descends (seeded with everything above the cascade
        // start), so per-arrow semantics — "definitions above ITS line" —
        // hold at O(doc) instead of O(arrows × doc). Guards:
        //  - only when a structurally-plausible definition was edited;
        //  - only variable-bearing expressions (a `2+3 => 99` override has no
        //    dependency on any definition and is never touched);
        //  - never a result the CURRENT edit intersects (that edit IS the
        //    user's override — rewriting it back would undo them mid-keystroke).
        if (cascadeFrom !== -1) {
            const scope = scopeUpTo(newState, cascadeFrom);
            const resIntersectsChange = (blockStart: number, cand: EquationSpan): boolean =>
                changed.some(
                    (c) =>
                        c.from <= blockStart + cand.res[1] && c.to >= blockStart + cand.res[0],
                );
            newState.doc.descendants((node: ProseNode, pos: number) => {
                if (!node.isTextblock) { return true; }
                if (node.type.spec.code || node.type.name === "heading") { return false; }
                const blockStart = pos + 1;
                if (blockStart + node.content.size <= cascadeFrom) { return false; }
                const text = blockCalcText(node);
                if (!text.includes("=")) { return false; }
                const arrows = text.includes("=>")
                    ? findRefreshEquations(text, 0, text.length, CARET_CONTEXT_WINDOW)
                        .filter((c) => c.form === "arrow")
                    : [];
                // Line-ordered: refresh each line's arrows against the scope
                // ABOVE it, then feed the line's own definition into the scope
                // (buildScopeFromLines' exact reading order).
                let arrowIdx = 0;
                let lineStart = 0;
                for (const line of text.split("\n")) {
                    const lineEnd = lineStart + line.length;
                    while (arrowIdx < arrows.length && arrows[arrowIdx].expr[0] <= lineEnd) {
                        const cand = arrows[arrowIdx];
                        arrowIdx++;
                        if (!expressionUsesVariables(text.slice(cand.expr[0], cand.expr[1]))) { continue; }
                        if (resIntersectsChange(blockStart, cand)) { continue; }
                        refresh(blockStart, text, cand, scope);
                    }
                    const def = parseDefinition(line);
                    if (def) {
                        // The one definition-evaluation step (see
                        // buildScopeFromLines): a resolvable RHS enters scope,
                        // a broken one never clobbers an earlier good value.
                        const value = evaluateCalc(def.rhs, scope);
                        if (value !== null) { scope.set(def.name, value); }
                    }
                    lineStart = lineEnd + 1;
                }
                return false;
            });
        }
        return touched ? out : null;
    },
}));
