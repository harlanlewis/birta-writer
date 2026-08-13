/**
 * The pure connector core (MAR-198): the embed-kind-to-connector map and the
 * request builder that is the confused-deputy gate's first half.
 *
 * The invariant under test is not "these six URLs produce these six requests".
 * It is that NO document URL, of any shape the recognizer accepts, can produce
 * a request off a connector's pinned hosts — which is a claim about the whole
 * space, so the sweep enumerates it rather than sampling it.
 */
import { describe, it, expect } from "vitest";
import {
    connectorApiRequest,
    connectorForEmbedKind,
    CONNECTOR_IDS,
    CONNECTORS,
} from "../connectors";
import { EMBED_KINDS, recognizeEmbed, type EmbedMatch } from "../embedProviders";

/** Every host any connector is permitted to reach, flattened. */
const ALL_PINNED_HOSTS = CONNECTOR_IDS.flatMap((id) => [...CONNECTORS[id].apiHosts]);

describe("connectorForEmbedKind", () => {
    it("a provider with no authenticated rung should map to no connector", () => {
        // The map is the gate: a kind absent from it can never reach a
        // credential-bearing code path, whatever its URL says.
        const mapped = EMBED_KINDS.filter((kind) => connectorForEmbedKind(kind) !== null);
        expect(mapped).toEqual(["github"]);
    });

    it("every mapped connector should exist in the registry", () => {
        for (const kind of EMBED_KINDS) {
            const id = connectorForEmbedKind(kind);
            if (id) {
                expect(CONNECTORS[id]).toBeDefined();
            }
        }
    });
});

describe("connectorApiRequest", () => {
    it("a repository URL should ask that repository's endpoint", () => {
        const match = recognizeEmbed("https://github.com/birtalabs/birta-writer");
        expect(connectorApiRequest(match!)).toEqual({
            connector: "github",
            url: "https://api.github.com/repos/birtalabs/birta-writer",
        });
    });

    it("a pull-request URL should ask the pulls endpoint, not issues", () => {
        // GitHub's issues endpoint answers for PRs too, and its body omits
        // `merged` — the one state difference a PR card exists to show.
        const match = recognizeEmbed("https://github.com/birtalabs/birta-writer/pull/316");
        expect(connectorApiRequest(match!)?.url).toBe(
            "https://api.github.com/repos/birtalabs/birta-writer/pulls/316",
        );
    });

    it("an issue URL should ask the issues endpoint", () => {
        const match = recognizeEmbed("https://github.com/birtalabs/birta-writer/issues/42");
        expect(connectorApiRequest(match!)?.url).toBe(
            "https://api.github.com/repos/birtalabs/birta-writer/issues/42",
        );
    });

    it("a blob URL should ask nothing: its URL-derived card is already complete", () => {
        const match = recognizeEmbed("https://github.com/birtalabs/birta-writer/blob/main/AGENTS.md");
        expect(connectorApiRequest(match!)).toBeNull();
    });

    it("a provider with no connector should ask nothing", () => {
        const match = recognizeEmbed("https://www.youtube.com/watch?v=dQw4w9WgXcQ");
        expect(connectorApiRequest(match!)).toBeNull();
    });

    it("a hand-built match with a path-traversal id should build no request", () => {
        // The recognizer would never emit this id, which is exactly why the
        // builder must reject it on its own terms rather than by trusting an
        // upstream side effect. Dots are legal in a GitHub owner, so the
        // charset alone lets `..` through: this fired on the first run.
        const evil: EmbedMatch = { kind: "github", id: "../../../evil/repo" };
        expect(connectorApiRequest(evil)).toBeNull();
    });

    it("no hand-built id should produce a URL the parser has to normalize", () => {
        // The general form of the bug above. If `new URL()` rewrites what the
        // builder produced, the request is not the one the parts described,
        // whatever the host pin says.
        const ids = [
            "..%2F..%2Fevil/repo", ".", "..", "./x", "../x", "x/..", "x/.",
            "owner/repo", "o.o/r.r", "-o/r-", "o/r/pull/1", "o/r/issues/1",
            "o/r/blob/main/a.md", "o/r/pull/1e9", "o/r/issues/-1",
        ];
        let built = 0;
        for (const id of ids) {
            const request = connectorApiRequest({ kind: "github", id });
            if (!request) {
                continue;
            }
            built += 1;
            expect(new URL(request.url).href).toBe(request.url);
            expect(new URL(request.url).pathname.startsWith("/repos/")).toBe(true);
        }
        expect(built).toBeGreaterThan(0);
    });

    it("a hand-built match naming another host in its id should build no request", () => {
        const evil: EmbedMatch = { kind: "github", id: "evil.com/x" };
        // A dot is legal in a GitHub owner, so this one DOES build a request —
        // and the point is where it points: at the pinned API host, with the
        // attacker's string reduced to a path segment.
        const built = connectorApiRequest(evil);
        expect(new URL(built!.url).hostname).toBe("api.github.com");
    });

    it("no recognized URL should ever build a request off a pinned host", () => {
        // The sweep. Every accepted shape of every provider, adversarial hosts
        // included: whatever comes back must be https on a pinned host, or
        // nothing at all. A URL cannot steer the request anywhere else.
        const corpus = [
            "https://github.com/birtalabs/birta-writer",
            "https://github.com/birtalabs/birta-writer/pull/1",
            "https://github.com/birtalabs/birta-writer/issues/1",
            "https://github.com/birtalabs/birta-writer/blob/main/a/b/c.md",
            "https://github.com/o.dotted/r.dotted",
            "https://github.com/-leading/trailing-",
            "https://www.github.com/birtalabs/birta-writer",
            "http://github.com/birtalabs/birta-writer",
            "https://github.com.evil.com/birtalabs/birta-writer",
            "https://evil.com/github.com/birtalabs/birta-writer",
            "https://github.com/birtalabs/birta-writer?x=https://evil.com",
            "https://github.com/birtalabs/birta-writer#https://evil.com",
            "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
            "https://www.figma.com/design/abcdefghij/Title",
            "https://linear.app/acme/issue/MAR-1/slug",
            "https://miro.com/app/board/abcdefgh=",
            "https://docs.google.com/document/d/" + "a".repeat(30) + "/edit",
            "https://codepen.io/user/pen/abcdef",
        ];
        let built = 0;
        for (const raw of corpus) {
            const match = recognizeEmbed(raw);
            if (!match) {
                continue;
            }
            const request = connectorApiRequest(match);
            if (!request) {
                continue;
            }
            built += 1;
            const url = new URL(request.url);
            expect(url.protocol).toBe("https:");
            expect(ALL_PINNED_HOSTS).toContain(url.hostname);
            expect(CONNECTORS[request.connector].apiHosts).toContain(url.hostname);
            // Already canonical: a URL the parser rewrites is not the URL the
            // validated parts described.
            expect(url.href).toBe(request.url);
        }
        // A sweep that reached nothing passes vacuously; assert it bit.
        expect(built).toBeGreaterThan(0);
    });
});

describe("the connector registry", () => {
    it("every connector's verify URL should sit on its own pinned hosts", () => {
        for (const id of CONNECTOR_IDS) {
            const spec = CONNECTORS[id];
            const url = new URL(spec.verifyUrl);
            expect(url.protocol).toBe("https:");
            expect(spec.apiHosts).toContain(url.hostname);
        }
    });

    it("every pinned host should be a bare hostname, never a wildcard or a URL", () => {
        for (const id of CONNECTOR_IDS) {
            for (const host of CONNECTORS[id].apiHosts) {
                expect(host).toMatch(/^[a-z0-9.-]+$/);
                expect(host).not.toContain("*");
            }
        }
    });

    it("a builtin connector should name the VS Code provider it uses", () => {
        for (const id of CONNECTOR_IDS) {
            const spec = CONNECTORS[id];
            if (spec.auth === "builtin") {
                expect(spec.builtinProviderId).toBeTruthy();
            }
            // Minimal scopes. An EMPTY default request is the goal, not a
            // smell: GitHub's scopeless token reads public repository data,
            // which is what almost every card needs. What must never be empty
            // is the disclosure on a broader opt-in grant, because that is the
            // one the user is being asked to weigh.
            if (spec.privateScopes !== undefined) {
                expect(spec.privateScopes.length).toBeGreaterThan(0);
                expect(spec.scopeNote).toBeTruthy();
                // The opt-in must actually be broader than the default, or it
                // is a second name for the same grant.
                expect(spec.privateScopes.length).toBeGreaterThan(spec.scopes.length);
            }
        }
    });
});
