/**
 * webview/plugins/headingFold/index.ts
 *
 * The fold hub's public surface — the historical `plugins/headingFold`
 * import path, preserved verbatim so its ~19 importers (and the test
 * suites) never see the decomposition behind it. The layers, bottom up:
 *
 *   foldModel.ts       — pure range/anchor/occupancy logic (no DOM)
 *   foldAnchors.ts     — T1 syntax seeding + T2 structural-anchor persistence
 *   foldGutter.ts      — gutter/marker/ellipsis DOM factories + MarkerSpec
 *   foldDecorations.ts — the decoration pass + the structural fingerprint
 *   foldCommands.ts    — fold/unfold commands + fold-boundary reveal keymap
 *   plugin.ts          — the ProseMirror plugin (state machine + view)
 *
 * The key, state shape, and meta vocabulary live in ../foldState (a
 * dependency-light module NodeViews can import without cycling through the
 * menu component graph); re-exported here as the historical import surface.
 */
export {
    foldPluginKey,
    headingFoldPluginKey,
    type FoldMeta,
    type FoldPluginState,
    type HeadingFoldMeta,
    type HeadingFoldState,
} from "../foldState";

// Trimmed to names with consumers OUTSIDE this directory — internal-only
// helpers (the per-kind body probes, the doc-based section resolver) are
// imported from ./foldModel directly by the fold layer's own files.
export {
    allFoldablePositions,
    cachedFoldRanges,
    computeFoldRanges,
    findHeadingFoldRange,
    findSectionHeadingPosAt,
    foldHiddenRange,
    foldedHiddenRanges,
    foldedSectionEnd,
    foldedSectionEnds,
    getHeadingLevel,
    hiddenRangeCoversTarget,
    isContainerNode,
    isHiddenTargetPos,
    isListNode,
    selectionCoverRange,
    setHeadingLevelAt,
} from "./foldModel";

export {
    computeFoldAnchors,
    resolveFoldAnchors,
    type FoldAnchors,
} from "./foldAnchors";

export {
    blockMarkerSpec,
    nestedChildSpec,
    wireMarkerButtonProtocol,
    type MarkerSpec,
} from "./foldGutter";

export {
    foldAllCommand,
    foldAtCaret,
    foldRevealKeymapPlugin,
    revealOnBackspace,
    revealOnDelete,
    revealOnEnter,
    revealPosition,
    unfoldAllCommand,
    unfoldAtCaret,
} from "./foldCommands";

export { headingFoldPlugin } from "./plugin";
