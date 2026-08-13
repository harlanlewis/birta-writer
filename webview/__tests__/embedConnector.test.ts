/**
 * The webview connector store (MAR-198): who gets asked, the session dedupe,
 * the dismissal that keeps a document of locked links quiet, and the reply
 * backstop.
 *
 * This file used to pin the opposite of what it now pins, and the correction is
 * worth stating. It claimed that a disconnected service posts NO message, and
 * called that the cheap half of the security story. It was neither cheap nor
 * security: gating the ASK on the connection made the extension's anonymous
 * read of a public repository unreachable, so a world-readable title needed an
 * account. The credential decision belongs where the credential is, which is
 * the extension; this side asks, and renders whatever comes back.
 *
 * What a disconnected service still costs nothing for is a provider with no
 * connector at all — nothing to ask, no chrome.
 *
 * Message posting goes through the mocked acquireVsCodeApi (setup.ts); nothing
 * here imports the editor, so the store cannot touch the document by
 * construction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import {
    _resetEmbedConnectorForTests,

    connectorDismissed,
    dismissConnector,
    handleEmbedCardResult,
    queueEmbedCardResolution,
    requestConnect,
    setConnectorStates,
    subscribeEmbedCard,
} from "../embedConnector";

const GH = { match: { kind: "github" as const, id: "owner/repo" }, href: "https://github.com/owner/repo" };
const GH2 = { match: { kind: "github" as const, id: "owner/other" }, href: "https://github.com/owner/other" };
const YT = { match: { kind: "youtube" as const, id: "dQw4w9WgXcQ" }, href: "https://youtu.be/dQw4w9WgXcQ" };

/** The messages posted so far, filtered by type. */
function posted(type: string): Array<{ id: string; url: string; connector?: string }> {
    return mockVscodeApi.postMessage.mock.calls
        .map((c) => c[0] as { type: string; id: string; url: string; connector?: string })
        .filter((m) => m.type === type);
}

describe("embedConnector store", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _resetEmbedConnectorForTests();
    });

    afterEach(() => {
        vi.useRealTimers();
    });

    describe("a connector-capable card is asked for, connected or not", () => {
        it("queueing with nothing connected should still post one ask each", () => {
            // This used to post nothing, deriving `locked` from the connection
            // map, which made the extension's anonymous read of a PUBLIC
            // repository unreachable. The gate that decides whether to contact
            // the provider is the embeds switch, re-checked extension-side.
            queueEmbedCardResolution([GH, GH2]);
            expect(posted("resolveEmbedCard")).toHaveLength(2);
        });

        it("subscribing with nothing connected should wait for the answer, not assume locked", () => {
            // `locked` is the extension's answer to a read that came back
            // not-visible, which is a different fact from "not connected": a
            // public repository resolves `ready` with no connection at all.
            const apply = vi.fn();
            subscribeEmbedCard("github", GH.match.id, apply);
            expect(apply).not.toHaveBeenCalled();
        });

        it("a provider with no connector should never call back at all", () => {
            setConnectorStates({ github: true });
            const apply = vi.fn();
            subscribeEmbedCard("youtube", YT.match.id, apply);
            expect(apply).not.toHaveBeenCalled();
        });

        it("queueing a provider with no connector should post nothing", () => {
            setConnectorStates({ github: true });
            queueEmbedCardResolution([YT]);
            expect(posted("resolveEmbedCard")).toHaveLength(0);
        });
    });

    describe("resolving a connected service", () => {
        beforeEach(() => {
            setConnectorStates({ github: true });
        });

        it("queueing should ask once per kind:id", () => {
            queueEmbedCardResolution([GH, GH2]);
            expect(posted("resolveEmbedCard").map((m) => m.url)).toEqual([GH.href, GH2.href]);
        });

        it("a second queue pass should ask nothing new", () => {
            queueEmbedCardResolution([GH, GH2]);
            queueEmbedCardResolution([GH, GH2]);
            expect(posted("resolveEmbedCard")).toHaveLength(2);
        });

        it("a reply should reach a parked subscriber, and later ones synchronously", () => {
            queueEmbedCardResolution([GH]);
            const early = vi.fn();
            subscribeEmbedCard("github", GH.match.id, early);

            const ready = { state: "ready" as const, connector: "github" as const, card: { title: "owner/repo" } };
            handleEmbedCardResult(posted("resolveEmbedCard")[0].id, ready);
            expect(early).toHaveBeenCalledWith(ready);

            const late = vi.fn();
            subscribeEmbedCard("github", GH.match.id, late);
            expect(late).toHaveBeenCalledWith(ready);
        });

        it("an unknown request id should be ignored rather than throw", () => {
            expect(() => handleEmbedCardResult("bogus", null)).not.toThrow();
        });

        it("a dropped reply should settle to null on the backstop, not wait forever", () => {
            vi.useFakeTimers();
            queueEmbedCardResolution([GH]);
            const apply = vi.fn();
            subscribeEmbedCard("github", GH.match.id, apply);
            vi.advanceTimersByTime(15000);
            expect(apply).toHaveBeenCalledWith(null);
        });
    });

    describe("connection state changes", () => {
        it("connecting should drop cached answers so stale cards cannot survive it", () => {
            setConnectorStates({ github: true });
            queueEmbedCardResolution([GH]);
            handleEmbedCardResult(posted("resolveEmbedCard")[0].id, { state: "error", connector: "github" });

            // A connect (or disconnect) invalidates every cached answer: what
            // each of them would have been has changed.
            setConnectorStates({ github: true });
            vi.clearAllMocks();
            queueEmbedCardResolution([GH]);
            expect(posted("resolveEmbedCard")).toHaveLength(1);
        });

        it("disconnecting should drop cached answers and re-ask", () => {
            // Not "back to locked": a disconnect changes what every cached
            // answer would have been, and the fresh read decides. A public
            // repository still resolves after one.
            setConnectorStates({ github: true });
            queueEmbedCardResolution([GH]);
            expect(posted("resolveEmbedCard")).toHaveLength(1);
            // Asked once per session, so a second queue with no state change
            // adds nothing — which is what makes the re-ask below meaningful.
            queueEmbedCardResolution([GH]);
            expect(posted("resolveEmbedCard")).toHaveLength(1);

            setConnectorStates({ github: false });
            queueEmbedCardResolution([GH]);
            expect(posted("resolveEmbedCard")).toHaveLength(2);
        });
    });

    describe("quiet at scale", () => {
        it("a dismissal should hold for the connector, for the session", () => {
            expect(connectorDismissed("github")).toBe(false);
            dismissConnector("github");
            expect(connectorDismissed("github")).toBe(true);
            // Per connector, not globally: dismissing one must not silence
            // another the user has not seen yet.
            expect(connectorDismissed("asana")).toBe(false);
        });
    });

    describe("the connect request", () => {
        it("should post the connector id and nothing else", () => {
            requestConnect("github");
            const messages = posted("connectService");
            expect(messages).toHaveLength(1);
            expect(messages[0]).toEqual({ type: "connectService", connector: "github" });
        });
    });
});
