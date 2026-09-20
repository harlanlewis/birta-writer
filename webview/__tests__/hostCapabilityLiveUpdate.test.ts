/**
 * The live half of the host profile: what happens between a host withdrawing
 * a capability and the surfaces agreeing about it again.
 *
 * The profile is otherwise settled before the page exists, and every other
 * test in this feature declares one and then asks a surface what it would
 * draw. One capability is not settled: `agent` is a switch in the Mac app's
 * Settings (`LIVE_HOST_CAPABILITIES`), and moving it used to RELOAD the page,
 * which tore the editor down under whoever was looking at it to move two menu
 * rows.
 *
 * Driven through `createMessageHandlers` rather than by calling the surfaces,
 * for the reason `syntaxLiveUpdate.test.ts` gives: the surfaces have their own
 * tests, and what is unproven here is that anything calls them. The handler
 * map's members are optional, so a deleted handler compiles clean and the page
 * silently keeps the capability it booted with.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import "./setup";
import { createMessageHandlers, type MessageHandlerDeps, type ToolbarController } from "../messageHandlers";
import { commandAvailable } from "../../shared/commandAvailability";
import { agentPanelOpen, closeAgentPanel, openAgentPanel } from "../agentPanelController";
import { hostHas, ALL_HOST_CAPABILITIES, HOST_PROFILES, LIVE_HOST_CAPABILITIES } from "../../shared/hostProfile";

function stubDeps(topbarTb: ToolbarController | null): MessageHandlerDeps {
    return {
        state: {
            getEditor: () => null,
            setEditor: () => {},
            setLineMap: () => {},
            getMarkdownSource: () => "",
            setMarkdownSource: () => {},
        },
        actions: {
            placeCaretAtLine: () => {},
            scrollToDocumentLine: () => {},
            getSwitchTarget: () => undefined,
            getSelectionContext: () => null,
            setLineOffset: () => {},
            initEditor: async () => {},
            retryScroll: () => {},
            getEditorView: () => null,
            refreshToc: () => {},
            setLineNumbers: () => {},
        },
        topbarTb,
    };
}

/** A bar that records only what this path asks of it. */
function stubToolbar(): ToolbarController & { refreshOfferedItems: ReturnType<typeof vi.fn> } {
    const bar = { refreshOfferedItems: vi.fn() };
    return new Proxy(bar, {
        get(target, key) {
            if (key in target) { return (target as Record<string | symbol, unknown>)[key]; }
            return () => {};
        },
    }) as ToolbarController & { refreshOfferedItems: ReturnType<typeof vi.fn> };
}

const container = document.createElement("div");

/** The Mac app's profile, which is the surface that moves a capability. */
const MAC = HOST_PROFILES.mac;
const WITHOUT_AGENT = MAC.filter((c) => c !== "agent");

let before: unknown;

beforeEach(() => {
    vi.clearAllMocks();
    before = window.__i18n;
    window.__i18n = { ...(window.__i18n ?? {}) };
});

afterEach(() => {
    (window as { __i18n?: unknown }).__i18n = before;
});

describe("a live host-capability change", () => {
    it("should be handled at all, so the message is not silently dropped", () => {
        const handlers = createMessageHandlers(stubDeps(null));
        expect(handlers.hostCapabilitiesChanged, "no handler for hostCapabilitiesChanged").toBeDefined();
    });

    it("should write the new list back to the one declaration every gate reads", () => {
        const handlers = createMessageHandlers(stubDeps(null));
        window.__i18n!.host = { capabilities: MAC, arrangements: [], shortcuts: [] };
        expect(hostHas("agent")).toBe(true);
        expect(commandAvailable("askAgent")).toBe(true);

        handlers.hostCapabilitiesChanged!(
            { type: "hostCapabilitiesChanged", capabilities: WITHOUT_AGENT }, container);

        // The predicate every surface asks answers differently, with nothing
        // rebuilt and nothing reloaded. That IS the update.
        expect(hostHas("agent")).toBe(false);
        expect(commandAvailable("askAgent")).toBe(false);
        expect(commandAvailable("askAgentAdvanced")).toBe(false);
        // A capability the message did not withdraw is still there, so the
        // write replaced the list rather than emptying it.
        expect(hostHas("toc")).toBe(true);
    });

    it("should offer as well as withdraw, so switching /ai back on is not a reload", () => {
        const handlers = createMessageHandlers(stubDeps(null));
        window.__i18n!.host = { capabilities: WITHOUT_AGENT, arrangements: [], shortcuts: [] };
        expect(commandAvailable("askAgent")).toBe(false);

        handlers.hostCapabilitiesChanged!(
            { type: "hostCapabilitiesChanged", capabilities: MAC }, container);

        expect(commandAvailable("askAgent")).toBe(true);
    });

    it("should leave the arrangements and the shortcuts alone", () => {
        // The message carries capabilities and nothing else, and the other two
        // thirds of the profile are what the page was built against: a write
        // that dropped them would take the Mac app's whole layout away on a
        // change to one switch.
        const handlers = createMessageHandlers(stubDeps(null));
        window.__i18n!.host = {
            capabilities: MAC,
            arrangements: ["formattingInSecondRow"],
            shortcuts: [{ keys: "⌘S", label: "Save" }],
        };

        handlers.hostCapabilitiesChanged!(
            { type: "hostCapabilitiesChanged", capabilities: WITHOUT_AGENT }, container);

        expect(window.__i18n!.host!.arrangements).toEqual(["formattingInSecondRow"]);
        expect(window.__i18n!.host!.shortcuts).toEqual([{ keys: "⌘S", label: "Save" }]);
    });

    it("should ask the bar to re-place its items", () => {
        // No item is gated on a capability a host can move today
        // (`toolbarRegistry.test.ts` holds that), but the bar is still the one
        // surface that decided its contents once, and the day a capability
        // withdraws a row of one this is the wire that carries it.
        const bar = stubToolbar();
        const handlers = createMessageHandlers(stubDeps(bar));

        handlers.hostCapabilitiesChanged!(
            { type: "hostCapabilitiesChanged", capabilities: WITHOUT_AGENT }, container);

        expect(bar.refreshOfferedItems).toHaveBeenCalledTimes(1);
    });

    it("should survive a page with no bar, which is every host that hides it", () => {
        const handlers = createMessageHandlers(stubDeps(null));
        expect(() => handlers.hostCapabilitiesChanged!(
            { type: "hostCapabilitiesChanged", capabilities: WITHOUT_AGENT }, container,
        )).not.toThrow();
        expect(hostHas("agent")).toBe(false);
    });

    it("should take away a composer that is already open, which no gate reaches", async () => {
        // Every other gate here is asked when a surface is DRAWN, so a panel
        // already standing is untouched by all of them, and its Send posts
        // `askAgentAdvanced` itself rather than through `runEditorCommand`.
        // The reload this message replaced took it away by destroying the
        // page. Opened for real rather than stubbed, because what is in doubt
        // is whether the handler reaches the panel at all.
        window.__i18n!.host = { capabilities: MAC, arrangements: [], shortcuts: [] };
        openAgentPanel(() => null);
        await vi.waitFor(() => expect(agentPanelOpen()).toBe(true));

        const handlers = createMessageHandlers(stubDeps(null));
        handlers.hostCapabilitiesChanged!(
            { type: "hostCapabilitiesChanged", capabilities: WITHOUT_AGENT }, container);

        expect(agentPanelOpen()).toBe(false);
    });

    it("should leave an open composer alone while the agent is still there", async () => {
        // The other arm, so the close above is the withdrawal rather than the
        // message: a reader who turns some other capability off must not lose
        // the request they are in the middle of typing.
        window.__i18n!.host = { capabilities: MAC, arrangements: [], shortcuts: [] };
        openAgentPanel(() => null);
        await vi.waitFor(() => expect(agentPanelOpen()).toBe(true));

        const handlers = createMessageHandlers(stubDeps(null));
        handlers.hostCapabilitiesChanged!(
            { type: "hostCapabilitiesChanged", capabilities: MAC.filter((c) => c !== "toc") },
            container);

        expect(agentPanelOpen()).toBe(true);
        closeAgentPanel();
    });

    it("should name capabilities a host actually has, or it withdraws nothing", () => {
        // A member that is not a capability gates nothing and can be sent by
        // nobody; a member no profile declares is a capability that is never
        // there to withdraw. Both read as a live update that never happens,
        // and neither is visible from a green run of the wire above.
        expect(LIVE_HOST_CAPABILITIES.length).toBeGreaterThan(0);
        const declaredSomewhere = new Set(Object.values(HOST_PROFILES).flat());
        for (const cap of LIVE_HOST_CAPABILITIES) {
            expect(ALL_HOST_CAPABILITIES, `${cap} is not a capability`).toContain(cap);
            expect([...declaredSomewhere], `${cap} is declared by no host`).toContain(cap);
        }
    });
});
