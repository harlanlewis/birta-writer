/**
 * The Settings gear dropdown. Its entries mirror the toolbar's native
 * right-click menu exactly, because both are built from TOOLBAR_MENU_COMMANDS -
 * ids, order and labels cannot drift, and both draw a separator on every
 * `menuGroup` change.
 */
import { IconSettings, IconChevronDown } from "@/ui/icons";
import { t, productName } from "@/i18n";
import { notifyOpenSettings, notifyOpenKeybindings, notifyOpenUrl, notifyWhatsNewSeen, notifyOpenHostPreferences } from "@/messaging";
import { openShortcutsHelpLazy } from "../shortcutsHelp/loader";
import { appendRowChord, createMenuTrigger, makeSep } from "./menuPrimitives";
import type { EditorCommandId } from "../../../shared/editorCommands";
import { wireHoverMenu } from "./hoverMenu";
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
     * The Checks submenu's row (`checksMenu.ts`), which the gear holds on every
     * surface rather than the bar. Optional for the same reason the typography
     * rows are: a host whose syntax target withdraws every check it could offer
     * hands nothing, and the menu appends what it is given.
     */
    checksRow?: HTMLElement;
}

/**
 * The live gear trigger, so the host's unread verdict can reach it without the
 * toolbar threading a callback through every layer between. There is one
 * settings menu per webview, and a webview is rebuilt from scratch on every
 * open, so the reference cannot go stale for a surviving element.
 */
let gearTrigger: HTMLElement | undefined;

/**
 * Light or clear the unread dot. Advisory chrome: it appears, waits, and does
 * nothing on its own, so an unread verdict arriving after the toolbar is built
 * is the normal case rather than a race to guard.
 */
export function setWhatsNewUnread(unread: boolean): void {
    gearTrigger?.classList.toggle("tb-gear--unread", unread);
}

export function createSettingsMenu({ startCustomize, setToolbarVisible, typographyRows, checksRow }: SettingsMenuDeps): HTMLElement {
        const wrapEl = document.createElement("div");
        wrapEl.className = "tb-fmt-wrap";

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
        // the typography (where a surface keeps it here) and then Checks. They
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
        // of them. VS Code carries Checks alone, since its typography is a
        // toolbar item of its own.
        const rows: HTMLElement[] = [...(typographyRows?.(() => closeSettingsMenu()) ?? [])];
        if (checksRow) {
            // Typography is how the text LOOKS and Checks is what the editor
            // SAYS about it: two subjects, so a rule between them.
            if (rows.length > 0) { rows.push(makeSep()); }
            rows.push(checksRow);
        }
        let typographyInserted = rows.length === 0;

        let prevGroup: string | undefined;
        for (const meta of TOOLBAR_MENU_COMMANDS) {
            const action = menuActions[meta.id];
            // A row the host cannot answer (its settings UI, its keybindings
            // UI, our release page) or an arrangement withdraws (the layout
            // rows, where the layout is not the user's) is not offered.
            if (!action || !commandAvailable(meta.id)) { continue; }
            if (prevGroup !== undefined && meta.menuGroup !== prevGroup) {
                menu.appendChild(makeSep());
            }
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
            addEntry(label, action, meta.id);
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
