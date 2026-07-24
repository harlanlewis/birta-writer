/**
 * webview/plugins/calcRefresh.ts
 *
 * The answer-maintenance engine: keeps every inserted calc answer true to its
 * (edited) equation. One consent model, every form — an EXISTING equation
 * whose expression side the user just edited updates in place whenever calc
 * is enabled: `=` and leading forms when their own expression changes, and
 * `expr => result` also when a `name = value` definition ABOVE it changes
 * (the variable cascade). `birta.calc.autoInsert` never gates WHETHER an
 * existing answer is maintained — maintenance is not insertion; the consent
 * was given when the answer was accepted — though it does widen the REACH of
 * `=` maintenance: advisory mode refuses a result followed by a word (the
 * prose-annotation guard), auto-insert keeps full reach. Result-side edits remain the user's override in
 * every form; equations inside inline code are source and never touched. An
 * answer whose definitions vanish is WITHDRAWN (`expr =>`) under three
 * proofs — prior liveness against the old state, no definition mid-edit, and
 * not the current edit's own expression — see the withdrawal branch.
 *
 * This runs inside `appendTransaction`, synchronously on the keystroke path:
 * every scan here is bounded and backtracking-free (see findRefreshEquations
 * in utils/calc.ts), blocks without `=` cost one string scan, and the
 * variable cascade builds ONE incremental scope per pass.
 *
 * Known accepted limits: a block MOVE that lifts an answered arrow above its
 * definition leaves the answer stale until the expression is next touched
 * (a move is a delete+insert; neither side can prove prior liveness for
 * relocated content); a single edit orphaning hundreds of answers pays an
 * O(candidates × doc) one-time liveness cost; and one transaction touching
 * two equations in the SAME block refreshes only the first (each is pinned
 * by a test).
 */
import { Plugin, PluginKey } from "../pm";
import type { Node as ProseNode } from "../pm";
import { $prose } from "@milkdown/utils";
import { CARET_CONTEXT_WINDOW } from "./caretSuggest";
import { EXTERNAL_SYNC_META } from "./docChange";
import {
    applyDefinition,
    detectArrowExpression,
    detectCalcExpression,
    ensureCalcUnits,
    evaluateCalc,
    findRefreshEquations,
    formatCalcResult,
    isCalcStructurallyValid,
    parseDefinitions,
    unresolvedVariables,
    expressionUsesVariables,
    type EquationSpan,
} from "../utils/calc";
import { calcUnitsReady } from "../utils/calcUnits";
import { blockCalcText, calcAutoInsert, calcEnabled, scopeUpTo } from "./calc";

/**
 * Whether any line of a block's text is a `name = value` definition whose
 * right-hand side READS as a calc expression. The structural gate is what
 * keeps prose like `a = b means the assignment operator` from triggering the
 * document-below cascade on every keystroke — a definition that could never
 * contribute a value can never stale an answer.
 */
function blockHasDefinition(text: string): boolean {
    if (!text.includes("=")) { return false; }
    return text.split("\n").some((line) =>
        parseDefinitions(line).some((def) => isCalcStructurallyValid(def.rhs)),
    );
}

export const calcRefreshPlugin = $prose(() => new Plugin({
    key: new PluginKey("MD_CALC_REFRESH"),
    appendTransaction(trs, oldState, newState) {
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
        // Names with a definition-SHAPED line head (`x =`) in the cascade
        // walk, valid or not: an unresolved name that still has a head is a
        // definition MID-EDIT (backspacing `x = 4` on the way to `x = 5`),
        // not a vanished one — withdrawal must wait for it.
        const defHeadedNames = new Set<string>();
        // Lazily-built inverse mappings, for asking what an expression
        // resolved to BEFORE this batch (withdrawal's liveness proof).
        let inverses: ReturnType<(typeof trs)[number]["mapping"]["invert"]>[] | null = null;
        const mapToOld = (pos: number): number => {
            inverses ??= trs.map((tr) => tr.mapping.invert());
            let p = pos;
            for (let i = inverses.length - 1; i >= 0; i--) { p = inverses[i]!.map(p); }
            return Math.max(0, Math.min(p, oldState.doc.content.size));
        };
        // Earliest document position whose block held an edited definition —
        // every `=>` equation from there DOWN may have gone stale.
        let cascadeFrom = -1;

        // A DELETED definition must cascade too: the post-edit block no
        // longer shows it, so also inspect the PRE-edit blocks the first
        // transaction touched (its step coordinates are exact against
        // oldState; later transactions in a batch are relative to
        // intermediate docs and are covered by the post-edit trigger).
        const firstMapping = trs[0]!.mapping;
        firstMapping.maps.forEach((map, i) => {
            // A step's coordinates are relative to the doc AFTER the steps
            // before it — map them back through those steps' inverse to get
            // true oldState positions (a composite transaction that inserts
            // then deletes a definition would otherwise be misread).
            const back = firstMapping.slice(0, i).invert();
            map.forEach((stepFrom, stepEnd) => {
                const size = oldState.doc.content.size;
                oldState.doc.nodesBetween(
                    Math.max(0, Math.min(back.map(stepFrom, -1), size)),
                    Math.max(0, Math.min(back.map(stepEnd, 1), size)),
                    (node: ProseNode, pos: number) => {
                        if (!node.isTextblock) { return true; }
                        if (node.type.spec.code) { return false; }
                        if (!blockHasDefinition(blockCalcText(node))) { return false; }
                        let mapped = pos + 1;
                        for (const tr of trs) { mapped = tr.mapping.map(mapped); }
                        cascadeFrom = cascadeFrom === -1 ? mapped : Math.min(cascadeFrom, mapped);
                        return false;
                    },
                );
            });
        });

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
                if (result === null) {
                    // The lazy unit engine may simply not be loaded yet —
                    // kick the load and try again on the next edit (this
                    // hook is synchronous and cannot await).
                    if (!calcUnitsReady()) {
                        void ensureCalcUnits().catch(() => undefined);
                        return false;
                    }
                    // CASCADE only: the document no longer justifies this
                    // answer — WITHDRAW it, leaving `expr =>`. A stale number
                    // masquerading as live is the one lie the feature must
                    // not tell; withdrawal is quiet and one undo restores
                    // everything. Three proofs are required first:
                    //  - not a LOCAL edit (mid-typing an expression is
                    //    transiently unresolvable; destroying the answer on
                    //    the first keystroke of a rename would be hostile);
                    //  - no unresolved name is a definition MID-EDIT (an
                    //    `x =` head above means "being retyped", not gone);
                    //  - the answer was LIVE before this batch (it resolved
                    //    against the old state) — a number after a `=>` the
                    //    feature never answered is prose, and prose digits
                    //    are never ours to delete.
                    if (!scope) { return false; }
                    const unresolved = unresolvedVariables(det.expr, scope);
                    if (unresolved.some((name) => defHeadedNames.has(name))) { return false; }
                    const oldScope = scopeUpTo(oldState, mapToOld(blockStart + cand.expr[0]));
                    if (evaluateCalc(det.expr, oldScope) === null) { return false; }
                    out = out.delete(
                        out.mapping.map(blockStart + cand.expr[1] + 2),
                        out.mapping.map(blockStart + cand.res[1]),
                    );
                    refreshed.add(key);
                    touched = true;
                    return true;
                }
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
                        // An arrow whose EXPRESSION the current edit touches
                        // belongs to the local pass, which never withdraws —
                        // typing over `x` in the arrow itself must not
                        // destroy the answer via the same-block cascade.
                        if (changed.some(
                            (c) => c.from <= blockStart + cand.expr[1]
                                && c.to >= blockStart + cand.expr[0],
                        )) { continue; }
                        refresh(blockStart, text, cand, scope);
                    }
                    // Any definition-SHAPED head marks its name as mid-edit
                    // for the withdrawal guard, valid RHS or not.
                    const head = /^\s*([A-Za-zπτ_][\wπτ]*)\s*=(?![=>])/u.exec(line);
                    if (head) { defHeadedNames.add(head[1]); }
                    for (const def of parseDefinitions(line)) {
                        // The one definition-evaluation step, shared with
                        // buildScopeFromLines: a resolvable RHS enters scope,
                        // a broken one never clobbers an earlier good value.
                        applyDefinition(def, scope);
                    }
                    lineStart = lineEnd + 1;
                }
                return false;
            });
        }
        return touched ? out : null;
    },
}));
