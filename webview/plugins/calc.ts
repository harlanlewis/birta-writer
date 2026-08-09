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
 *   Enter/Tab handling, IME safety. The controller refuses code blocks; the
 *   `=` spec asks it (`allowInlineCode`) to keep offering inside an INLINE-code
 *   span, where a backticked expression is exactly where a writer puts
 *   arithmetic and the answer is plain digits either way. The `=>` spec
 *   deliberately does not — see the note on `calcArrowSpec`, which is the whole
 *   argument. `autoActivate` pre-selects the lone result so Tab confirms
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
    ambiguousCallsIn,
    ambiguousReadings,
    buildScopeFromLines,
    detectArrowExpression,
    detectCalcExpression,
    disambiguate,
    ensureCalcUnits,
    evaluateCalc,
    evaluateExpression,
    formatCalcResult,
    isCalcStructurallyValid,
    isDisambiguation,
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
    // `` `3+7=` `` computes: see the module header.
    allowInlineCode: true,
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
 * One row the `=>` menu can offer. Normally there is exactly one, carrying the
 * answer. When the expression used a name the world reads two ways (`log`), it
 * carries one row PER READING instead: `reading` is the explicit spelling
 * (`log10`, `ln`) and picking it rewrites the equation to say so — so the
 * document, not just the answer, stops being ambiguous.
 */
interface ArrowRow {
    /** The formatted answer this row would write. */
    result: string;
    /** The explicit function name, on a disambiguation row only. */
    reading?: string;
    /** The ambiguous name this row settles, on a disambiguation row only. */
    name?: string;
}

/**
 * The readings on offer for an expression that refused to compute: one row per
 * explicit spelling of its ambiguous name, each showing what THAT reading
 * answers, so the choice is made against the two numbers rather than in the
 * abstract. Empty when the expression is not ambiguous (it simply has no
 * value) or when no reading computes either — nothing is offered over a guess.
 */
function readingRows(query: string, scope?: Map<string, number>): ArrowRow[] {
    const names = ambiguousCallsIn(query);
    if (names.length === 0) { return []; }
    const rows: ArrowRow[] = [];
    // One ambiguous name exists today; with two, only the reading's OWN name is
    // rewritten, the other stays ambiguous, and the row drops out below —
    // degrading to "no offer", never to a half-settled equation.
    const name = names[0];
    for (const reading of ambiguousReadings(name)) {
        const value = evaluateCalc(disambiguate(query, reading), scope);
        const result = value === null ? null : formatCalcResult(value);
        if (result !== null) { rows.push({ result, reading, name }); }
    }
    return rows;
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
            // No value can still mean "we refuse to guess" rather than "this
            // isn't arithmetic": offer each reading instead of falling silent.
            if (value === null) { cb(readingRows(query, scope)); return; }
            const result = formatCalcResult(value);
            cb(result === null ? [] : [{ result } satisfies ArrowRow]);
        });
    },

    buildMenu(items, match, anchor, onPick) {
        const rows = items as ArrowRow[];
        if (rows.length === 0) { return null; }
        if (rows[0].reading === undefined) {
            const { result } = rows[0];
            return createSuggestMenuFromRows(
                [{ text: result, title: `${match.query} => ${result}`, hint: "Tab" }],
                anchor,
                onPick,
            );
        }
        // Disambiguation: the row's LABEL is the reading (that is what is being
        // chosen) and its answer sits in the hint slot, so the two numbers are
        // side by side. The pick value is the reading's name — `pick` recomputes
        // from it, and a name can never collide with a formatted number. The
        // hint slot is spent on the answer, so the footer — not a per-row
        // "Tab" — is what says how to confirm.
        return createSuggestMenuFromRows(
            rows.map(({ result, reading }) => ({
                text: reading!,
                hint: result,
                title: `${disambiguate(match.query, reading!)} => ${result}`,
            })),
            anchor,
            onPick,
            {
                // Named from the ROW, never a hardcoded `log`: a second entry
                // in the engine's ambiguity table must not leave this sentence
                // explaining a name that isn't on screen.
                footer: t("{0} reads two ways here — Tab writes your choice into the equation itself")
                    .replace("{0}", rows[0].name ?? ""),
            },
        );
    },

    pick(view, match, picked) {
        if (isDisambiguation(picked)) {
            // Recompute rather than trusting the row: the offer is up to a
            // debounce old, and writing a stale number is the failure mode the
            // whole feature exists to avoid.
            const value = evaluateCalc(disambiguate(match.query, picked), scopeUpToCaret(view.state));
            const result = value === null ? null : formatCalcResult(value);
            if (result === null) { return; } // the offer went stale — write nothing
            applyArrowResult(view, match.start, match.caret, result, picked);
            return;
        }
        applyArrowResult(view, match.start, match.caret, picked);
    },

    // Pre-select the lone advisory result so Tab confirms it; Enter keeps its
    // newline meaning (see caretSuggest.ts autoActivate handling).
    autoActivate: true,
    // Deliberately NOT allowInlineCode, unlike the `=` path above. An accepted
    // `=>` answer is a MAINTAINED artifact: the refresh engine keeps it true
    // and calcStale cues it when it can't — and both read blockCalcText, which
    // masks inline code, so neither can reach inside a code span. Offering here
    // would plant an answer in the one place its premise can change behind the
    // user's back with no update and no cue: "a stale number masquerading as
    // live is the one lie a computed value must not tell"
    // (docs/DESIGN_PRINCIPLES.md → Maintained dependencies).
    //
    // Unmasking code for those engines is not the fix either — it would make
    // them read ordinary source as equations, and `=>` is a JS arrow function:
    // `` `n => 1` `` would earn a broken-answer strikethrough on the `1`. The
    // `=` path has neither problem: its answer's premise is its own visible
    // text, so there is nothing to maintain and nothing that can go stale.
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
 *
 * With `reading`, the region's ambiguous calls are rewritten to that explicit
 * spelling in the SAME transaction as the answer. Both halves matter: writing
 * only the answer would leave a number whose expression still reads two ways —
 * the ambiguity the refusal exists to prevent — and one transaction means one
 * undo puts the `log` back. The rewrite is applied to the document REGION
 * (which carries the trailing `=>`), not to the parsed expression, so it
 * survives text the tokenizer would reject.
 */
function applyArrowResult(
    view: EditorView,
    start: number,
    caret: number,
    result: string,
    reading?: string,
): void {
    const text = view.state.doc.textBetween(start, caret);
    const region = reading === undefined ? text : disambiguate(text, reading);
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
 * The just-typed `=`, with any run of arithmetic before it. A TRIGGER, not a
 * test: the run is optional, so this fires on every `=` and the handler below
 * decides, via detectCalcExpression, whether one was an equation. That is why
 * extending the grammar (a call name, a constant) needs no change here — a
 * false shape falls through to normal typing either way.
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
