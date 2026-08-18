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
import { createMenuTrigger, makeSep } from "./menuPrimitives";
import { wireHoverMenu } from "./hoverMenu";
import { TOOLBAR_MENU_COMMANDS, settingsMenuTitle } from "../../../shared/editorCommands";
import { hostHasCommand } from "../../../shared/hostCapabilities";
import { RELEASES_URL } from "../../../shared/product";

/**
 * The two layout actions the menu offers. They live on the layout controller,
 * which is built after the items it renders, so they arrive as callbacks
 * rather than as a controller reference.
 */
export interface SettingsMenuDeps {
    startCustomize: () => void;
    setToolbarVisible: (visible: boolean) => void;
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

export function createSettingsMenu({ startCustomize, setToolbarVisible }: SettingsMenuDeps): HTMLElement {
        const wrapEl = document.createElement("div");
        wrapEl.className = "tb-fmt-wrap";

        const gearBtn = createMenuTrigger({
            html: IconSettings + IconChevronDown,
            ariaLabel: t("Settings"),
        });
        gearTrigger = gearBtn;

        const menu = document.createElement("div");
        menu.className = "tb-fmt-menu tb-settings-menu";
        menu.style.display = "none";

        const addEntry = (label: string, onSelect: () => void): void => {
            const entry = document.createElement("div");
            entry.className = "ui-menu-row tb-fmt-item";
            entry.textContent = label;
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
            // The host application's own Settings window (Jot). Gated by
            // `appPreferences`, so the row is absent where there is no such
            // window, which is every host but that one.
            openHostPreferences: () => notifyOpenHostPreferences(),
        };
        let prevGroup: string | undefined;
        for (const meta of TOOLBAR_MENU_COMMANDS) {
            const action = menuActions[meta.id];
            // A row the host cannot answer (its settings UI, its keybindings
            // UI, our release page) is not offered; the layout rows stay.
            if (!action || !hostHasCommand(meta.id)) { continue; }
            if (prevGroup !== undefined && meta.menuGroup !== prevGroup) {
                menu.appendChild(makeSep());
            }
            prevGroup = meta.menuGroup;
            // The settings row names the product with the RUNTIME display
            // name, so a rename never leaves the menu stale.
            const label = meta.id === "openExtensionSettings"
                ? settingsMenuTitle(productName)
                : t(meta.title);
            addEntry(label, action);
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
