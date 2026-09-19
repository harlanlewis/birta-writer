/**
 * The file explorer's toolbar button, and the two declarations that decide
 * whether the bar draws one.
 *
 * `projectFiles` is the capability: a host with no directory to list has no
 * explorer, so there is nothing to toggle and no button.
 * `filesToggleInHostChrome` is the arrangement: the host HAS an explorer and
 * carries the control in its own window frame, so the bar withdraws the
 * button while the command stays live everywhere else.
 *
 * Both arms are here because either one alone is satisfied by a bar that
 * never draws the button at all.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { initToolbar } from "../components/toolbar";
import { runEditorCommand, setEditorCommandHost } from "../editorCommands";
import type { HostArrangement, HostCapability } from "../../shared/hostProfile";

interface Declaration {
    __i18n?: { host?: { capabilities: readonly HostCapability[]; arrangements: readonly HostArrangement[] } };
}

function declare(capabilities: HostCapability[], arrangements: HostArrangement[]): void {
    (globalThis as unknown as Declaration).__i18n = { host: { capabilities, arrangements } };
}

function buildToolbar(): HTMLElement {
    const topbar = document.createElement("div");
    topbar.className = "editor-topbar";
    document.body.appendChild(topbar);
    initToolbar(topbar, () => null);
    return topbar;
}

function filesButton(topbar: HTMLElement): HTMLElement | null {
    return topbar.querySelector<HTMLElement>(".tb-files-btn");
}

describe("toolbar file explorer button", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
    });

    afterEach(() => {
        delete (globalThis as unknown as Declaration).__i18n;
    });

    it("a host that lists directories and carries no control of its own should get the button", () => {
        declare(["projectFiles"], []);
        expect(filesButton(buildToolbar())).not.toBeNull();
    });

    it("a host that carries the control in its own chrome should get no button", () => {
        declare(["projectFiles"], ["filesToggleInHostChrome"]);
        expect(filesButton(buildToolbar())).toBeNull();
    });

    it("a host with no directory to list should get no button, arrangement or not", () => {
        declare([], []);
        expect(filesButton(buildToolbar())).toBeNull();
    });

    it("the withdrawn button should not withdraw the command it ran", () => {
        // The arrangement moves a control; it does not take the verb away.
        // A `runEditorCommand` that refused here would leave the host's own
        // button, its menu row and its key with nothing to call.
        declare(["projectFiles"], ["filesToggleInHostChrome"]);
        buildToolbar();
        let toggled = 0;
        setEditorCommandHost({ toggleFileExplorer: () => { toggled += 1; } });
        runEditorCommand("toggleFileExplorer", () => null);
        expect(toggled).toBe(1);
    });
});
