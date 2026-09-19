/**
 * The formatting row's switch in the gear menu.
 *
 * Two claims, and the second is the one that is easy to lose. The switch is
 * offered only where there IS such a row (`formattingInSecondRow`); and it
 * ASKS the host rather than flipping the row, because the row's state is the
 * host's setting and every window has to hear the same answer (dock.ts).
 *
 * A build that applied the flip locally would look correct in the window it
 * was pressed in and disagree with every other one until the host answered,
 * which is a state no screenshot of one window can show.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { initToolbar } from "../components/toolbar";
import type { Toolbar } from "../components/toolbar";
import type { HostArrangement, HostCapability } from "../../shared/hostProfile";

interface Declaration {
    __i18n?: {
        host?: { capabilities: readonly HostCapability[]; arrangements: readonly HostArrangement[] };
        formattingRowExpanded?: boolean;
    };
}

const api = (globalThis as unknown as { acquireVsCodeApi: () => { postMessage: ReturnType<typeof vi.fn> } })
    .acquireVsCodeApi();

function declare(arrangements: HostArrangement[], expanded = false): void {
    (globalThis as unknown as Declaration).__i18n = {
        host: { capabilities: [], arrangements },
        formattingRowExpanded: expanded,
    };
}

let toolbar: Toolbar;

function buildToolbar(): HTMLElement {
    const topbar = document.createElement("div");
    topbar.className = "editor-topbar";
    document.body.appendChild(topbar);
    toolbar = initToolbar(topbar, () => null);
    return topbar;
}

/** The gear's own switch row, never one of the Proofreading submenu's twenty. */
function rowSwitch(topbar: HTMLElement): HTMLElement | null {
    return topbar.querySelector<HTMLElement>(".tb-settings-menu > .tb-switch-item");
}

function posted(): { type: string; expanded?: boolean }[] {
    return api.postMessage.mock.calls.map((c) => c[0] as { type: string; expanded?: boolean });
}

describe("the formatting row's switch in the gear menu", () => {
    beforeEach(() => {
        document.body.innerHTML = "";
        api.postMessage.mockClear();
    });

    afterEach(() => {
        delete (globalThis as unknown as Declaration).__i18n;
    });

    it("a surface that arranges a formatting row should get the switch", () => {
        declare(["formattingInSecondRow"]);
        const row = rowSwitch(buildToolbar());
        expect(row).not.toBeNull();
        expect(row?.textContent).toContain("Formatting toolbar");
    });

    it("a surface with no such row should get no switch for it", () => {
        // The other arm, and the one that says the arm above is doing work: a
        // build that always drew the switch would pass the first alone, and
        // VS Code would carry a control for a row it has no concept of.
        declare([]);
        expect(rowSwitch(buildToolbar())).toBeNull();
    });

    it("pressing it should ask the host and change nothing here", () => {
        declare(["formattingInSecondRow"]);
        const topbar = buildToolbar();
        const row = rowSwitch(topbar);
        expect(row).not.toBeNull();
        const dockBefore = topbar.querySelector<HTMLElement>(".tb-dock")?.dataset["expanded"];
        expect(dockBefore).toBe("false");

        row?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));

        expect(posted()).toContainEqual({ type: "setFormattingRowExpanded", expanded: true });
        expect(topbar.querySelector<HTMLElement>(".tb-dock")?.dataset["expanded"]).toBe("false");
    });

    it("pressing it with the row open should ask for it to be shut", () => {
        declare(["formattingInSecondRow"], true);
        const topbar = buildToolbar();
        expect(topbar.querySelector<HTMLElement>(".tb-dock")?.dataset["expanded"]).toBe("true");
        rowSwitch(topbar)?.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true }));
        expect(posted()).toContainEqual({ type: "setFormattingRowExpanded", expanded: false });
    });

    it("the host's answer should move the switch, with no menu reopened", () => {
        // The mirror rule (docs/DESIGN_PRINCIPLES.md): every surface showing
        // this state repaints from the one announcement, never from its own
        // reopening. A switch that caught up on open would look right in front
        // of a row that had not moved, which is the failure that hides.
        declare(["formattingInSecondRow"]);
        const topbar = buildToolbar();
        expect(rowSwitch(topbar)?.getAttribute("aria-checked")).toBe("false");

        toolbar.setFormattingRowExpanded(true);

        expect(rowSwitch(topbar)?.getAttribute("aria-checked")).toBe("true");
        expect(topbar.querySelector<HTMLElement>(".tb-dock")?.dataset["expanded"]).toBe("true");
    });

    it("the switch should boot from the host's seed rather than from off", () => {
        declare(["formattingInSecondRow"], true);
        expect(rowSwitch(buildToolbar())?.getAttribute("aria-checked")).toBe("true");
    });
});
