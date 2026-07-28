/**
 * The view-state echo's teardown flush (messaging.ts): a bag write made just
 * before the panel goes away must not die inside the 250ms debounce —
 * pagehide / visibility-hidden posts the pending echo immediately, exactly
 * once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mockVscodeApi } from "./setup";

type Messaging = typeof import("../messaging");

async function loadMessaging(): Promise<Messaging> {
    vi.resetModules();
    return await import("../messaging");
}

const echoPosts = () =>
    mockVscodeApi.postMessage.mock.calls.filter(
        (c) => (c[0] as { type: string }).type === "viewState",
    );

let bag: Record<string, unknown> | null;

beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    bag = null;
    mockVscodeApi.getState.mockImplementation(() => bag);
    mockVscodeApi.setState.mockImplementation((state: unknown) => {
        bag = state as Record<string, unknown>;
    });
});

afterEach(() => {
    vi.useRealTimers();
});

describe("view-state echo teardown flush", () => {
    it("pagehide should flush a pending echo immediately", async () => {
        const messaging = await loadMessaging();
        messaging.setWebviewState({ blockWidths: { "table:H": "full" } });
        expect(echoPosts()).toHaveLength(0); // still inside the debounce

        window.dispatchEvent(new Event("pagehide"));

        expect(echoPosts()).toHaveLength(1);
        expect(echoPosts()[0]![0]).toEqual({
            type: "viewState",
            state: { blockWidths: { "table:H": "full" } },
        });
        // The flushed timer must not fire a duplicate later.
        vi.advanceTimersByTime(1000);
        expect(echoPosts()).toHaveLength(1);
    });

    it("visibility-hidden should flush too; nothing pending → nothing posted", async () => {
        const messaging = await loadMessaging();
        // No pending write: the listener must stay silent.
        document.dispatchEvent(new Event("visibilitychange"));
        expect(echoPosts()).toHaveLength(0);

        messaging.setWebviewState({ scrollY: 12 });
        Object.defineProperty(document, "visibilityState", {
            value: "hidden",
            configurable: true,
        });
        document.dispatchEvent(new Event("visibilitychange"));
        expect(echoPosts()).toHaveLength(1);
    });

    it("the normal debounced echo still fires when nothing interrupts", async () => {
        const messaging = await loadMessaging();
        messaging.setWebviewState({ scrollY: 5 });
        vi.advanceTimersByTime(250);
        expect(echoPosts()).toHaveLength(1);
    });
});
