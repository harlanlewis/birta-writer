/**
 * The `/ai` caret hint (webview/agentRoute.ts): the sentence shown after the
 * committed pill, built from the route summary the extension pushes.
 *
 * The invariant worth holding is what the hint may NOT say. It names a tool
 * only when one is configured, and a model only when the template named one:
 * a placeholder that guesses is worse than a short one, because the user is
 * reading it to decide whether to press Enter.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { agentRoute, agentRouteHint, displayEffort, displayModel, setAgentRoute } from "../agentRoute";
import type { AgentRouteSummary } from "../../shared/messages";

const shell = (over: Partial<AgentRouteSummary> = {}): AgentRouteSummary => ({
    configured: true,
    kind: "shell",
    harness: "claude",
    mode: "background",
    ...over,
});

describe("agentRouteHint", () => {
    beforeEach(() => setAgentRoute(undefined));

    it("no summary at all should fall back to the bare placeholder", () => {
        // A host that never sends the message (or has not yet) still gets a
        // hint that tells the user what the blank is for.
        expect(agentRouteHint()).toBe("your request");
    });

    it("an unconfigured route should say the choice is still to come", () => {
        expect(agentRouteHint({ configured: false, kind: "shell" }))
            .toBe("your request; Enter to choose where it goes");
    });

    it("a named model should appear beside the harness", () => {
        expect(agentRouteHint(shell({ model: "haiku" })))
            .toBe("edit with claude (Haiku)");
    });

    it("a named effort should join the model", () => {
        expect(agentRouteHint(shell({ model: "opus", effort: "xhigh" })))
            .toBe("edit with claude (Opus xHigh)");
    });

    it("an effort with no model should still be named", () => {
        expect(agentRouteHint(shell({ effort: "high" })))
            .toBe("edit with claude (High)");
    });

    it("no named model should name the harness alone, never a default", () => {
        const hint = agentRouteHint(shell());
        expect(hint).toBe("edit with claude");
        // The failure this guards is a plausible-looking lie: the editor
        // cannot see what alias a CLI resolves to, so it must not print one.
        expect(hint).not.toMatch(/default|opus|sonnet|haiku/i);
    });

    it("terminal mode should be named, because a panel is about to open", () => {
        expect(agentRouteHint(shell({ mode: "terminal", model: "sonnet" })))
            .toBe("edit with claude (Sonnet) in a terminal");
    });

    it("the routes that are not a command should say where the line goes", () => {
        expect(agentRouteHint({ configured: true, kind: "chat" }))
            .toBe("your request, for the Chat view");
        expect(agentRouteHint({ configured: true, kind: "clipboard" }))
            .toBe("your request, to copy for your agent");
    });

    it("a shell route with no harness name should fall back rather than read broken", () => {
        expect(agentRouteHint(shell({ harness: "" }))).toBe("your request");
    });

    it("the stored summary should be what the argument-less call uses", () => {
        setAgentRoute(shell({ model: "haiku" }));
        expect(agentRoute()).toEqual(shell({ model: "haiku" }));
        expect(agentRouteHint()).toBe("edit with claude (Haiku)");
        setAgentRoute(undefined);
        expect(agentRouteHint()).toBe("your request");
    });
});

describe("the display names", () => {
    it("a documented effort should be spelled the way a person writes it", () => {
        expect(displayEffort("xhigh")).toBe("xHigh");
        expect(["low", "medium", "high", "max"].map(displayEffort))
            .toEqual(["Low", "Medium", "High", "Max"]);
    });

    it("an undocumented effort should survive exactly as configured", () => {
        expect(displayEffort("ludicrous")).toBe("ludicrous");
    });

    it("a bare alias should be title-cased", () => {
        expect(["opus", "sonnet", "haiku", "fable"].map(displayModel))
            .toEqual(["Opus", "Sonnet", "Haiku", "Fable"]);
    });

    it("a full model id should be left exactly as typed", () => {
        // Prettifying an identifier stops it being the string the user can
        // paste back into their own command, which is the point of showing it.
        expect(displayModel("claude-fable-5")).toBe("claude-fable-5");
        expect(displayModel("gpt-5.1")).toBe("gpt-5.1");
        expect(displayModel("o3")).toBe("o3");
    });
});
