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
import { InputRule } from "@milkdown/prose/inputrules";
import { TextSelection } from "@milkdown/prose/state";
import { Plugin } from "@milkdown/prose/state";
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

/** Rewrites every visible chip/badge's number from current reference order. */
function refreshFootnoteNumbers(dom: HTMLElement, doc: Parameters<typeof computeDisplayIndex>[0]): void {
    const map = computeDisplayIndex(doc);
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

export const footnoteNumberingPlugin = $prose(
    () =>
        new Plugin({
            view() {
                return {
                    update(view, prevState): void {
                        if (!view.state.doc.eq(prevState.doc)) {
                            refreshFootnoteNumbers(view.dom as HTMLElement, view.state.doc);
                        }
                    },
                };
            },
        }),
);
