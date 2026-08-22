/**
 * The top main toolbar: this file builds the items and wires them together;
 * the sibling modules own the pieces.
 *
 *   menuPrimitives   the row and button vocabulary every menu is built from
 *   typography       the Font picker (preset, size, content width)
 *   containerPickers the Format / Lists / Code / Quote family dropdowns
 *   checksMenu       proofreading and the note-marker highlight
 *   settingsMenu     the gear dropdown
 *   debugMenu        the dev-only diagnostics dropdown
 *   linkPrompt       the Insert/Edit Link action
 *   imageInsertPanel the Insert Image dialog
 *   layout           zones, overflow, customize mode, whole-bar visibility
 *   registry         which items exist, and where they sit by default
 *   activeState      what container and marks the caret is in
 *   overflow / dnd / hoverMenu   the mechanisms layout and the menus drive
 *
 * What is left here is composition: build each item once, wrap it with its id,
 * hand the wrappers to the layout controller, and publish the toolbar-owned
 * actions to the shared editor-command registry so the palette and the context
 * menu reach the same code paths as the buttons.
 */
import { getView, type EditorView } from "@/pm";
import { runEditorCommand, setEditorCommandHost, type GetEditor } from "@/editorCommands";
import {
    IconBold,
    IconItalic,
    IconStrikethrough,
    IconHighlighter,
    IconCode,
    IconLink,
    IconImage,
    IconTable,
    IconFootnote,
    IconMath,
    IconMinus,
    IconEraser,
    IconSearch,
    IconFileCode,
    IconAlertTriangle,
    IconPencil,
    IconEye,
} from "@/ui/icons";
import { t } from "@/i18n";
import { withChord } from "@/commandChords";
import { btn } from "./menuPrimitives";
import { showImageInsertPanel } from "./imageInsertPanel";
import { createLinkPrompt } from "./linkPrompt";
import { createTypographyControl } from "./typography";
import { createFormatMenu, createListMenu, createCodeMenu, createQuoteMenu } from "./containerPickers";
import { createChecksMenu } from "./checksMenu";
import { createSettingsMenu } from "./settingsMenu";
import { createDebugMenu, type DebugOpts } from "./debugMenu";
import { createToolbarLayout, type ToolbarLayout } from "./layout";
import { ITEM_MUTATES, hostAvailableItems, type ToolbarItemId } from "./registry";
import { isReadOnly, setReadOnly, subscribeReadOnly } from "@/readOnly";
import { computeToolbarActiveState, DETACHED_STATE, type ToolbarActiveState } from "./activeState";
import { notifyOpenSettings, notifyOpenKeybindings, notifyResolveSyncConflict } from "@/messaging";
import type { ToolbarConfig, FontPreset, FontStacks, ProofreadOptionKey, LogseqReason } from "../../../shared/messages";
import { bindActivate } from "@/ui/dom";
import { applyTooltip } from "@/ui/tooltip";
import { type ContentWidthMode } from "../../../shared/contentWidth";
import { type BlockHandlesMode } from "../../../shared/blockHandles";
import './toolbar.css';

/**
 * The find bar, as the two gestures the toolbar needs from it. `open` is what
 * every command path runs; `toggle` is the magnifier's own press, which puts
 * an open bar away again.
 */
export interface FindControl {
    open: () => void;
    toggle: () => void;
}

export function initToolbar(
    topbar: HTMLElement,
    getEditor: GetEditor,
    debugOpts?: DebugOpts,
    onUploadImage?: (file: File, altText: string) => Promise<string>,
    onGetProjectImages?: (
        id: string,
    ) => Promise<Array<{
        relPath: string;
        webviewUri: string;
        name: string;
    }> | null>,
    find?: FindControl,
    onSwitchToSource?: () => void,
    onShowProofreading?: () => void,
): {
    onSelectionChange: (view: EditorView) => void;
    /** Blank the bar while focus is in a nested editable island (a callout title). */
    setDetached: () => void;
    setDebugMode: (enabled: boolean) => void;
    /** Show/hide the disk-drift badge (file on disk changed vs unsaved edits). */
    setSyncConflict: (active: boolean) => void;
    /** Show the Logseq badge with the reason's tooltip, or hide it (null). */
    setLogseq: (reason: LogseqReason | null) => void;
    /** Rebuild the toolbar for a changed per-item placement config. */
    applyConfig: (config: ToolbarConfig) => void;
    /** Update the font picker's active-preset indicator (and optional stack previews). */
    setFontPreset: (preset: FontPreset, stacks?: FontStacks) => void;
    /** Update the font picker's size-stepper display (percent). */
    setFontSize: (size: number) => void;
    /** Update the typography menu's content-width segmented control (and cache the fixed width). */
    setContentWidth: (mode: ContentWidthMode, fixedCss?: string) => void;
    /** Update the typography menu's block-handles radio rows. */
    setBlockHandles: (mode: BlockHandlesMode) => void;
    /** Apply + persist a font preset (slash-menu action; works with the bar hidden). */
    chooseFontPreset: (preset: FontPreset) => void;
    /** Step the content font size up/down (slash-menu action; works with the bar hidden). */
    stepFontSize: (delta: 1 | -1) => void;
    /** Put the content font size back to its default (works with the bar hidden). */
    resetFontSize: () => void;
    /** Toggle a proofread option (slash-menu action; works with the bar hidden). */
    toggleProofread: (key: ProofreadOptionKey) => void;
    /** Whether the bar is currently shown (drives the slash toggle's label). */
    isVisible: () => boolean;
    /** Show or hide the bar for this session, leaving `toolbar.visible` alone. */
    applyToolbarVisible: (visible: boolean) => void;
    /** Opens the Insert/Edit Link prompt (toolbar button and Cmd/Ctrl+K). */
    openLinkPrompt: () => void;
} {
    // TOC toggling lives on the panel's edge tab; undo/redo stay on their
    // keyboard shortcuts — neither needs a toolbar button.

    // Every item is built exactly once and wrapped in a `.tb-item`; the layout
    // controller re-parents the wrappers into their zones, so button listeners
    // survive a layout change without rebuilding.
    const items: Partial<Record<ToolbarItemId, HTMLElement>> = {};
    function wrap(id: string, child: HTMLElement): HTMLElement {
        const w = document.createElement("div");
        w.className = "tb-item";
        w.dataset["itemId"] = id;
        w.appendChild(child);
        return w;
    }

    // Assigned once every item exists (the layout renders them). The item
    // builders below reach it only from event handlers, which cannot run
    // before it is assigned.
    let layout: ToolbarLayout;

    // The items this host can carry (ITEM_HOST_CAPABILITY): a gated item whose
    // capability the host does not declare is never built, so no zone, tray or
    // overflow menu can show it. The layout applies the same set to the config.
    const available = hostAvailableItems();

    // ── Block-type dropdown (P / H1–H6) ──
    const formatPicker = createFormatMenu(getEditor);
    items.format = wrap("format", formatPicker.el);

    // ── Font picker (preset, size, content width) ──
    const typography = createTypographyControl();
    items.fontPreset = wrap("fontPreset", typography.el);

    // ── Inline formatting ─────────────────────────────
    // Button refs kept so onSelectionChange can light up the mark currently under
    // the caret (the toolbar reflects the selection's state).
    const boldBtn = btn(IconBold, withChord(t("Bold"), "toggleBold"), () =>
        runEditorCommand("toggleBold", getEditor));
    items.bold = wrap("bold", boldBtn);
    const italicBtn = btn(IconItalic, withChord(t("Italic"), "toggleItalic"), () =>
        runEditorCommand("toggleItalic", getEditor));
    items.italic = wrap("italic", italicBtn);
    const strikeBtn = btn(
        IconStrikethrough,
        withChord(t("Strikethrough"), "toggleStrikethrough"),
        () => runEditorCommand("toggleStrikethrough", getEditor),
    );
    items.strikethrough = wrap("strikethrough", strikeBtn);
    const highlightBtn = btn(IconHighlighter, withChord(t("Highlight"), "toggleHighlight"), () =>
        runEditorCommand("toggleHighlight", getEditor));
    items.highlight = wrap("highlight", highlightBtn);
    const inlineCodeBtn = btn(IconCode, withChord(t("Inline Code"), "toggleInlineCode"), () =>
        runEditorCommand("toggleInlineCode", getEditor));
    items.inlineCode = wrap("inlineCode", inlineCodeBtn);
    items.clearFormatting = wrap("clearFormatting", btn(IconEraser, withChord(t("Clear Formatting"), "clearFormatting"), () =>
        runEditorCommand("clearFormatting", getEditor),
    ));

    // ── Insert ────────────────────────────────────────
    // Link: also invoked by the Cmd/Ctrl+K shortcut
    // (webview/keyboardShortcuts.ts), so it is exposed on the returned
    // controller as openLinkPrompt.
    let linkBtnEl: HTMLButtonElement;
    const openLinkPrompt = createLinkPrompt(
        getEditor,
        () => (linkBtnEl.isConnected ? linkBtnEl : layout.toolbar),
    );
    // The chord prints only where it cannot be wrong: inside VS Code the
    // binding is rebindable and unreadable from here, so `withChord` omits it;
    // on a host whose menu IS the binding it resolves to that key
    // (webview/commandChords.ts).
    linkBtnEl = btn(
        IconLink,
        withChord(t("Insert/Edit Link"), "insertLink"),
        openLinkPrompt,
    );
    items.link = wrap("link", linkBtnEl);

    // Image: open the insert panel, then insert an image node
    const openImagePanel = (): void => {
        showImageInsertPanel(
            (alt, src) => {
                const editor = getEditor();
                if (!editor) {
                    return;
                }
                editor.action((ctx) => {
                    const view = getView(ctx);
                    const { state } = view;
                    const imageType = state.schema.nodes["image"];
                    if (!imageType) {
                        return;
                    }
                    const node = imageType.create({ src, alt, title: "" });
                    view.dispatch(state.tr.replaceSelectionWith(node));
                    view.focus();
                });
            },
            onUploadImage,
            onGetProjectImages,
        );
    };
    // Host-gated (shared/hostProfile.ts): the image button needs a store
    // to upload to, and a host without one gets no button at all. The panel
    // itself stays wired, because `insertImage` is gated at runEditorCommand.
    const imgBtnEl = available.has("image") ? btn(IconImage, withChord(t("Insert Image"), "insertImage"), openImagePanel) : null;
    if (imgBtnEl) { items.image = wrap("image", imgBtnEl); }
    const tableBtn = btn(IconTable, withChord(t("Insert Table"), "insertTable"), () =>
        runEditorCommand("insertTable", getEditor));
    items.table = wrap("table", tableBtn);
    const footnoteBtnEl = btn(IconFootnote, withChord(t("Insert Footnote"), "insertFootnote"), () =>
        runEditorCommand("insertFootnote", getEditor),
    );
    items.footnote = wrap("footnote", footnoteBtnEl);
    const mathBtnEl = btn(IconMath, withChord(t("Inline Math"), "insertMath"), () =>
        runEditorCommand("insertMath", getEditor),
    );
    items.math = wrap("math", mathBtnEl);

    // ── Container family dropdowns ──
    // Each one's menu row shows WHICH member the caret is in; its trigger
    // shows THAT it is in one (applyActiveState below drives both).
    const listPicker = createListMenu(getEditor);
    items.listMenu = wrap("listMenu", listPicker.el);
    const codePicker = createCodeMenu(getEditor);
    items.codeBlock = wrap("codeBlock", codePicker.el);
    const hrBtnEl = btn(IconMinus, withChord(t("Horizontal Rule"), "insertHorizontalRule"), () =>
        runEditorCommand("insertHorizontalRule", getEditor),
    );
    items.horizontalRule = wrap("horizontalRule", hrBtnEl);
    const quotePicker = createQuoteMenu(getEditor);
    items.quote = wrap("quote", quotePicker.el);

    // ── Debug tools (dev-only dropdown, gated by debugMode; pinned before
    //    Settings in the right zone, not user-placeable) ──
    const dbgItem = debugOpts
        ? wrap("debug", createDebugMenu(debugOpts, getEditor))
        : null;

    // ── Disk-drift badge (pinned at the front of the right zone, not
    //    user-placeable; hidden unless the extension flags disk drift: the file
    //    changed on disk while there are unsaved edits). Advisory only —
    //    clicking opens the native reload/compare picker; nothing auto-edits. ──
    const syncConflictItem = wrap(
        "syncConflict",
        btn(
            IconAlertTriangle,
            t("This file changed on disk since your last edit — click to reload or compare"),
            () => notifyResolveSyncConflict(),
            "tb-sync-conflict-btn",
        ),
    );
    syncConflictItem.style.display = "none";

    // ── Logseq badge (pinned just after the disk-drift badge, not
    //    user-placeable; hidden unless the extension says this file is being
    //    handled as Logseq). It is a WORD rather than a glyph on purpose: the
    //    thing it has to communicate is a format's name, and no icon says
    //    "Logseq" without being learned first.
    //
    //    One treatment, three reasons (docs/DESIGN_PRINCIPLES.md, "One
    //    treatment per meaning"). Whether the graph, the file's own content, or
    //    the setting put the badge there changes the tooltip, never the
    //    drawing: what the user acts on is the same in all three cases, and the
    //    reason is what they read when they want to know why.
    //
    //    Deliberately absent from TOOLBAR_ITEM_IDS, so there is no
    //    `toolbar.items.logseq` placement setting. `birta.logseq` already
    //    decides whether this exists at all, and a second switch for the same
    //    question is the failure "One switch, one announcement" names. The
    //    disk-drift badge is the precedent for a pinned, non-placeable status
    //    item. ──
    const LOGSEQ_TOOLTIPS: Record<LogseqReason, string> = {
        graph: t("This file is in a Logseq graph, so its outliner conventions are preserved. Click to change."),
        content: t("This file reads as a Logseq page, so its outliner conventions are preserved. Click to change."),
        forced: t("Every file is handled as Logseq because you set it that way. Click to change."),
    };
    // Built by hand rather than through createButton because the tooltip text
    // depends on the reason, which arrives after the bar is built: this keeps
    // the tooltip HANDLE so the text can be set later without a second binding.
    const logseqBtn = document.createElement("button");
    logseqBtn.className = "ui-btn tb-btn tb-logseq-btn";
    logseqBtn.textContent = t("Logseq");
    const logseqTip = applyTooltip(logseqBtn, "", { placement: "below" });
    bindActivate(logseqBtn, () => notifyOpenSettings("birta.logseq"));
    const logseqItem = wrap("logseq", logseqBtn);
    logseqItem.style.display = "none";

    // ── Checks (spelling, grammar, style + the note-marker highlight) ──
    // Host-gated: the menu names a proofreading engine and a review sidebar,
    // and a host without them gets neither the item nor its hooks.
    const checks = available.has("styleCheck") ? createChecksMenu(onShowProofreading) : null;
    if (checks) { items.styleCheck = wrap("styleCheck", checks.el); }

    // Mode switch: leave the rendered editor for the raw markdown text editor.
    // Same code path as the switch-to-text-editor keybinding and the tab-bar
    // button (the callback captures the first visible source line so the
    // viewport is preserved). No shortcut labels on these tooltips: both are
    // user-rebindable contributed keybindings and the webview cannot query
    // their effective bindings.
    // Edit / Read-only (MAR-53). Two states on one control, because the state
    // is binary and two idempotent buttons would always leave one that does
    // nothing. Read-only's absence of edits is indistinguishable from "I have
    // not typed yet", so the button carries the signal that owes the user
    // (docs/DESIGN_PRINCIPLES.md, "A silent absence needs a signal"): the icon
    // says which mode is ACTIVE, and the tooltip says what clicking does.
    // Host-gated: the toggle is only built for a host that owns read-only
    // mode. The dimming below is NOT gated, because it is the mode's own
    // correctness and the mode can be seeded without the toggle.
    const readOnlyBtn = available.has("readOnly") ? btn(IconPencil, "", () => setReadOnly(!isReadOnly())) : null;
    const readOnlyTip = readOnlyBtn ? applyTooltip(readOnlyBtn, "", { placement: "below" }) : null;
    const paintReadOnly = (readOnly: boolean): void => {
        if (readOnlyBtn && readOnlyTip) {
            readOnlyBtn.innerHTML = readOnly ? IconEye : IconPencil;
            readOnlyBtn.classList.toggle("tb-btn--active", readOnly);
            readOnlyBtn.setAttribute("aria-pressed", String(readOnly));
            readOnlyBtn.setAttribute("aria-label", readOnly ? t("Read-only") : t("Editing"));
            readOnlyTip.setText(readOnly
                ? t("Read-only — edits are locked. Click to edit.")
                : t("Editing. Click to lock edits."));
        }
        // Every item that acts on the document goes visibly dead, rather than
        // staying live and no-opping against the transaction filter.
        for (const [id, el] of Object.entries(items)) {
            if (!ITEM_MUTATES[id as ToolbarItemId]) { continue; }
            // `disabled` alone: `.ui-btn:disabled` already carries the dimmed
            // resting state and the suppressed hover, so a class of our own
            // here would be a second channel saying the same thing.
            for (const control of el?.querySelectorAll("button") ?? []) {
                control.disabled = readOnly;
            }
        }
    };
    if (readOnlyBtn) { items.readOnly = wrap("readOnly", readOnlyBtn); }

    // Host-gated too: the callback is the host's text editor, and a host that
    // has none passes nothing (webview/index.ts).
    if (onSwitchToSource && available.has("viewSource")) {
        items.viewSource = wrap("viewSource", btn(
            IconFileCode,
            t("Edit Raw Markdown"),
            onSwitchToSource,
        ));
    }
    if (find) {
        // The BUTTON toggles and the command opens, and the two are different
        // gestures rather than an inconsistency. Pressing the magnifier a
        // second time is a press on a control that is visibly showing
        // something, so it puts it away; Cmd+F pressed twice is somebody
        // reaching for the field, and closing it under them is the wrong
        // answer to that (VS Code's find widget makes the same split).
        items.find = wrap("find", btn(IconSearch, withChord(t("Find"), "openFind"), find.toggle));
    }
    // Settings gear is a hover dropdown: open the native settings, or enter the
    // drag-and-drop "Customize toolbar" mode. Its two layout actions are
    // thunks because the layout controller is built below, once every item it
    // renders exists.
    items.settings = wrap("settings", createSettingsMenu({
        startCustomize: () => layout.startCustomize(),
        setToolbarVisible: (visible) => layout.setToolbarVisible(visible),
        // Empty unless the surface asked for that arrangement, in which case
        // the fontPreset item above is the empty one instead. The control is
        // built either way, so `chooseFontPreset` and its siblings reach the
        // same code from the palette and the slash menu whichever it is.
        typographyRows: (close) => typography.gearRows(close),
    }));

    // ── Placement, overflow, customize mode, whole-bar visibility ──
    layout = createToolbarLayout({ topbar, items, dbgItem, syncConflictItem, logseqItem });

    // Paint the launch state, then repaint from the mode's one announcement —
    // never from a private copy, and never defensively on menu open.
    paintReadOnly(isReadOnly());
    subscribeReadOnly(paintReadOnly);

    // Expose the toolbar-owned actions to the shared editor-command registry so
    // the command palette / context menu reach the exact same code paths.
    // (openFindReplace, toggleToc and editFrontmatter are wired in index.ts.)
    setEditorCommandHost({
        openLinkPrompt,
        openImagePanel,
        ...(find ? { openFind: find.open } : {}),
        // Toolbar right-click menu entries (mirroring the settings gear).
        hideToolbar: () => layout.setToolbarVisible(false),
        showToolbar: () => layout.setToolbarVisible(true),
        customizeToolbar: () => layout.startCustomize(),
        openExtensionSettings: () => notifyOpenSettings(),
        openKeyboardShortcuts: () => notifyOpenKeybindings(),
        // Font/proofread controls — the same code paths as the toolbar rows and
        // the slash menu, reachable from the palette even with the bar hidden.
        chooseFontPreset: typography.chooseFontPreset,
        stepFontSize: typography.stepFontSize,
        resetFontSize: typography.resetFontSize,
        ...(checks ? { toggleProofread: checks.toggleProofread, toggleNoteHighlights: checks.toggleNoteHighlights } : {}),
        toggleToolbar: () => layout.setToolbarVisible(!layout.isVisible()),
    });

    // Reflect a derived active-state across the whole bar. Split out from
    // onSelectionChange so the same wiring drives the "detached" state (focus in a
    // contenteditable island outside ProseMirror — see setDetached below).
    const applyActiveState = (active: ToolbarActiveState): void => {
        // Bar buttons: quiet toggle-on for the inline mark / container / selected
        // atom the caret sits on. A hidden/overflowed button still exists —
        // toggling its class is harmless.
        const setBtnActive = (el: HTMLElement | null, on: boolean): void => {
            el?.classList.toggle("tb-btn--active", on);
        };
        setBtnActive(boldBtn, active.marks.bold);
        setBtnActive(italicBtn, active.marks.italic);
        setBtnActive(strikeBtn, active.marks.strikethrough);
        setBtnActive(highlightBtn, active.marks.highlight);
        setBtnActive(inlineCodeBtn, active.marks.inlineCode);
        // A real `[text](url)` link is a mark; a `[[wikilink]]` is a node-selected
        // atom. Both light the one Link button.
        setBtnActive(linkBtnEl, active.marks.link || active.wikiLink);
        setBtnActive(mathBtnEl, active.inlineMath);
        setBtnActive(imgBtnEl, active.imageSelected);
        setBtnActive(footnoteBtnEl, active.footnote);
        setBtnActive(hrBtnEl, active.hr);
        setBtnActive(tableBtn, active.inTable);
        setBtnActive(listPicker.trigger, active.list !== null);
        setBtnActive(quotePicker.trigger, active.quote !== null);
        setBtnActive(codePicker.trigger, active.code !== null);

        // Format (text hierarchy) and the container menu rows: each picker
        // fills the row for the exact member the caret is in, and greys out
        // where the schema will not hold that family at all. Quote takes no
        // applicability: it WRAPS, so it reaches past a table cell and quotes
        // the whole table rather than doing nothing.
        formatPicker.setActive(active.formatApplicable, active.headingLevel);
        listPicker.setActive(active.list, active.listApplicable);
        quotePicker.setActive(active.quote);
        codePicker.setActive(active.code, active.codeApplicable);
    };

    return {
        onSelectionChange(view: EditorView): void {
            // One derivation of "what state is the caret in"; the toolbar mirrors it.
            applyActiveState(computeToolbarActiveState(view.state));
        },
        setDetached(): void {
            // Focus is in a nested editable island (a callout title) — the frozen
            // PM selection no longer describes where the user is typing, so blank
            // the bar rather than assert a stale block.
            applyActiveState(DETACHED_STATE);
        },
        setDebugMode: layout.setDebugMode,
        setSyncConflict: layout.setSyncConflict,
        setLogseq(reason: LogseqReason | null): void {
            if (reason) { logseqTip.setText(LOGSEQ_TOOLTIPS[reason]); }
            layout.setLogseq(reason !== null);
        },
        applyConfig: layout.applyConfig,
        setFontPreset: typography.setFontPreset,
        setFontSize: typography.setFontSize,
        setContentWidth: typography.setContentWidth,
        setBlockHandles: typography.setBlockHandles,
        // Slash-menu action hooks — the same code paths as the menu rows,
        // usable while the bar itself is hidden.
        chooseFontPreset: typography.chooseFontPreset,
        stepFontSize: typography.stepFontSize,
        resetFontSize: typography.resetFontSize,
        toggleProofread: (key) => checks?.toggleProofread(key),
        isVisible: layout.isVisible,
        applyToolbarVisible: layout.applyToolbarVisible,
        openLinkPrompt,
    };
}
