/**
 * The Settings gear dropdown. Its entries mirror the toolbar's native
 * right-click menu exactly, because both are built from TOOLBAR_MENU_COMMANDS -
 * ids, order and labels cannot drift, and both draw a separator on every
 * `menuGroup` change.
 */
import { IconSettings, IconChevronDown } from "@/ui/icons";
import { t, productName } from "@/i18n";
import { notifyOpenSettings, notifyOpenKeybindings, notifyOpenUrl, notifyWhatsNewSeen, notifyOpenHostPreferences, notifySetFormattingRowExpanded } from "@/messaging";
import { openShortcutsHelpLazy } from "../shortcutsHelp/loader";
import { appendRowChord, createMenuTrigger, createSwitchItem, makeSep } from "./menuPrimitives";
import type { EditorCommandId } from "../../../shared/editorCommands";
import { wireHoverMenu } from "./hoverMenu";
import { hostArranges } from "../../../shared/hostProfile";
import { TOOLBAR_MENU_COMMANDS, settingsMenuTitle } from "../../../shared/editorCommands";
import { commandAvailable } from "../../../shared/commandAvailability";
import { RELEASES_URL } from "../../../shared/product";

/**
 * The two layout actions the menu offers. They live on the layout controller,
 * which is built after the items it renders, so they arrive as callbacks
 * rather than as a controller reference.
 */
export interface SettingsMenuDeps {
    startCustomize: () => void;
    setToolbarVisible: (visible: boolean) => void;
    /**
     * The typography rows, for a surface that puts them here rather than in a
     * toolbar item of their own. Empty on every other surface, and the menu is
     * built the same way in both cases: it appends what it is given.
     */
    typographyRows?: (closeHolder: () => void) => HTMLElement[];
    /**
     * The Proofreading submenu's row (`checksMenu.ts`), which the gear holds on every
     * surface rather than the bar. Optional for the same reason the typography
     * rows are: a host whose syntax target withdraws every check it could offer
     * hands nothing, and the menu appends what it is given.
     */
    checksRow?: HTMLElement;
    /**
     * Whether the formatting row is open, asked at the moment the menu opens.
     *
     * A getter rather than a value, because the row's state is the host's and
     * changes from the host's own Settings window while this menu sits built.
     * Absent on a surface with no such row (`formattingInSecondRow`), and the
     * switch is not offered there.
     */
    isFormattingRowExpanded?: () => boolean;
}

/**
 * The live gear trigger, so the host's unread verdict can reach it without the
 * toolbar threading a callback through every layer between. There is one
 * settings menu per webview, and a webview is rebuilt from scratch on every
 * open, so the reference cannot go stale for a surviving element.
 */
let gearTrigger: HTMLElement | undefined;

/**
 * The formatting-row switch, held for the same reason and reached the same
 * way. Undefined on every surface that has no such row.
 */
let formattingRowSwitch: { setChecked: (on: boolean) => void } | undefined;

/**
 * The host has opened or shut the formatting row, so the switch that asked
 * draws the answer.
 *
 * Driven by the ANNOUNCEMENT rather than by the menu opening, which is the
 * rule docs/DESIGN_PRINCIPLES.md states for every mirrored control here: a
 * repaint on open would make this surface look right while the row itself
 * went quietly stale, and that failure is the hard one to notice.
 */
export function setFormattingRowChecked(expanded: boolean): void {
    formattingRowSwitch?.setChecked(expanded);
}

/**
 * Light or clear the unread dot. Advisory chrome: it appears, waits, and does
 * nothing on its own, so an unread verdict arriving after the toolbar is built
 * is the normal case rather than a race to guard.
 */
export function setWhatsNewUnread(unread: boolean): void {
    gearTrigger?.classList.toggle("tb-gear--unread", unread);
}

export function createSettingsMenu(
    { startCustomize, setToolbarVisible, typographyRows, checksRow, isFormattingRowExpanded }: SettingsMenuDeps,
): HTMLElement {
        const wrapEl = document.createElement("div");
        wrapEl.className = "tb-fmt-wrap";
        // Cleared rather than left to the assignment below, which is the one
        // difference from `gearTrigger` above: that one is written on every
        // build and cannot go stale, and this one is written only where the
        // switch is offered. A second build on a surface without it would
        // otherwise leave this pointing at the first build's detached row, and
        // every repaint would land on a node nobody can see.
        formattingRowSwitch = undefined;

        const gearBtn = createMenuTrigger({
            // The chevron is unconditional, as it is on every other trigger in
            // this bar. It says the control opens SOMETHING, which is as true
            // of a menu that waits for a click as of one that waits for a
            // rest; withholding it on a click surface left this one glyph
            // looking like a plain button among chevroned neighbours, because
            // the rule was only ever applied here.
            html: IconSettings + IconChevronDown,
            ariaLabel: t("Settings"),
        });
        gearTrigger = gearBtn;

        const menu = document.createElement("div");
        menu.className = "tb-fmt-menu tb-settings-menu";
        menu.style.display = "none";

        const addEntry = (label: string, onSelect: () => void, command?: EditorCommandId): void => {
            const entry = document.createElement("div");
            entry.className = "ui-menu-row tb-fmt-item";
            const labelEl = document.createElement("span");
            labelEl.textContent = label;
            entry.appendChild(labelEl);
            if (command !== undefined) appendRowChord(entry, command);
            entry.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                closeSettingsMenu(); // shared close — owns the Escape-layer unregister
                onSelect();
            });
            menu.appendChild(entry);
        };
        // The entries mirror the toolbar right-click menu exactly: both are
        // built from TOOLBAR_MENU_COMMANDS (shared/editorCommands.ts), so ids,
        // order, and labels can't drift, and both draw a separator on every
        // `menuGroup` change — here via makeSep(), natively via the
        // 1_layout/2_shortcuts/3_settings group prefixes (the contributions
        // test guards the package.json side). Edit Keyboard Shortcuts opens
        // the native UI filtered to this extension, where the user's
        // effective (possibly rebound) bindings are accurate.
        const menuActions: Record<string, () => void> = {
            customizeToolbar: () => startCustomize(),
            hideToolbar: () => setToolbarVisible(false),
            // Show (the in-editor cheatsheet overlay) above Edit (the native
            // UI) — table order in TOOLBAR_MENU_COMMANDS.
            openShortcutsHelp: () => { void openShortcutsHelpLazy(); },
            openKeyboardShortcuts: () => notifyOpenKeybindings(),
            openExtensionSettings: () => notifyOpenSettings(),
            // Hands the release-history URL to the host, which opens it in the
            // browser. Same one-liner as the registry entry in
            // webview/editorCommands.ts, because both are the whole action.
            openWhatsNew: () => notifyOpenUrl(RELEASES_URL),
            // The host application's own Settings window (the Mac app). Gated by
            // `appPreferences`, so the row is absent where there is no such
            // window, which is every host but that one.
            openHostPreferences: () => notifyOpenHostPreferences(),
        };
        // The EDITOR rows go after the LAYOUT group and before everything else:
        // the typography (where a surface keeps it here) and then Proofreading. They
        // are what somebody opens this menu to change, and a reader scanning
        // for "make the text bigger" or "stop underlining my adverbs" should
        // not have to pass a keyboard cheatsheet to reach either.
        //
        // Anchored to the first row that is NOT a layout row, rather than to
        // the first group boundary: a surface whose layout is fixed
        // (`fixedToolbarLayout`) has no layout rows and therefore no such
        // boundary, and anchoring to one put the typography rows at the bottom
        // of that menu instead of the top.
        //
        // One list rather than two insertion points, so the two cannot end up
        // on opposite sides of the plumbing on a surface that carries only one
        // of them. VS Code carries Proofreading alone, since its typography is a
        // toolbar item of its own.
        const rows: HTMLElement[] = [...(typographyRows?.(() => closeSettingsMenu()) ?? [])];
        // The formatting row's own switch, on the one surface that has such a
        // row to switch (`formattingInSecondRow`). It is offered here as well
        // as in the host's Settings window because the two questions are asked
        // at different moments: Settings is where somebody decides what they
        // want in general, and this is where somebody mid-document wants the
        // controls out of the way, or back, without leaving the window.
        //
        // Named as the host's own Settings row names it
        // (`SettingsForm.Row.formattingRow`), so one thing has one name across
        // the two places it can be flipped.
        //
        // The switch ASKS and never applies: the state belongs to the host,
        // which stores it and sends it to every window, and this page learns
        // the answer on the way back like any other (dock.ts). So the press
        // paints nothing, the menu stays open, and the switch moves when the
        // answer lands (`setFormattingRowChecked`). A switch that painted
        // itself would be right in this window and a guess about every other.
        const hasFormattingRow = Boolean(isFormattingRowExpanded) && hostArranges("formattingInSecondRow");
        if (hasFormattingRow && isFormattingRowExpanded) {
            const item = createSwitchItem(t("Formatting toolbar"));
            formattingRowSwitch = item;
            item.el.addEventListener("mousedown", (e) => {
                e.preventDefault();
                e.stopPropagation();
                notifySetFormattingRowExpanded(!isFormattingRowExpanded());
            });
            if (rows.length > 0) { rows.push(makeSep()); }
            rows.push(item.el);
        }
        if (checksRow) {
            // Beside the formatting row's switch with no rule between them,
            // and behind one where the typography ends. Typography is how the
            // text LOOKS; these two are what the editor PUTS ON it, a row of
            // controls and a set of underlines, which is near enough one
            // subject that a line between them was separating two rows rather
            // than two groups.
            if (rows.length > 0 && !hasFormattingRow) { rows.push(makeSep()); }
            rows.push(checksRow);
        }
        let typographyInserted = rows.length === 0;

        // The rows this surface actually offers, gathered before any of them
        // is drawn, because whether a rule is worth drawing depends on how
        // many rows are on each side of it and that is not known one row at a
        // time.
        //
        // A row the host cannot answer (its settings UI, its keybindings UI,
        // our release page) or an arrangement withdraws (the layout rows,
        // where the layout is not the user's) is not offered.
        const offered = TOOLBAR_MENU_COMMANDS.filter(
            (meta) => menuActions[meta.id] && commandAvailable(meta.id),
        );
        const groupSize = new Map<string | undefined, number>();
        for (const meta of offered) {
            groupSize.set(meta.menuGroup, (groupSize.get(meta.menuGroup) ?? 0) + 1);
        }
        /**
         * Whether the boundary between two groups earns a rule here.
         *
         * A separator's job is to separate GROUPS, and between two groups that
         * are each a single row it is just a line between two rows: it says
         * nothing the space around them does not, and a run of them turns a
         * short menu into a ladder. So a boundary is drawn only where at least
         * one side is more than one row.
         *
         * This is a fact about the surface rather than about the taxonomy, and
         * that is the point: the groups themselves are unchanged
         * (shared/editorCommands.ts, mirrored by the native context menu's
         * group prefixes), and a menu keeps every rule whose groups it
         * actually has. In VS Code every group has two rows and nothing moves;
         * on a surface that withdraws most of them, the keyboard cheatsheet
         * and the host's Settings row stop being fenced off from each other.
         */
        const boundaryEarnsRule = (before: string | undefined, after: string | undefined): boolean =>
            (groupSize.get(before) ?? 0) > 1 || (groupSize.get(after) ?? 0) > 1;

        let prevGroup: string | undefined;
        let first = true;
        for (const meta of offered) {
            if (!first && meta.menuGroup !== prevGroup && boundaryEarnsRule(prevGroup, meta.menuGroup)) {
                menu.appendChild(makeSep());
            }
            first = false;
            if (!typographyInserted && meta.menuGroup !== "layout") {
                menu.append(...rows, makeSep());
                typographyInserted = true;
            }
            prevGroup = meta.menuGroup;
            // The settings row names the product with the RUNTIME display
            // name, so a rename never leaves the menu stale.
            const label = meta.id === "openExtensionSettings"
                ? settingsMenuTitle(productName)
                : t(meta.title);
            addEntry(label, menuActions[meta.id] as () => void, meta.id);
        }

        // A menu with no group boundary after the layout rows would never reach
        // the insert above; the rows still have to land somewhere.
        if (!typographyInserted) {
            menu.append(makeSep(), ...rows);
        }

        const { close: closeSettingsMenu } = wireHoverMenu(wrapEl, gearBtn, menu, {
            onOpen: () => {
                // Opening the menu IS the looking, so clear here rather than on
                // the What's-new row: a user who opens the menu, sees the row
                // and decides not to read the notes has still seen the signal,
                // and a dot that survived that would be a nag.
                if (gearBtn.classList.contains("tb-gear--unread")) {
                    gearBtn.classList.remove("tb-gear--unread");
                    notifyWhatsNewSeen();
                }
            },
        });

        wrapEl.appendChild(gearBtn);
        wrapEl.appendChild(menu);
        return wrapEl;
}
