/**
 * webview/editing/blockOps.ts
 *
 * The published block-operations API for UI components (block menu, TOC,
 * find bar, table view): the structural operations and the fold-state /
 * occupancy queries they act through, gathered in one place so components
 * stop importing plugin internals. Deliberately THIN — every entry is a
 * re-export of the owning module's primitive, and all policy stays with
 * those primitives (editing/moveBlocks, plugins/headingFold,
 * plugins/contentGuard, plugins/foldState); this module only names the
 * component-facing surface.
 *
 * Duplicate and delete are component-owned (components/blockMenu implements
 * them, dispatching through the fold metas and guard tag exposed here), so
 * they are not wrapped: no component consumes them across a boundary — only
 * the blockKeys plugin does, which is a plugin, not a component.
 *
 * Pure render-time queries (block glyphs, node-kind taxonomy) stay on the
 * plugins/headingFold facade — this surface is for code that MUTATES the
 * document or must agree with the primitives about what is legal.
 */

// The move primitive and its shared legality verdict (see moveBlocks' module
// header for the hardened contract).
export { moveBlocks, moveFits, type MoveBlocksOptions } from "./moveBlocks";

// Fold operations and the occupancy/fold-state queries that keep UI
// affordances and primitive legality on one registry.
export {
    findHeadingFoldRange,
    foldAllCommand,
    foldedHiddenRanges,
    foldedSectionEnd,
    foldedSectionEnds,
    hiddenRangeCoversTarget,
    isHiddenTargetPos,
    revealPosition,
    setHeadingLevelAt,
    unfoldAllCommand,
} from "../plugins/headingFold";

// The fold plugin's key and transaction-meta vocabulary, for operations that
// must carry fold side-state (move/delete metas) with their edit.
export { headingFoldPluginKey, type HeadingFoldMeta } from "../plugins/foldState";

// The content-conservation guard's tagging protocol: every structural
// operation declares its contract on the transaction it dispatches.
export { tagContentGuard } from "../plugins/contentGuard";
