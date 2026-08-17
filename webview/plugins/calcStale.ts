/**
 * webview/plugins/calcStale.ts
 *
 * Advisory stale/broken cues for living-calculation answers — the decoration
 * complement to the answer-maintenance engine (calcRefresh.ts). That engine
 * keeps accepted `expr => result` answers true while the user edits IN this
 * editor, and withdraws answers whose premises provably vanish. Its documented
 * limits are exactly this plugin's job: a block MOVE that lifts an answer above
 * its definition, an EXTERNAL edit (raw editor, git checkout — deliberately
 * never rewritten), and a freshly OPENED file whose answers no longer hold. In
 * those cases a number stands that the document no longer justifies, and "a
 * silent absence needs a signal" (docs/DESIGN_PRINCIPLES.md) — so the RESULT
 * span gets a decoration:
 *
 * - STALE (the expression now computes a DIFFERENT value): a faint
 *   warning-tinted background — "this number no longer matches the document".
 * - BROKEN (the expression no longer computes at all — a vanished definition,
 *   `1/0`, an impossible unit conversion): the same tint plus a strikethrough,
 *   the established "delete this" vocabulary; removal is what the [Remove
 *   answer] action (and withdrawal) does.
 *
 * Only equations whose premises live OUTSIDE their own text are cued: arrows
 * whose expression references variables, or has the unit-conversion shape.
 * Plain `=` equations and constant-only arrows (`2+3 => 6`) are never cued — a
 * mismatch there is the author's text or a deliberate override, and second-
 * guessing prose arithmetic is precisely what the calc feature refuses to do.
 * One acknowledged ambiguity: a hand-edited RESULT on a variable-bearing arrow
 * (the user's override, which the refresh engine respects) is textually
 * indistinguishable from staleness, so it shows the stale cue; the mitigations
 * are that a cue never touches the file and [Ignore] silences it for the
 * session. Everything advisory: the file changes only on an explicit click
 * ([Update] / [Remove answer]), one undo step each.
 *
 * Structure is proofread.ts's (the decoration blueprint): an idle-armed first
 * pass after first paint, 350 ms debounced rescans, a DecorationSet mapped
 * through every transaction, and a disabled feature that costs nothing — with
 * calc off, nothing is armed, nothing scans, and the lazy unit chunk is never
 * loaded. The scan itself is a single top-to-bottom walk building ONE
 * incremental variable scope (the calcRefresh cascade's reading order), never
 * a per-equation scopeUpTo — O(doc), off the keystroke path, on idle only.
 */
import { Plugin, PluginKey, DecorationSet, Decoration } from "../pm";
import type { EditorView, EditorState, Node as ProseNode } from "../pm";
import { $prose } from "@milkdown/utils";
import {
    applyDefinition,
    definitionHeadName,
    detectArrowExpression,
    ensureCalcUnits,
    evaluateCalc,
    expressionUsesVariables,
    findRefreshEquations,
    formatCalcResult,
    isImpossibleUnitConversion,
    isUnitForm,
    parseDefinitions,
    resultTextMatches,
    unresolvedVariables,
    type EquationSpan,
} from "../utils/calc";
import { calcUnitsReady } from "../utils/calcUnits";
import { blockCalcText, calcEnabled } from "./calc";
import { CARET_CONTEXT_WINDOW } from "./caretSuggest";
import { hideLintPopup, showFindingsPopup, type PopupFinding } from "../proofread/popup";
import { findingsAt } from "./proofread";
import { requestIdle } from "../utils/idle";
import { t } from "../i18n";
import { isReadOnly } from "../readOnly";
import "./calcStale.css";

const SCAN_DEBOUNCE_MS = 350;
const FIRST_PASS_IDLE_TIMEOUT_MS = 1000;

export type CalcCueKind = "stale" | "broken";

/** Everything the click popup needs, carried on the decoration itself. */
export interface CalcCueSpec {
    cue: {
        kind: CalcCueKind;
        /** The re-derived expression (detectArrowExpression's trimming). */
        expr: string;
        /** The shown result text, verbatim (may carry `,` grouping). */
        resultText: string;
        /** Stale only: what the expression computes to now. */
        newValue: string | null;
        /** Broken only: the first unresolved name, or null for a valueless
         * failure (`1/0`, an unknown/incompatible unit, an unprintable
         * result). */
        missingName: string | null;
    };
}

export const calcStalePluginKey = new PluginKey<{ set: DecorationSet }>("MD_CALC_STALE");

// ── Session ignores ──────────────────────────────────────────────────────────
// [Ignore] silences one equation for the session, keyed by its exact
// expression + shown answer — the same in-memory, reset-on-reload semantics as
// proofreading's sessionIgnores. Either side changing is a NEW question and is
// cued afresh.

const sessionIgnores = new Set<string>();

function cueKey(expr: string, resultText: string): string {
    return `${expr}:${resultText}`;
}

export function ignoreCueSession(expr: string, resultText: string): void {
    sessionIgnores.add(cueKey(expr, resultText));
}

export function isCueSuppressed(expr: string, resultText: string): boolean {
    return sessionIgnores.has(cueKey(expr, resultText));
}

/** Test seam: session state must not leak between test cases. */
export function clearCueIgnores(): void {
    sessionIgnores.clear();
}

// ── The classifier (pure, exported for tests) ────────────────────────────────

export interface CalcCueScan {
    set: DecorationSet;
    /** True when a unit-shaped arrow was skipped because the lazy unit chunk
     * isn't loaded yet — the caller should load it and rescan. */
    needsUnits: boolean;
}

/**
 * Classify every arrow equation in `doc` against the definitions above its
 * line, and return the stale/broken decorations. Single pass, one incremental
 * scope (buildScopeFromLines' exact reading order: classify a line's arrows
 * against the scope ABOVE it, then feed the line's own definitions in). Code
 * blocks and headings contribute nothing and are never decorated, matching the
 * scope rules everywhere else in calc.
 */
export function computeCalcCueDecorations(doc: ProseNode): CalcCueScan {
    const decorations: Decoration[] = [];
    const scope = new Map<string, number>();
    const defHeaded = new Set<string>();
    let needsUnits = false;

    const classify = (blockStart: number, text: string, cand: EquationSpan): void => {
        // Re-derive through the full detection discipline — findRefreshEquations'
        // shapes are deliberately broad, and only a span the advisory path would
        // itself have offered may carry a cue.
        const det = detectArrowExpression(text.slice(0, cand.expr[1] + 2), {
            boundaryUnknown: false,
        });
        if (!det) {
            // Detection refuses spans that can't compute — which is precisely
            // what an answered conversion edited into dimensional impossibility
            // (`3 km in mi => 1.86` → `3 km in kg => 1.86`) has become. That
            // one refusal shape is still an equation the user accepted, and its
            // answer now stands on nothing: cue it broken.
            const raw = text.slice(cand.expr[0], cand.expr[1]).trim();
            if (!isImpossibleUnitConversion(raw) || isCueSuppressed(raw, cand.resultText)) { return; }
            const spec: CalcCueSpec = {
                cue: { kind: "broken", expr: raw, resultText: cand.resultText, newValue: null, missingName: null },
            };
            decorations.push(
                Decoration.inline(
                    blockStart + cand.res[0],
                    blockStart + cand.res[1],
                    { class: "calc-cue calc-cue--broken", title: cueMessage(spec.cue) },
                    spec,
                ),
            );
            return;
        }
        const unitShaped = isUnitForm(det.expr);
        // Only expressions with a premise OUTSIDE their own text can go stale:
        // variables (definitions elsewhere) or the unit shape (the catalog).
        // A constant-only arrow's mismatch is the author's text — never cued.
        if (!expressionUsesVariables(det.expr) && !unitShaped) { return; }
        if (unitShaped && !calcUnitsReady()) { needsUnits = true; return; }
        if (isCueSuppressed(det.expr, cand.resultText)) { return; }

        const value = evaluateCalc(det.expr, scope);
        const formatted = value === null ? null : formatCalcResult(value);
        let kind: CalcCueKind;
        let newValue: string | null = null;
        let missingName: string | null = null;
        if (formatted === null) {
            const unresolved = unresolvedVariables(det.expr, scope);
            // A definition mid-edit above (`x =` while retyping the value) is
            // transient, not vanished — no cue until the line settles.
            if (unresolved.some((name) => defHeaded.has(name))) { return; }
            kind = "broken";
            missingName = unresolved[0] ?? null;
        } else if (resultTextMatches(formatted, cand.resultText)) {
            return; // the answer still holds
        } else {
            kind = "stale";
            newValue = formatted;
        }
        const spec: CalcCueSpec = {
            cue: { kind, expr: det.expr, resultText: cand.resultText, newValue, missingName },
        };
        decorations.push(
            Decoration.inline(
                blockStart + cand.res[0],
                blockStart + cand.res[1],
                { class: `calc-cue calc-cue--${kind}`, title: cueMessage(spec.cue) },
                spec,
            ),
        );
    };

    doc.descendants((node: ProseNode, pos: number) => {
        if (!node.isTextblock) { return true; }
        if (node.type.spec.code || node.type.name === "heading") { return false; }
        const text = blockCalcText(node);
        // No `=` → no definition and no equation; skip before any scan work.
        if (!text.includes("=")) { return false; }
        const blockStart = pos + 1;
        const arrows = text.includes("=>")
            ? findRefreshEquations(text, 0, text.length, CARET_CONTEXT_WINDOW)
                .filter((c) => c.form === "arrow")
            : [];
        let arrowIdx = 0;
        let lineStart = 0;
        for (const line of text.split("\n")) {
            const lineEnd = lineStart + line.length;
            while (arrowIdx < arrows.length && arrows[arrowIdx].expr[0] <= lineEnd) {
                classify(blockStart, text, arrows[arrowIdx]);
                arrowIdx++;
            }
            // The shared mid-edit guard (same helper as calcRefresh's
            // withdrawal): a definition-shaped head, valid RHS or not.
            const head = definitionHeadName(line);
            if (head !== null) { defHeaded.add(head); }
            for (const def of parseDefinitions(line)) { applyDefinition(def, scope); }
            lineStart = lineEnd + 1;
        }
        return false;
    });

    return { set: DecorationSet.create(doc, decorations), needsUnits };
}

// ── Popup copy ───────────────────────────────────────────────────────────────
// Every cue explains WHY and what to do (DESIGN_PRINCIPLES: a finding must
// earn its interruption); the same sentence serves as the hover title.

function cueMessage(cue: CalcCueSpec["cue"]): string {
    if (cue.kind === "stale") {
        return `${t("Now computes to")} ${cue.newValue} ${t("from the definitions above — the shown answer no longer follows.")}`;
    }
    return cue.missingName !== null
        ? `'${cue.missingName}' ${t("isn't defined above this line, so this answer has nothing to stand on.")}`
        : t("The expression no longer computes to a value, so this answer has nothing to stand on.");
}

// ── Actions (consent = the click; one undo step each) ────────────────────────

/** Replace a stale result with the freshly computed value. */
export function updateCueResult(view: EditorView, from: number, to: number, newValue: string): void {
    view.dispatch(view.state.tr.insertText(newValue, from, to).scrollIntoView());
    refreshCalcCues(view);
}

/**
 * Remove a broken answer, leaving `expr =>` — byte-for-byte what the refresh
 * engine's withdrawal leaves, so the two paths converge on one shape. The
 * result span's block text is walked back over the spaces to the `=>`; if the
 * shape has drifted between scan and click, fall back to deleting the span.
 */
export function removeCueAnswer(view: EditorView, from: number, to: number): void {
    const $from = view.state.doc.resolve(from);
    const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
    const arrow = /=>[ \t]*$/.exec(before);
    const start = arrow ? $from.start() + arrow.index + 2 : from;
    view.dispatch(view.state.tr.delete(start, to).scrollIntoView());
    refreshCalcCues(view);
}

function cueFinding(view: EditorView, from: number, to: number, cue: CalcCueSpec["cue"]): PopupFinding {
    const buttons: PopupFinding["buttons"] = [];
    // Read-only offers no rewrite (the proofread popup's rule, MAR-53): the
    // cue and its explanation stand, and Ignore is session state, but Update
    // and Remove answer are edits the transaction filter has already refused.
    if (isReadOnly()) {
        // nothing
    } else if (cue.kind === "stale" && cue.newValue !== null) {
        const newValue = cue.newValue;
        buttons.push({ label: t("Update"), run: () => updateCueResult(view, from, to, newValue) });
    } else {
        buttons.push({ label: t("Remove answer"), run: () => removeCueAnswer(view, from, to) });
    }
    buttons.push({
        label: t("Ignore"),
        dismiss: true,
        run: () => {
            ignoreCueSession(cue.expr, cue.resultText);
            refreshCalcCues(view);
        },
    });
    return {
        tag: cue.kind === "stale" ? t("Stale") : t("Broken"),
        message: cueMessage(cue),
        buttons,
    };
}

// ── Plugin ───────────────────────────────────────────────────────────────────

/** True when any textblock contains a `=>` — the cheap whole-doc pre-check
 * that keeps arrow-less documents at one early-exiting walk per scan. */
function docHasArrow(doc: ProseNode): boolean {
    let found = false;
    doc.descendants((node: ProseNode) => {
        if (found) { return false; }
        if (!node.isTextblock) { return true; }
        if (node.textContent.includes("=>")) { found = true; }
        return false;
    });
    return found;
}

/** Recompute and dispatch the cue set for the current doc, synchronously —
 * the instant-feedback path for the click actions and gate flips. */
export function refreshCalcCues(view: EditorView): void {
    const state = calcStalePluginKey.getState(view.state);
    if (!state) { return; }
    const next = calcEnabled()
        ? computeCalcCueDecorations(view.state.doc).set
        : DecorationSet.empty;
    if (next === DecorationSet.empty && state.set === DecorationSet.empty) { return; }
    view.dispatch(view.state.tr.setMeta(calcStalePluginKey, { set: next }));
}

/** The live view's gate opener, installed by the view hook (one webview, one
 * editor — the proofread `currentApplier` pattern). Lets a settings flip reach
 * a plugin whose first-pass gate was never armed because calc was off at
 * mount. */
let openGate: (() => void) | null = null;

/**
 * Re-gate after a live `birta.calc.enabled` flip (messageHandlers'
 * featureGateChanged): enabling opens the first-pass gate and scans now;
 * disabling clears every cue immediately.
 */
export function regateCalcCues(view: EditorView): void {
    if (calcEnabled()) {
        openGate?.();
    } else {
        hideLintPopup();
        refreshCalcCues(view); // calcEnabled() is false → dispatches empty
    }
}

export const calcStalePlugin = $prose(() => {
    return new Plugin<{ set: DecorationSet }>({
        key: calcStalePluginKey,
        state: {
            init: () => ({ set: DecorationSet.empty }),
            apply(tr, value) {
                let set = value.set;
                if (tr.docChanged) { set = set.map(tr.mapping, tr.doc); }
                const meta = tr.getMeta(calcStalePluginKey) as { set: DecorationSet } | undefined;
                if (meta) { set = meta.set; }
                return set === value.set ? value : { set };
            },
        },
        props: {
            decorations(state: EditorState) {
                return calcStalePluginKey.getState(state)?.set ?? DecorationSet.empty;
            },
            handleClick(view, pos, event) {
                const target = event.target as HTMLElement | null;
                if (!target?.closest?.(".calc-cue")) { return false; }
                const state = calcStalePluginKey.getState(view.state);
                if (!state) { return false; }
                const cueFindings: PopupFinding[] = state.set
                    .find(pos, pos)
                    .filter((h) => Boolean((h.spec as Partial<CalcCueSpec>).cue))
                    .map((h) => cueFinding(view, h.from, h.to, (h.spec as CalcCueSpec).cue));
                if (cueFindings.length === 0) { return false; }
                // Overlapping proofread decorations share the clicked span (a
                // long-sentence flag can cover the whole equation), and both
                // handlers drive the SAME singleton popup. Stack every finding
                // here into one popup, cue first (it is the most specific
                // span), and return true so proofread's handler — registered
                // after this plugin — never runs and re-shows only its own
                // subset over the merged popup.
                //
                // Claiming the click ALSO suppresses ProseMirror's default
                // caret placement, and that is deliberate — a divergence from
                // proofread (which returns false and lets the caret land). A
                // caret landing inside a maintained `=> answer` immediately
                // summons the inline-calc suggestion menu over this popup —
                // two advisory surfaces fighting for one position (verified
                // e2e, 2026-07-24). The popup IS the interaction surface for a
                // cued answer; clicking anywhere outside it still edits
                // normally.
                showFindingsPopup(view, pos, [...cueFindings, ...findingsAt(view, pos)]);
                return true;
            },
        },
        view(view) {
            let destroyed = false;
            let scanTimer: ReturnType<typeof setTimeout> | null = null;
            let lastDoc: ProseNode | null = view.state.doc;
            // The first pass waits for an idle window after first paint —
            // cues settle in, they never race the editor becoming interactive.
            let firstPassReady = false;
            let firstPassIdle: { cancel: () => void } | null = null;
            // The lazy unit chunk is kicked at most once per scan generation;
            // a successful load reschedules, a failed one must not loop.
            let unitsKicked = false;

            const scan = () => {
                scanTimer = null;
                if (destroyed || view.isDestroyed || !firstPassReady) { return; }
                if (view.composing) { schedule(); return; } // never disturb IME
                const state = calcStalePluginKey.getState(view.state);
                if (!state) { return; }
                lastDoc = view.state.doc;
                if (!calcEnabled() || !docHasArrow(view.state.doc)) {
                    if (state.set !== DecorationSet.empty) {
                        view.dispatch(view.state.tr.setMeta(calcStalePluginKey, { set: DecorationSet.empty }));
                    }
                    return;
                }
                const { set, needsUnits } = computeCalcCueDecorations(view.state.doc);
                if (set !== DecorationSet.empty || state.set !== DecorationSet.empty) {
                    view.dispatch(view.state.tr.setMeta(calcStalePluginKey, { set }));
                }
                if (needsUnits && !unitsKicked) {
                    unitsKicked = true;
                    void ensureCalcUnits().catch(() => undefined).then(() => {
                        if (!destroyed && calcUnitsReady()) { schedule(0); }
                    });
                }
            };

            const schedule = (delay = SCAN_DEBOUNCE_MS) => {
                if (scanTimer !== null) { clearTimeout(scanTimer); }
                scanTimer = setTimeout(scan, delay);
            };

            const myGate = () => {
                firstPassReady = true;
                schedule(0); // a deliberate settings flip should feel instant
            };
            openGate = myGate;

            // Armed only when calc is on at mount: a disabled feature schedules
            // nothing, walks nothing, and never loads the unit chunk. Enabling
            // later arrives through regateCalcCues → openGate.
            if (calcEnabled()) {
                firstPassIdle = requestIdle(() => {
                    firstPassReady = true;
                    schedule(0);
                }, FIRST_PASS_IDLE_TIMEOUT_MS);
            }

            return {
                update() {
                    if (view.state.doc !== lastDoc) {
                        lastDoc = view.state.doc;
                        // Any edit invalidates the popup's captured positions —
                        // and covers every staleness source at once: typing,
                        // calcRefresh's own rewrites, undo, block moves, and
                        // external-sync replays (which are exactly when cues
                        // must appear, so no EXTERNAL_SYNC_META exemption).
                        hideLintPopup();
                        schedule();
                    }
                },
                destroy() {
                    destroyed = true;
                    firstPassIdle?.cancel();
                    if (scanTimer !== null) { clearTimeout(scanTimer); }
                    // Release the gate only if it is still OURS — an editor
                    // rebuild can create the new view before destroying this
                    // one, and nulling unconditionally would sever the live
                    // editor's settings-flip path.
                    if (openGate === myGate) { openGate = null; }
                    hideLintPopup();
                },
            };
        },
    });
});
