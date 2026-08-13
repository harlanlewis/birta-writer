/**
 * The webview connector store (MAR-198): the disconnected-costs-zero rule, the
 * session dedupe, the dismissal that keeps a document of locked links quiet,
 * and the reply backstop.
 *
 * The claim this file exists to pin is the cheap half of the security story:
 * with a service disconnected, the webview posts NO message at all, so the
 * extension is never given the chance to make a credentialed request. Message
 * posting goes through the mocked acquireVsCodeApi (setup.ts); nothing here
 * imports the editor, so the store cannot touch the document by construction.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import {
    _resetEmbedConnectorForTests,
    connectorConnected,
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

    describe("a disconnected service costs zero", () => {
        it("queueing with nothing connected should post NO message", () => {
            queueEmbedCardResolution([GH, GH2]);
            expect(posted("resolveEmbedCard")).toHaveLength(0);
        });

        it("subscribing with nothing connected should answer locked synchronously", () => {
            const apply = vi.fn();
            subscribeEmbedCard("github", GH.match.id, apply);
            expect(apply).toHaveBeenCalledWith({ state: "locked", connector: "github" });
            expect(posted("resolveEmbedCard")).toHaveLength(0);
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

        it("disconnecting should send subscribers back to locked", () => {
            setConnectorStates({ github: true });
            expect(connectorConnected("github")).toBe(true);
            setConnectorStates({ github: false });
            expect(connectorConnected("github")).toBe(false);
            const apply = vi.fn();
            subscribeEmbedCard("github", GH.match.id, apply);
            expect(apply).toHaveBeenCalledWith({ state: "locked", connector: "github" });
        });

        it("a connector absent from the map should read as not connected", () => {
            setConnectorStates({});
            expect(connectorConnected("github")).toBe(false);
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
