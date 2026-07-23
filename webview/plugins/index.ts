export { anchorSyncPlugin, headingRangeTouched } from "./anchorSync";
export { calcAutoInsertPlugin, calcRefreshPlugin, calcSuggestPlugin } from "./calc";
export { insertCalloutCommand } from "./callouts";
export { toggleHighlightCommand } from "./highlight";
export { caretScrollMarginPlugin } from "./caretScrollMargin";
export { contentGuardPlugin, tagContentGuard } from "./contentGuard";
export { docChangePlugin, setDocChangeListener } from "./docChange";
export { codeBlockBackspacePlugin } from "./codeBlockBackspace";
export { codeBlockSelectAllPlugin } from "./codeBlockSelectAll";
export { copyMarkdownPlugin } from "./copyMarkdown";
export {
    footnoteNumberingPlugin,
    footnoteReferenceInputRule,
    insertFootnoteCommand,
} from "./footnotes";
export { formatKeymapPlugin } from "./formatKeymap";
export { headingEmptyDeletePlugin } from "./headingEmptyDelete";
export {
    foldAllCommand,
    foldAtCaret,
    foldRevealKeymapPlugin,
    headingFoldPlugin,
    unfoldAllCommand,
    unfoldAtCaret,
} from "./headingFold";
export { headingAbsoluteInputRule } from "./headingInput";
export { headingStickyPlugin } from "./headingSticky";
export { historyKeymapPlugin, historyPlugin } from "./history";
export {
    horizontalRuleKeymapPlugin,
    horizontalRulePlugin,
    trailingHrParagraphPlugin,
} from "./horizontalRule";
export { linkInputRule } from "./linkInputRule";
export { linkUrlCompletePlugin } from "./linkUrlComplete";
export { detectPastedLinkTarget, pasteLinkPlugin } from "./pasteLink";
// NOTE: plugins/embed is deliberately NOT re-exported here. The barrel is in
// the eager graph, and the embed plugin must stay lazy (dynamic import in
// editor.ts, gated on the network master switch). Import it directly.
export { mathInlineEditPlugin } from "./mathInlineEdit";
export { wikiLinkCompletePlugin } from "./wikiLinkComplete";
export {
    listAutoJoinPlugin,
    listEnterPlugin,
    listLiftPlugin,
    listItemSpreadBoolPlugins,
    listSpreadNormalizePlugin,
} from "./list";
export { listMergeSuggestPlugin } from "./listMergeSuggest";
export { pendingRangePlugin, setPendingRange } from "./pendingRange";
export { getProofreadConfig, proofreadPlugin, setProofreadConfig } from "./proofread";
export { registerSelectionChangeHandler, selectionPlugin } from "./selection";
export { setSlashMenuHost, slashMenuPlugin } from "./slashMenu";
export { tableAlignDefaultPlugin } from "./tableAlignDefault";
export { cellClickFixPlugin } from "./tableCellClickFix";
export { setLogTableSel } from "./tableDebug";
export { blockKeysPlugin, deleteSelectedBlocks, duplicateSelectedBlocks, moveSelectedBlocks } from "./blockKeys";
export { tabKeymapPlugin } from "./tabKeymap";
export { tableKeymapPlugin } from "./tableKeymap";
export { transformToLowercase, transformToTitleCase, transformToUppercase } from "./caseTransform";
export { insertParagraphAfter, insertParagraphBefore, insertParagraphKeymapPlugin } from "./insertParagraph";
export { joinLinesCommand } from "./joinLines";
export { expandSelection, shrinkSelection, smartSelectKeymapPlugin } from "./smartSelect";
