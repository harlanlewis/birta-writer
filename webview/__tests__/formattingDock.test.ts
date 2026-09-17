/**
 * The formatting row's open state is the HOST'S (components/toolbar/dock.ts):
 * read from the bootstrap when the row is built, posted on a flip the reader
 * makes here, and applied without a post when the host pushes another
 * page's flip. The no-echo half is the one a green page cannot show: two
 * pages echoing each other's pushes would converge and look right.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import { createFormattingDock } from "../components/toolbar/dock";

function boot(expanded: boolean | undefined): void {
    (window as unknown as { __i18n: unknown }).__i18n = {
        translations: {},
        isMac: true,
        ...(expanded === undefined ? {} : { formattingRowExpanded: expanded }),
    };
}

const posted = (): unknown[] =>
    mockVscodeApi.postMessage.mock.calls
        .map((c) => c[0] as { type?: string })
        .filter((m) => m.type === "formattingRowExpanded");

describe("the formatting row's open state", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        document.body.innerHTML = "";
    });

    it("an absent bootstrap flag should build the row shut, and a true one open", () => {
        boot(undefined);
        const shut = createFormattingDock({ items: {} });
        expect(shut.isExpanded()).toBe(false);
        expect(shut.el.hidden).toBe(true);
        shut.dispose();
        boot(true);
        const open = createFormattingDock({ items: {} });
        expect(open.isExpanded()).toBe(true);
        expect(open.el.hidden).toBe(false);
        expect(posted()).toEqual([]);
        open.dispose();
    });

    it("the reader's own flip should be posted to the host, once, with the new answer", () => {
        boot(false);
        const dock = createFormattingDock({ items: {} });
        dock.toggle.dispatchEvent(new MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
        expect(dock.isExpanded()).toBe(true);
        expect(posted()).toEqual([{ type: "formattingRowExpanded", expanded: true }]);
        dock.dispose();
    });

    it("the host's push should move the row and post nothing back", () => {
        boot(false);
        const dock = createFormattingDock({ items: {} });
        dock.setExpanded(true);
        expect(dock.isExpanded()).toBe(true);
        expect(dock.el.hidden).toBe(false);
        dock.setExpanded(false);
        expect(dock.isExpanded()).toBe(false);
        expect(posted()).toEqual([]);
        dock.dispose();
    });

    it("a push that changes nothing should change nothing, so the origin page's own echo is inert", () => {
        boot(true);
        const dock = createFormattingDock({ items: {} });
        dock.setExpanded(true);
        expect(dock.isExpanded()).toBe(true);
        expect(posted()).toEqual([]);
        dock.dispose();
    });
});
