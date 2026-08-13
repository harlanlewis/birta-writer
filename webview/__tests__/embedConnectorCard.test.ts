/**
 * The connector states as the reader actually sees them (MAR-198): what a
 * GitHub card says when the service is not connected, when the grant lapsed,
 * when a request failed, and when it worked.
 *
 * Driving the real card builder rather than asserting on the store is the
 * point. Invariant 8's promise is about what a reader can tell apart on
 * screen, so a test that stopped at the store would be pinning the half that
 * was never in doubt.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { mockVscodeApi } from "./setup";
import { renderEmbedCard } from "../utils/embedCard";
import {
    _resetEmbedConnectorForTests,
    handleEmbedCardResult,
    queueEmbedCardResolution,
    setConnectorStates,
} from "../embedConnector";

const REPO = { kind: "github" as const, id: "birtalabs/birta-writer" };
const PR = { kind: "github" as const, id: "birtalabs/birta-writer/pull/316" };
const HREF = "https://github.com/birtalabs/birta-writer";

const text = (card: HTMLElement, sel: string): string =>
    card.querySelector(sel)?.textContent ?? "";

/** The master network switch, as the card reads it from the injected snapshot. */
function setNetwork(enabled: boolean): void {
    (window as unknown as { __i18n: Record<string, unknown> }).__i18n = {
        ...(window as unknown as { __i18n?: Record<string, unknown> }).__i18n,
        network: enabled,
    };
}

/** Ask, then answer, the way the plugin's idle pass and the reply do. */
function resolveFor(
    match: typeof REPO,
    result: Parameters<typeof handleEmbedCardResult>[1],
): void {
    queueEmbedCardResolution([{ match, href: HREF }]);
    // The LAST request, not the first: a case that resets the store mid-test
    // leaves earlier request ids in the mock's history, and routing a reply to
    // a cleared entry silently does nothing.
    const requests = mockVscodeApi.postMessage.mock.calls
        .map((c) => c[0] as { type: string; id: string })
        .filter((m) => m.type === "resolveEmbedCard");
    handleEmbedCardResult(requests[requests.length - 1].id, result);
}

describe("the connector card states", () => {
    beforeEach(() => {
        vi.clearAllMocks();
        _resetEmbedConnectorForTests();
        setNetwork(true);
    });

    it("a card should be asked for even with nothing connected", () => {
        // The gate that decides whether to contact GitHub is the embeds switch,
        // not the connection: most cards are public and a public read carries
        // no credential. This module once derived `locked` from the connection
        // map and posted nothing, which made the extension's anonymous read
        // unreachable — so "a request was made" is the claim worth pinning.
        queueEmbedCardResolution([{ match: REPO, href: HREF }]);
        const asked = mockVscodeApi.postMessage.mock.calls
            .map((c) => c[0] as { type: string })
            .filter((m) => m.type === "resolveEmbedCard");
        expect(asked).toHaveLength(1);
    });

    it("a read that came back not-visible should keep its URL-derived card and offer to connect", () => {
        resolveFor(REPO, { state: "locked", connector: "github" });
        const card = renderEmbedCard(REPO, HREF);
        expect(text(card, ".embed-card__title")).toBe("birtalabs/birta-writer");
        const connect = card.querySelector(".embed-card__connect-btn");
        expect(connect?.textContent).toBe("Connect");
        // What the grant costs, before the user commits to the flow.
        expect(connect?.getAttribute("title")).toContain("read-only");
        expect(connect?.getAttribute("title")).toContain("also permits writes");
    });

    it("a public repository should resolve with no connection and no offer", () => {
        // The case the old gating made impossible to reach.
        resolveFor(REPO, {
            state: "ready",
            connector: "github",
            card: { title: "birtalabs/birta-writer", subtitle: "A Markdown editor" },
        });
        const card = renderEmbedCard(REPO, HREF);
        expect(text(card, ".embed-card__detail")).toContain("A Markdown editor");
        expect(card.querySelector(".embed-card__connect")).toBeNull();
    });

    it("clicking connect should ask the extension and name the connector", () => {
        resolveFor(REPO, { state: "locked", connector: "github" });
        const card = renderEmbedCard(REPO, HREF);
        (card.querySelector(".embed-card__connect-btn") as HTMLElement).click();
        expect(mockVscodeApi.postMessage).toHaveBeenCalledWith({
            type: "connectService",
            connector: "github",
        });
    });

    it("dismissing should remove the offer, and suppress it on the next card", () => {
        resolveFor(REPO, { state: "locked", connector: "github" });
        const first = renderEmbedCard(REPO, HREF);
        (first.querySelector(".embed-card__connect-dismiss") as HTMLElement).click();
        expect(first.querySelector(".embed-card__connect")).toBeNull();
        // Quiet at scale: a document of locked links asks once, not once each.
        resolveFor(PR, { state: "locked", connector: "github" });
        const second = renderEmbedCard(PR, HREF);
        expect(second.querySelector(".embed-card__connect")).toBeNull();
    });

    it("with the master network switch off there should be no offer at all", () => {
        // Connecting ends in a request, so the outer gate governs the offer.
        setNetwork(false);
        const card = renderEmbedCard(REPO, HREF);
        expect(card.querySelector(".embed-card__connect")).toBeNull();
        expect(text(card, ".embed-card__title")).toBe("birtalabs/birta-writer");
    });

    it("a provider with no connector should show no connector chrome", () => {
        const card = renderEmbedCard({ kind: "linear", id: "acme/issue/MAR-1/a-slug" }, "https://linear.app/acme/issue/MAR-1/a-slug");
        expect(card.querySelector(".embed-card__connect")).toBeNull();
        expect(card.querySelector(".embed-card__status")).toBeNull();
    });

    describe("connected", () => {
        beforeEach(() => {
            setConnectorStates({ github: true });
        });

        const resolve = (result: Parameters<typeof handleEmbedCardResult>[1]): void =>
            resolveFor(PR, result);

        it("a resolved pull request should show its title, its origin, and its state", () => {
            resolve({
                state: "ready",
                connector: "github",
                card: { title: "Keep the top visible line stable", subtitle: "#316 by harlanlewis", status: "Merged" },
            });
            const card = renderEmbedCard(PR, HREF);
            expect(text(card, ".embed-card__title")).toBe("Keep the top visible line stable");
            // The API's headline replaced the URL's, so owner/repo has to stay
            // visible somewhere: it is the one fact that says WHERE this is.
            expect(text(card, ".embed-card__detail")).toContain("birtalabs/birta-writer");
            expect(text(card, ".embed-card__detail")).toContain("#316 by harlanlewis");
            expect(text(card, ".embed-card__status")).toBe("Merged");
            expect(card.querySelector(".embed-card__connect")).toBeNull();
        });

        it("a lapsed grant should say reconnect, not connect", () => {
            resolve({ state: "expired", connector: "github" });
            const card = renderEmbedCard(PR, HREF);
            expect(text(card, ".embed-card__connect-btn")).toBe("Reconnect");
            expect(card.querySelector(".embed-card__connect-btn")?.getAttribute("title"))
                .toContain("expired");
        });

        it("a failed request should say so, and offer nothing to click", () => {
            // Connected and current: there is nothing here for the reader to
            // act on, so an affordance would be noise. Never a blank card.
            resolve({ state: "error", connector: "github" });
            const card = renderEmbedCard(PR, HREF);
            expect(text(card, ".embed-card__status")).toBe("Unavailable");
            expect(card.querySelector(".embed-card__connect")).toBeNull();
            expect(text(card, ".embed-card__title")).toBe("birtalabs/birta-writer");
        });

        it("a URL with no authenticated rung should leave the card untouched", () => {
            resolve(null);
            const card = renderEmbedCard(PR, HREF);
            expect(card.querySelector(".embed-card__status")).toBeNull();
            expect(card.querySelector(".embed-card__connect")).toBeNull();
            expect(text(card, ".embed-card__title")).toBe("birtalabs/birta-writer");
        });

        it("the three unresolved states should be tellable apart on screen", () => {
            // The whole point of invariant 8, asserted as one claim: no two of
            // them render the same, and none of them renders blank.
            const rendered = (["locked", "expired", "error"] as const).map((state) => {
                _resetEmbedConnectorForTests();
                setNetwork(true);
                setConnectorStates({ github: true });
                resolve({ state, connector: "github" });
                const card = renderEmbedCard(PR, HREF);
                return (card.textContent ?? "").trim();
            });
            expect(new Set(rendered).size).toBe(3);
            for (const r of rendered) {
                expect(r.length).toBeGreaterThan(0);
            }
        });
    });
});
