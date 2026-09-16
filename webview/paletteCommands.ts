/**
 * webview/paletteCommands.ts
 *
 * What a host's own command palette may offer on THIS surface, posted to the
 * host as `paletteCommands` (MAR-458 consumes it in the Mac app).
 *
 * The list is derived, never kept: it is the command table filtered by the
 * one predicate every surface asks (`commandAvailable`), so a host palette
 * offers exactly the commands the gear, the slash row and a chord would, and
 * cannot drift from them. It is posted in answer to `requestPaletteCommands`
 * and, once a host has asked, again whenever the publishing targets change,
 * because a target is the one input to that predicate that moves while the
 * page is open. Never unprompted: the frame contract (docs/HOSTING.md) names
 * what a host is told without asking, and a host with no palette has no use
 * for this.
 *
 * Two kinds of command qualify, and the second is why this is not simply the
 * `palette` flag. `palette: true` means VS Code's palette lists it, which is
 * the right claim for every command VS Code can honour. A command gated on an
 * app-only capability (`APP_ONLY_CAPABILITIES`) is `palette: false` there,
 * because VS Code cannot honour it and a row naming it would be a row that
 * does nothing; on the surface that CAN, it is exactly what a palette should
 * offer, so those join the list when the host declares the capability. Both
 * kinds share the property the flag really encodes, which is that the
 * command runs with no argument: a table-cell command needs a target and is
 * neither `palette: true` nor app-only, so it stays out.
 *
 * `section` is the heading the palette prints the command under: the host's
 * own menu where the host binds a key to the command (`HostShortcut.section`),
 * so a palette and a menu bar name the same group, and a generic heading for
 * everything else.
 */
import { EDITOR_COMMANDS } from "../shared/editorCommands";
import { commandAvailable } from "../shared/commandAvailability";
import { APP_ONLY_CAPABILITIES, hostShortcuts } from "../shared/hostProfile";
import type { PaletteCommand } from "../shared/messages";
import { notifyPaletteCommands } from "./messaging";
import { t } from "./i18n";

/** The heading for a command no host menu names. */
const GENERIC_SECTION = "Editor";

/** The commands a host palette may offer here, in table order. */
export function paletteCommandList(): PaletteCommand[] {
    const sectionByCommand = new Map<string, string>();
    for (const shortcut of hostShortcuts()) {
        if (shortcut.command && shortcut.section && !sectionByCommand.has(shortcut.command)) {
            sectionByCommand.set(shortcut.command, shortcut.section);
        }
    }
    const items: PaletteCommand[] = [];
    for (const meta of EDITOR_COMMANDS) {
        const appOnly = "hostCapability" in meta && meta.hostCapability !== undefined
            && APP_ONLY_CAPABILITIES.includes(meta.hostCapability);
        if (!meta.palette && !appOnly) { continue; }
        if (!commandAvailable(meta.id)) { continue; }
        items.push({
            id: meta.id,
            title: t(meta.title),
            section: sectionByCommand.get(meta.id) ?? t(GENERIC_SECTION),
        });
    }
    return items;
}

/** Whether a host has asked; only then does a later change get posted. */
let asked = false;

/** The host asked: answer now, and keep answering as the list changes. */
export function answerPaletteCommandsRequest(): void {
    asked = true;
    notifyPaletteCommands(paletteCommandList());
}

/** The list may have changed; a host that asked hears the new one. */
export function repostPaletteCommandsIfAsked(): void {
    if (asked) { notifyPaletteCommands(paletteCommandList()); }
}
