/**
 * The Linear connector (MAR-198): the request it builds and the card it maps.
 *
 * Linear is the first connector with no GET surface, so its request carries a
 * GraphQL body rather than a path. That moves where the confused-deputy
 * argument lives, and these assertions are written to hold the new location:
 * the query is a constant this repository owns, and everything the document
 * contributed travels as bound variables which cannot change the query's shape.
 */
import { describe, it, expect } from "vitest";
import { connectorApiRequest, CONNECTORS } from "../../shared/connectors";
import { recognizeEmbed } from "../../shared/embedProviders";
import { linearCard } from "../connectors/linear";

/** Recognize a URL the way the resolve path does, refusing to guess. */
function matchFor(url: string) {
    const match = recognizeEmbed(url);
    if (!match) { throw new Error(`not recognized: ${url}`); }
    return match;
}

const ISSUE_URL = "https://linear.app/birta/issue/MAR-186/embed-provider-roadmap";

describe("the Linear connector's spec", () => {
    it("should pin only the API host, not the consent host", () => {
        const spec = CONNECTORS.linear;
        // linear.app serves the consent page and is opened in a browser. It
        // must not be a host a CREDENTIAL may be sent to, and this list is
        // exactly that set.
        expect(spec.apiHosts).toEqual(["api.linear.app"]);
        expect(spec.apiHosts).not.toContain("linear.app");
    });

    it("should request read and nothing else, so render-only holds at the grant", () => {
        expect(CONNECTORS.linear.scopes).toEqual(["read"]);
        expect(CONNECTORS.linear.privateScopes).toBeUndefined();
    });

    it("should carry a public client with no secret field to hold one", () => {
        const oauth = CONNECTORS.linear.oauth;
        expect(oauth?.clientId).toBeTruthy();
        expect(oauth?.authorizeUrl.startsWith("https://")).toBe(true);
        expect(oauth?.tokenUrl.startsWith("https://")).toBe(true);
        // The token endpoint must be a host the credential is allowed to reach;
        // the authorize endpoint is a browser destination and deliberately is
        // not. Asserting both directions, because asserting only the first
        // would pass if every host were pinned.
        expect(CONNECTORS.linear.apiHosts).toContain(new URL(oauth!.tokenUrl).hostname);
        expect(CONNECTORS.linear.apiHosts).not.toContain(new URL(oauth!.authorizeUrl).hostname);
    });
});

describe("connectorApiRequest for Linear", () => {
    it("should POST a GraphQL query to the pinned host", () => {
        const request = connectorApiRequest(matchFor(ISSUE_URL));
        expect(request?.connector).toBe("linear");
        expect(request?.url).toBe("https://api.linear.app/graphql");
        expect(request?.body).toBeDefined();
    });

    it("should carry the issue's parts as variables, never inside the query", () => {
        const request = connectorApiRequest(matchFor(ISSUE_URL));
        const body = request?.body as { query: string; variables: Record<string, unknown> };
        expect(body.variables).toEqual({ team: "MAR", number: 186 });
        // The load-bearing assertion of this file. If a part ever reaches the
        // query text, a document could change the shape of the request rather
        // than only its values, which is the whole thing the gate prevents.
        expect(body.query).not.toContain("MAR");
        expect(body.query).not.toContain("186");
    });

    it("should build the same query for every issue, so the document cannot shape it", () => {
        const a = connectorApiRequest(matchFor(ISSUE_URL)) as { body: { query: string } };
        const b = connectorApiRequest(
            matchFor("https://linear.app/other/issue/ENG-9/something-else"),
        ) as { body: { query: string } };
        expect(a.body.query).toBe(b.body.query);
    });

    it("should ask nothing for a key it cannot split into a team and a number", () => {
        // Reached by constructing the match directly: the recognizer's own key
        // pattern would refuse most of these, and this site must be safe on its
        // own terms rather than by trusting that it was.
        for (const id of ["birta/issue/NOPE", "birta/issue/-12", "birta/issue/MAR-"]) {
            expect(connectorApiRequest({ kind: "linear", id })).toBeNull();
        }
    });
});

describe("linearCard", () => {
    const match = matchFor(ISSUE_URL);
    const ok = (nodes: unknown[]) => ({ data: { issues: { nodes } } });

    it("should map a complete issue to title, identifier with assignee, and state", () => {
        const card = linearCard(match, ok([{
            identifier: "MAR-186",
            title: "Embed provider roadmap",
            state: { name: "In Progress" },
            assignee: { displayName: "Harlan" },
        }]));
        expect(card).toEqual({
            title: "Embed provider roadmap",
            subtitle: "MAR-186 · Harlan",
            status: "In Progress",
        });
    });

    it("should show the key alone when nobody is assigned, with no trailing separator", () => {
        // `assignee: null` is what the API actually sends for an unassigned
        // issue, confirmed against api.linear.app rather than assumed. An
        // earlier version of this fixture OMITTED the key instead, which is a
        // shape the provider never produces and which would have passed while
        // leaving the null case untested.
        const card = linearCard(match, ok([{
            identifier: "MAR-186", title: "T", state: { name: "Todo" }, assignee: null,
        }]));
        expect(card?.subtitle).toBe("MAR-186");
    });

    it("should treat an absent assignee the same as a null one", () => {
        const card = linearCard(match, ok([{ identifier: "MAR-186", title: "T" }]));
        expect(card?.subtitle).toBe("MAR-186");
    });

    it("should pass a workspace's own state name through rather than mapping it", () => {
        // Linear's workflow states are workspace-defined, so a fixed vocabulary
        // would be wrong in exactly the workspaces that customized theirs.
        const card = linearCard(match, ok([{ title: "T", state: { name: "Shipped 🚢" } }]));
        expect(card?.status).toBe("Shipped 🚢");
    });

    it("should omit the status entirely when the issue carries no state", () => {
        const card = linearCard(match, ok([{ title: "T" }]));
        expect(card).not.toBeNull();
        expect("status" in card!).toBe(false);
    });

    it("should refuse a GraphQL error response, which arrives with status 200", () => {
        // The case that makes this different from a REST mapper: a refused
        // query is a 200 carrying `errors`, so without this check a permissions
        // failure would be reported as a malformed body.
        expect(linearCard(match, { errors: [{ message: "Access denied" }] })).toBeNull();
        expect(linearCard(match, { data: { issues: { nodes: [] } }, errors: [{ message: "x" }] })).toBeNull();
    });

    it("should refuse an empty result and a body that is not the promised shape", () => {
        for (const body of [ok([]), { data: {} }, {}, null, "text", { data: { issues: { nodes: [{}] } } }]) {
            expect(linearCard(match, body)).toBeNull();
        }
    });

    it("should fall back to the URL's key when the response omits the identifier", () => {
        const card = linearCard(match, ok([{ title: "T" }]));
        expect(card?.subtitle).toBe("MAR-186");
    });
});
