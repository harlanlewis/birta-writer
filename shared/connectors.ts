/**
 * shared/connectors.ts
 *
 * The pure core of the embed CONNECTOR seam (MAR-198): which providers have an
 * authenticated rung-1 card, how each one authenticates, the hosts its API may
 * be reached at, and the request URL built from validated parts.
 *
 * This is rung 2 of the network posture (docs/NETWORK_POSTURE.md): a URL the
 * user typed plus a per-provider credential, sent to that provider's pinned
 * API hosts and nowhere else. The credential itself never appears here — this
 * module is imported by the webview, which is the least-trusted surface.
 *
 * No DOM, no network, no VS Code API, no secrets. Everything is pure string
 * work over an already-validated EmbedMatch, which is what makes the
 * confused-deputy invariant (NETWORK_POSTURE 6) checkable: a document's URL
 * string only ever SELECTS a connector, and every byte of the outgoing request
 * is rebuilt here from parts the recognizer already validated.
 */
import { githubCardParts, linearCardParts, type EmbedKind, type EmbedMatch } from "./embedProviders";

/** The connectors this pass understands. Widen the union to add one. */
export type ConnectorId = "github" | "linear";

/**
 * How a connector obtains its credential. The strategy is a property of the
 * provider, not a preference: each provider supports exactly the rungs its own
 * platform offers, and the most ergonomic available one wins.
 *
 *  - `builtin`: a credential VS Code already manages
 *    (`vscode.authentication.getSession`). Nothing to register, nothing to
 *    store, refresh handled by the host. The only rung that costs the user
 *    one click and costs the maintainer nothing.
 *  - `oauth-pkce`: browser consent through the extension's URI handler, tokens
 *    into SecretStorage. Needs a registered public client (a client id) from
 *    the provider, so it cannot be shipped without the maintainer.
 *  - `token`: the user pastes a personal access token. The universal fallback,
 *    for providers whose OAuth demands a confidential client secret (which is
 *    unshippable inside a distributed extension) or a verification program.
 *
 * `token` has no live row: it is named because the seam is shaped for it, and
 * a strategy with no provider behind it is a code path nothing has ever run.
 */
export type ConnectorAuthKind = "builtin" | "oauth-pkce" | "token";

/** One connector's static description. Pure data; no credential, ever. */
export interface ConnectorSpec {
    id: ConnectorId;
    /** Human label, used in the connect UI and on locked cards. */
    label: string;
    auth: ConnectorAuthKind;
    /**
     * The VS Code authentication provider id, for `auth: "builtin"` only.
     * `vscode.authentication.getSession` takes this verbatim.
     */
    builtinProviderId?: string;
    /**
     * The registered public client, for `auth: "oauth-pkce"` only.
     *
     * None of this is a credential. A PKCE public client has no secret by
     * construction, which is the property that lets the flow ship inside a
     * distributed extension at all, and the client id is published in every
     * authorize URL the browser shows. So it belongs in this file, which the
     * webview imports, on the same terms as `apiHosts`: public facts about a
     * provider, stated once, where the confused-deputy guard can read them.
     *
     * The two URLs are separate fields rather than one host because providers
     * routinely split them, and both are pinned: `oauthHosts.test.ts` holds
     * each to https and to a host this connector already names.
     */
    oauth?: {
        readonly clientId: string;
        readonly authorizeUrl: string;
        readonly tokenUrl: string;
    };
    /**
     * The scopes requested by an ordinary connect. Read-only and minimal
     * (NETWORK_POSTURE invariant 9), and for GitHub that means EMPTY: a
     * scopeless OAuth token reads public repository, user and gist data and
     * nothing else, which is every card this connector builds unless the user
     * asks for private ones.
     */
    scopes: readonly string[];
    /**
     * The scopes an opt-in private connect requests, when the provider offers
     * no way to read private resources without a broader grant than we want.
     * Absent when `scopes` already reaches everything.
     */
    privateScopes?: readonly string[];
    /**
     * What `privateScopes` actually covers, shown before the user proceeds.
     * Required whenever `privateScopes` is broader than reading — which for
     * GitHub it unavoidably is, because no OAuth scope grants read-only access
     * to a private repository.
     */
    scopeNote?: string;
    /**
     * Hosts this connector's credential may be sent to. Exact hosts, no
     * wildcards, compared with `===`. Every outgoing request is checked
     * against this list at the fetch site as well as being built from it here.
     */
    apiHosts: readonly string[];
    /**
     * Whether this provider answers anything useful WITHOUT a credential.
     *
     * GitHub does: a public repository's issues and pull requests read fine
     * anonymously, which is what makes connecting an upgrade rather than an
     * entry fee. Linear does not: its API is authenticated in full, so an
     * unconnected request can only ever fail.
     *
     * False means no request is made at all until the user connects, and the
     * card is `locked` rather than `expired`. Both halves matter. A 401 from an
     * unconnected provider maps to `expired`, which tells somebody to RE-connect
     * a service they never connected. And the request itself would send the
     * document's issue ids to a provider that cannot answer, which is a leak
     * bought for nothing.
     */
    anonymousReads: boolean;
    /**
     * The one call `connect` makes to prove a fresh credential works before
     * the connection is recorded. It must be the cheapest authenticated
     * endpoint the provider has, and it must not name any document's content:
     * verifying is about the credential, not about anything the user opened.
     */
    verifyUrl: string;
}

/** Every connector, keyed by id. */
export const CONNECTORS: Record<ConnectorId, ConnectorSpec> = {
    github: {
        id: "github",
        label: "GitHub",
        auth: "builtin",
        builtinProviderId: "github",
        // EMPTY on purpose. GitHub documents a scopeless token as "read-only
        // access to public information (including user profile info,
        // repository info, and gists)", which is every card this connector
        // builds for a public link, and it lifts the rate limit from the
        // anonymous 60/hour-per-IP to 5,000/hour. Asking for more than that
        // to show a world-readable title would be a grant the card never uses.
        scopes: [],
        // `repo` is GitHub's narrowest grant that reads a PRIVATE repository's
        // issues and pull requests, and it is not narrow: there is no
        // read-only variant anywhere in the OAuth scope set, so reading a
        // private repo necessarily carries write. That is why this is opt-in
        // rather than the default, and why scopeNote is mandatory beside it.
        privateScopes: ["repo"],
        scopeNote: "GitHub grants no read-only access to private repositories: this also permits writes. Birta only ever reads.",
        apiHosts: ["api.github.com"],
        // A scopeless read of public repository data needs no credential, which
        // is why a GitHub card works before anyone connects anything.
        anonymousReads: true,
        verifyUrl: "https://api.github.com/user",
    },
    linear: {
        id: "linear",
        label: "Linear",
        auth: "oauth-pkce",
        oauth: {
            // Registered 2026-09-12 as a public application. Not a secret: it
            // is in every authorize URL the browser shows, and a PKCE public
            // client has no secret to pair it with.
            clientId: "c07c04224e8cf83638f63971153ca008",
            authorizeUrl: "https://linear.app/oauth/authorize",
            tokenUrl: "https://api.linear.app/oauth/token",
        },
        // `read` is Linear's whole read surface and its narrowest one: there is
        // no per-resource read scope to ask for instead. No write scope is ever
        // requested, which is what keeps invariant 5 (render-only) true at the
        // grant rather than only in our code.
        scopes: ["read"],
        // Only the API host. `linear.app` carries the consent page and is
        // opened in the browser rather than fetched, so it is deliberately not
        // here: this list is what a CREDENTIAL may be sent to.
        apiHosts: ["api.linear.app"],
        // Linear's API is authenticated in full: there is no anonymous read of
        // anything, so an unconnected request can only fail. Asking anyway
        // would leak the document's issue ids for a 401.
        anonymousReads: false,
        verifyUrl: "https://api.linear.app/graphql",
    },
};

/** Every connector id, for iteration (the connect/disconnect pickers). */
export const CONNECTOR_IDS: readonly ConnectorId[] = Object.keys(CONNECTORS) as ConnectorId[];

/**
 * The connector that can upgrade a given embed provider's card, or null when
 * that provider has no authenticated rung. A provider absent here can never
 * cause a credential-bearing request, which is the point.
 */
export function connectorForEmbedKind(kind: EmbedKind): ConnectorId | null {
    if (kind === "github") { return "github"; }
    if (kind === "linear") { return "linear"; }
    return null;
}

/** GitHub owner/repo/ref segments, re-validated at the request-building site. */
const GITHUB_SEGMENT = /^[A-Za-z0-9_.-]+$/;

/**
 * A path segment safe to interpolate into a request URL: the provider's
 * charset, and not a dot segment.
 *
 * The dot check is not redundant with the charset. A GitHub owner may contain
 * dots, so `.` and `..` both satisfy GITHUB_SEGMENT, and `encodeURIComponent`
 * leaves them untouched — which is how `owner/repo` of `../..` once built
 * `https://api.github.com/repos/../..`, a URL that normalizes to the API root
 * rather than to the repository the document named. The host pin still held,
 * so the credential could not have left api.github.com; what failed was the
 * narrower claim this module exists to make, that the outgoing request is
 * rebuilt from validated parts. `githubId` rejects dot segments for the same
 * reason, and this site must not depend on that having happened upstream.
 */
function safeSegment(value: string | undefined): value is string {
    return value !== undefined && GITHUB_SEGMENT.test(value) && !/^\.\.?$/.test(value);
}

/** A resolved API request: which connector's credential, and the exact URL. */
export interface ConnectorApiRequest {
    connector: ConnectorId;
    /** Absolute https URL on one of the connector's pinned `apiHosts`. */
    url: string;
    /**
     * A JSON body to POST, for a provider with no GET surface.
     *
     * Absent means GET, which is what every REST provider uses and what this
     * seam assumed until Linear. Linear's API is GraphQL and answers POST only,
     * so a card there is a query rather than a path, and the variables carry
     * the validated parts instead of the URL doing it.
     *
     * That difference matters to the confused-deputy guard rather than just to
     * plumbing: with GET, the validated parts are interpolated into a path and
     * `safeSegment` is what keeps them from escaping it. With a GraphQL query
     * the parts travel as JSON variables, so they cannot escape into the
     * request's shape at all, and the query string itself is a constant this
     * module owns. Neither the document nor its URL can reach it.
     */
    body?: unknown;
}

/**
 * The one GraphQL document this module will send, as a constant.
 *
 * A constant rather than a built string, and the distinction is the whole
 * confused-deputy argument for the GraphQL path: nothing a document contains
 * can change the query's shape, only the values bound to `$team` and
 * `$number`. Those two are re-validated below.
 *
 * An issue is looked up by team key and number rather than by the `MAR-186`
 * identifier as one string, because the identifier is what the URL carries and
 * splitting it here is what lets both halves be checked.
 */
const LINEAR_ISSUE_QUERY =
    "query BirtaIssue($team: String!, $number: Float!) {"
    + " issues(filter: { team: { key: { eq: $team } }, number: { eq: $number } }, first: 1) {"
    + " nodes { identifier title state { name } assignee { displayName } } } }";

/** The issue key splits into a team key and a number: `MAR-186`. */
const LINEAR_KEY_PARTS = /^([A-Za-z0-9]+)-([0-9]+)$/;

/**
 * Build Linear's card request: a GraphQL POST carrying validated variables.
 *
 * Returns null rather than a partial request whenever the key does not split
 * into exactly a team and a number, so a URL the recognizer accepted but this
 * cannot decompose asks nothing at all.
 */
function linearApiRequest(match: EmbedMatch): ConnectorApiRequest | null {
    const { key } = linearCardParts(match.id);
    const parts = LINEAR_KEY_PARTS.exec(key);
    if (!parts) {
        return null;
    }
    const number = Number(parts[2]);
    // A key whose number does not survive the round trip is not asked about.
    // `Number.isSafeInteger` rather than `isFinite`: an issue number past 2^53
    // does not exist, and a value that large would be sent as something other
    // than what the URL said.
    if (!Number.isSafeInteger(number)) {
        return null;
    }
    return {
        connector: "linear",
        url: "https://api.linear.app/graphql",
        body: {
            query: LINEAR_ISSUE_QUERY,
            variables: { team: parts[1], number },
        },
    };
}

/**
 * Build the API request for a recognized embed, or null when there is nothing
 * to ask (no connector, or a shape whose card the API cannot improve on).
 *
 * This is the confused-deputy gate. It never sees the document's URL string:
 * its only input is an EmbedMatch, whose id the recognizer already validated,
 * and it re-validates every segment it interpolates rather than trusting that.
 * There is deliberately no code path from an arbitrary string to a URL here.
 */
export function connectorApiRequest(match: EmbedMatch): ConnectorApiRequest | null {
    const connector = connectorForEmbedKind(match.kind);
    if (connector === "linear") {
        return linearApiRequest(match);
    }
    if (connector !== "github") {
        return null;
    }
    const parts = githubCardParts(match.id);
    const { owner, repo } = parts;
    // A segment that fails here yields no request at all.
    if (!safeSegment(owner) || !safeSegment(repo)) {
        return null;
    }
    const base = `https://api.github.com/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    if (parts.kind === "repo") {
        return { connector, url: base };
    }
    if (parts.kind === "pull" || parts.kind === "issue") {
        if (!parts.number || !/^\d+$/.test(parts.number)) {
            return null;
        }
        // GitHub's issues endpoint answers for pull requests too, but the
        // pulls endpoint carries `merged`, which is the state difference a
        // reader of a PR card actually wants.
        const path = parts.kind === "pull" ? "pulls" : "issues";
        return { connector, url: `${base}/${path}/${parts.number}` };
    }
    // A blob URL names a file, and the file's own metadata is not what the
    // card shows; its rung-0 card (owner/repo plus path) is already complete.
    return null;
}

/** The sanitized, provider-agnostic card payload the webview renders. */
export interface EmbedCardData {
    /** The card's headline, e.g. a PR title or a repository name. */
    title: string;
    /** One supporting line: an author, a space, a due date. */
    subtitle?: string;
    /** A short state word for the status chip, e.g. "Open" or "Merged". */
    status?: string;
}

/**
 * The answer to a card resolve. Every failure is a NAMED state rather than an
 * absent card (NETWORK_POSTURE / MAR-198 invariant 8): a reader must be able
 * to tell "you never connected this" from "your grant expired" from "the
 * request failed", because only two of the three are worth acting on.
 */
export type EmbedCardResult =
    | { state: "ready"; connector: ConnectorId; card: EmbedCardData }
    /** No credential recorded for this connector: the user never connected it. */
    | { state: "locked"; connector: ConnectorId }
    /** A credential was recorded, and the provider will no longer honour it. */
    | { state: "expired"; connector: ConnectorId }
    /** Connected and current, but this request did not come back. */
    | { state: "error"; connector: ConnectorId };
