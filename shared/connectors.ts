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
import { githubCardParts, type EmbedKind, type EmbedMatch } from "./embedProviders";

/** The connectors this pass understands. Widen the union to add one. */
export type ConnectorId = "github";

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
 * Only `builtin` has a live row today. The other two are named because the
 * seam is shaped for them, and a strategy with no provider behind it would be
 * a code path nothing has ever run.
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
     * The scopes requested at connect time. Read-only and minimal
     * (NETWORK_POSTURE invariant 9) — a connector that cannot narrow its
     * grant must say so in `scopeNote`.
     */
    scopes: readonly string[];
    /**
     * What the grant actually covers, shown before the user proceeds. Present
     * whenever the scope is broader than "the thing on the card".
     */
    scopeNote?: string;
    /**
     * Hosts this connector's credential may be sent to. Exact hosts, no
     * wildcards, compared with `===`. Every outgoing request is checked
     * against this list at the fetch site as well as being built from it here.
     */
    apiHosts: readonly string[];
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
        // `repo` is GitHub's narrowest grant that still reads a private
        // repository's issues and pull requests; there is no read-only
        // variant of it in the classic scope set VS Code's built-in provider
        // issues, which is exactly why scopeNote exists.
        scopes: ["repo"],
        scopeNote: "GitHub's repo scope also permits writes; Birta only ever reads.",
        apiHosts: ["api.github.com"],
        verifyUrl: "https://api.github.com/user",
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
    return kind === "github" ? "github" : null;
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
