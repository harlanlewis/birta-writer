/**
 * Footnote plugins (MAR-15):
 *   - insertFootnoteCommand: inserts a reference at the cursor plus a matching
 *     definition at the end of the document, then drops the cursor into the
 *     definition body so the user can type the note immediately.
 *   - footnoteReferenceInputRule: typing `[^label]` becomes a reference chip —
 *     but ONLY when a matching definition already exists. An orphan `[^x]`
 *     stays literal text, mirroring the GFM parser (which never creates a
 *     reference without a definition), so a typed footnote always round-trips.
 *   - footnoteNumberingPlugin: keeps every chip/badge's display number in sync
 *     with reference order after any document change (a NodeView only re-renders
 *     its own node, so cross-node renumbering needs a document-level hook).
 */
import { InputRule } from "@/pm";
import { TextSelection } from "@/pm";
import { Plugin } from "@/pm";
import { $command, $inputRule, $prose } from "@milkdown/utils";
import {
    computeDisplayIndex,
    findDefinitionByLabel,
    nextFreeLabel,
} from "@/components/footnote";

/** Literal `[^label]` ending at the just-typed `]`. */
export const FOOTNOTE_REF_REGEX = /\[\^([^\]\s]+)\]$/;

/**
 * Inserts a new footnote: a reference at the current selection and a fresh
 * definition (single empty paragraph) appended to the document, with the
 * cursor placed inside the definition.
 */
export const insertFootnoteCommand = $command(
    "InsertFootnote",
    () => () => (state, dispatch) => {
        const refType = state.schema.nodes["footnote_reference"];
        const defType = state.schema.nodes["footnote_definition"];
        const paraType = state.schema.nodes["paragraph"];
        if (!refType || !defType || !paraType) return false;
        if (!dispatch) return true;

        const label = nextFreeLabel(state.doc);
        const ref = refType.create({ label });
        const def = defType.create({ label }, paraType.create());

        let tr = state.tr.replaceSelectionWith(ref, false);
        const defPos = tr.doc.content.size;
        tr = tr.insert(defPos, def);
        // defPos → def start; +1 into the definition; +1 into its paragraph.
        const cursor = Math.min(defPos + 2, tr.doc.content.size);
        tr = tr.setSelection(TextSelection.create(tr.doc, cursor)).scrollIntoView();

        dispatch(tr);
        return true;
    },
);

/**
 * Converts a typed `[^label]` into a reference node — only when a matching
 * definition exists, so no vanishing orphan references are ever created.
 */
export const footnoteReferenceInputRule = $inputRule(() =>
    new InputRule(FOOTNOTE_REF_REGEX, (state, match, start, end) => {
        const label = match[1];
        if (!label) return null;
        const refType = state.schema.nodes["footnote_reference"];
        if (!refType) return null;
        const $start = state.doc.resolve(start);
        if ($start.parent.type.spec.code) return null;
        if (!findDefinitionByLabel(state.doc, label)) return null;
        return state.tr.replaceRangeWith(start, end, refType.create({ label }));
    }),
);

/** Rewrites every visible chip/badge's number from the given reference order. */
function refreshFootnoteNumbers(dom: HTMLElement, map: Map<string, number>): void {
    dom.querySelectorAll<HTMLElement>('[data-fn-ref="1"]').forEach((el) => {
        const label = el.dataset["label"] ?? "";
        const idx = map.get(label);
        el.textContent = idx !== undefined ? String(idx) : label;
    });
    dom.querySelectorAll<HTMLElement>(".footnote-def-badge").forEach((el) => {
        const label = el.dataset["label"] ?? "";
        const idx = map.get(label);
        el.textContent = idx !== undefined ? String(idx) : label;
    });
}

/** Same label→number assignment, in the same first-reference order? */
function sameDisplayIndex(a: Map<string, number>, b: Map<string, number>): boolean {
    if (a.size !== b.size) return false;
    for (const [label, idx] of a) {
        if (b.get(label) !== idx) return false;
    }
    return true;
}

export const footnoteNumberingPlugin = $prose(
    () =>
        new Plugin({
            view(editorView) {
                // The whole-DOM refresh (two full querySelectorAll sweeps) used
                // to run on EVERY doc-changing transaction — a per-keystroke tax
                // that scales with document size and is almost always a no-op
                // (typing prose cannot renumber footnotes). Gate it on the thing
                // it actually depends on: recompute the label→number map (a
                // cheap doc walk) and touch the DOM only when the map changed.
                // Chips/badges self-render their own number when created (see
                // the NodeViews in components/footnote) — that covers the
                // initial document too, so the baseline map is simply the one
                // at view creation and an unchanged map means every visible
                // number is already right.
                let lastMap = computeDisplayIndex(editorView.state.doc);
                return {
                    update(view, prevState): void {
                        // Identity, not .eq(): ProseMirror reuses the doc node
                        // when only the selection changed (see plugins/docChange).
                        if (view.state.doc === prevState.doc) return;
                        const map = computeDisplayIndex(view.state.doc);
                        if (sameDisplayIndex(map, lastMap)) return;
                        lastMap = map;
                        refreshFootnoteNumbers(view.dom as HTMLElement, map);
                    },
                };
            },
        }),
);
