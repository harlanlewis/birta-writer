/**
 * Pending-range highlight: keeps the text a config palette is about to act
 * on visibly marked while focus lives in the palette's inputs. The native
 * selection only paints while the editor itself has focus, so without this
 * the user cannot see what range an insert/edit-link (or similar) palette
 * will apply to.
 *
 * Driven by setPendingRange(view, range|null) via a meta-only transaction —
 * no doc change, so it never touches serialization or autosave. The
 * decoration maps through concurrent doc changes and clears on close.
 */
import { Plugin, PluginKey } from "../pm";
import { Decoration, DecorationSet } from "../pm";
import type { EditorView } from "../pm";
import { $prose } from "@milkdown/utils";

export interface PendingRange {
    from: number;
    to: number;
    /** Decoration class; defaults to the palette pending highlight. The
     * slash menu reuses this plugin for its "/query" pill. */
    class?: string;
}

const pendingRangeKey = new PluginKey<DecorationSet>("MD_PENDING_RANGE");

/** Highlights `range` as pending (null clears the highlight). */
export function setPendingRange(view: EditorView, range: PendingRange | null): void {
    view.dispatch(view.state.tr.setMeta(pendingRangeKey, range));
}

export const pendingRangePlugin = $prose(
    () =>
        new Plugin<DecorationSet>({
            key: pendingRangeKey,
            state: {
                init: () => DecorationSet.empty,
                apply(tr, set) {
                    const meta = tr.getMeta(pendingRangeKey) as
                        | PendingRange
                        | null
                        | undefined;
                    if (meta !== undefined) {
                        if (meta === null || meta.from === meta.to) {
                            return DecorationSet.empty;
                        }
                        return DecorationSet.create(tr.doc, [
                            Decoration.inline(meta.from, meta.to, {
                                class: meta.class ?? "pending-range",
                            }),
                        ]);
                    }
                    return set.map(tr.mapping, tr.doc);
                },
            },
            props: {
                decorations(state) {
                    return pendingRangeKey.getState(state) ?? DecorationSet.empty;
                },
            },
        }),
);
