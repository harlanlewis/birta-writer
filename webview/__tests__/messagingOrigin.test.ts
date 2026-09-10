/**
 * `onMessage` accepts the host and refuses a frame the page embeds.
 *
 * What this file can and cannot say is worth stating, because the limit is
 * the reason a suite exists beside it. The field under test is
 * `event.source`, and jsdom's own `window.postMessage` leaves it null, so
 * these events are constructed and the test supplies the very field it then
 * asserts on. That pins the PREDICATE and nothing else. Whether a real
 * dispatch from a real embedded frame arrives with a source that fails it is
 * a question only a browser can answer, and `e2e/hostMessageOrigin` asks it;
 * `e2e/frameHost` covers the hosted-in-a-frame case, where the parent is a
 * genuinely different window from the page.
 *
 * There is no arm here asserting that the `window` and `window.parent` cases
 * are distinct. On a top-level page `window.parent` IS `window`, so such an
 * arm would be asserting a fiction that happens to pass.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import "./setup";

const { onMessage } = await import("../../webview/messaging");

/** A message event as a real `postMessage` delivers one, sender included. */
function post(source: MessageEventSource | null, data: unknown): void {
    window.dispatchEvent(new MessageEvent("message", { data, source }));
}

// Registered ONCE. `onMessage` adds a listener and never removes one, so a
// registration per test leaves the earlier handlers live and every accepted
// message is counted once per test that has run so far.
const received: unknown[] = [];
onMessage((msg) => { received.push(msg); });

describe("onMessage — who may speak into the page", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        received.length = 0;
    });

    it("a message from the page's own window should be delivered", () => {
        post(window, { type: "externalUpdate", content: "# Host", syncVersion: 1 });
        expect(received).toHaveLength(1);
    });

    it("a message from an embedded frame should be dropped", () => {
        const frame = document.createElement("iframe");
        document.body.appendChild(frame);
        const child = frame.contentWindow;
        // The instrument before the verdict: a null child would make the
        // refusal below indistinguishable from the null case, which is a
        // different rule.
        expect(child).not.toBeNull();
        expect(child).not.toBe(window);

        post(child, { type: "externalUpdate", content: "# Forged", syncVersion: 99 });
        expect(received).toHaveLength(0);
    });

    it("a message with no source should be dropped", () => {
        post(null, { type: "externalUpdate", content: "# Forged", syncVersion: 99 });
        expect(received).toHaveLength(0);
    });

    it("a dropped message should not stop a later host message being delivered", () => {
        const frame = document.createElement("iframe");
        document.body.appendChild(frame);
        post(frame.contentWindow, { type: "init", content: "# Forged", syncVersion: 99 });
        post(window, { type: "init", content: "# Host", syncVersion: 1 });
        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({ content: "# Host" });
    });
});
