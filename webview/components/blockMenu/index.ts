/**
 * components/blockMenu/index.ts
 *
 * The block menu's public surface — the ONE import path for everything
 * outside this directory (guarded by blockMenuFacade.test.ts; the
 * plugins/headingFold facade sets the discipline). The files behind it:
 *
 *   menu.ts        — the gutter block menu itself + the by-position block
 *                    actions (duplicate/delete/move/anchor-slug)
 *   drag.ts        — the pointer drag session, drop-zone provider registry,
 *                    and the shared drop indicator
 *   marquee.ts     — margin rubber-band block selection
 *   openAtCaret.ts — the keyboard path into the menu (⌘.)
 *   turnInto.ts    — the concrete block converters (blockCapabilities
 *                    derives legality and dispatches onto these)
 *
 * Internal cross-imports between those files stay direct; only external
 * consumers come through here. Exports are trimmed to names with consumers
 * outside the directory — don't re-export an internal helper "for
 * completeness".
 */
export {
    closeBlockMenu,
    deleteBlockRange,
    duplicateBlockRange,
    headingAnchorSlug,
    moveBlockAt,
    moveBlockTo,
    moveRangeAt,
    openBlockMenu,
    setBlockMenuContext,
} from "./menu";

export {
    blockBoundaryPositions,
    dropTargetFor,
    edgeScrollVelocity,
    hideDropIndicator,
    registerDropZoneProvider,
    showDropIndicatorAt,
    startPointerDragSession,
    visibleBoundaryPositions,
    wireMarkerDrag,
    type DragSessionSource,
    type DropBoundary,
    type DropZoneProvider,
} from "./drag";

export { commitMarqueeSelection, wireMarquee } from "./marquee";

export { openBlockMenuAtCaret } from "./openAtCaret";

export {
    canTurnInto,
    containerToList,
    retypeContainer,
    retypeList,
    turnIntoCodeBlock,
    unwrapContainerTo,
    unwrapListTo,
    wrapListIn,
    wrapProseIn,
} from "./turnInto";

// ── Fold-layer wiring ───────────────────────────────────────────────────────
// The fold gutter's widgets open this menu, arm marker drags, and wire the
// marquee — but the plugin layer must not import component modules (round-2
// finding F1). Register the implementations into the late-bound registry the
// moment this component loads; the fold layer resolves them at interaction
// time (see plugins/blockHandles.ts).
import { registerBlockHandles } from "../../plugins/blockHandles";
import { closeBlockMenu, openBlockMenu } from "./menu";
import { wireMarkerDrag } from "./drag";
import { wireMarquee } from "./marquee";

registerBlockHandles({ openBlockMenu, closeBlockMenu, wireMarkerDrag, wireMarquee });
