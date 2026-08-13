/**
 * src/connectors/fetchCard.ts
 *
 * The one place a connector credential is put on the wire (MAR-198). Every
 * credential-bearing request in the extension goes through this function, so
 * the rung-2 network invariants have exactly one enforcement site.
 *
 * What it guarantees, in the order it checks:
 *  - https only, and the host must be one of the connector's pinned
 *    `apiHosts`. The URL arrives already built from validated parts
 *    (shared/connectors.ts), so today nothing reaches here off a pinned host;
 *    the check is here because the site that attaches a token must be safe on
 *    its own terms rather than by trusting its only current caller, and
 *    fetchCard.test.ts exercises it directly for the same reason.
 *  - the SSRF guard, so a pinned host that resolves to a private address is
 *    still refused.
 *  - `redirect: "manual"`, which is how a credential is kept from following a
 *    URL to a host the pin never approved.
 *  - a bounded, typed, non-throwing read: timeout, size cap, JSON
 *    content-type, and a parse whose failure is an outcome rather than an
 *    exception.
 *
 * The credential is a parameter and is never logged, never returned, and never
 * stored here.
 */
import { reportError } from "../errorSink";
import { isPubliclyRoutableUrl } from "../utils/urlGuard";
import { readCappedText } from "../utils/cappedRead";
import type { ConnectorSpec } from "../../shared/connectors";

/** Same total-time bound as the oEmbed fetch: decoration must never hang. */
const CONNECTOR_TIMEOUT_MS = 5000;
/** A single issue/PR/repo JSON; 512 KB is headroom, not a real budget. */
const CONNECTOR_MAX_BYTES = 512 * 1024;

/**
 * The outcome of one connector request. `expired` and `error` map straight to
 * card states, so the caller never has to interpret a status code.
 */
export type ConnectorFetchOutcome =
    | { state: "ok"; body: unknown }
    /** The provider rejected the credential: it was revoked, or it lapsed. */
    | { state: "expired" }
    /**
     * The resource is not visible to whoever asked. Distinct from `error`
     * because it is the ONE failure a credential might fix: GitHub answers 404
     * rather than 403 for a private repository, deliberately, so that an
     * unauthenticated caller cannot probe for existence. An anonymous read
     * that lands here is exactly the case worth offering a connection for.
     */
    | { state: "notFound" }
    /** Anything else: offline, refused, rate-limited, malformed, redirected. */
    | { state: "error" };

/**
 * Perform one GET against a connector's pinned API and return its parsed JSON
 * body. Never throws.
 *
 * `token` is nullable on purpose. Most cards this fetches are public, and a
 * public read needs no credential at all — sending one anyway would mean
 * demanding a grant to show a title that is already world-readable. When it is
 * null no `authorization` header is built, so an anonymous read is anonymous
 * in fact rather than by intention.
 */
export async function fetchConnectorCard(
    spec: ConnectorSpec,
    requestUrl: string,
    token: string | null,
): Promise<ConnectorFetchOutcome> {
    let parsed: URL;
    try {
        parsed = new URL(requestUrl);
    } catch {
        return { state: "error" };
    }
    if (parsed.protocol !== "https:" || !spec.apiHosts.includes(parsed.hostname)) {
        return { state: "error" };
    }
    if (!(await isPubliclyRoutableUrl(parsed))) {
        return { state: "error" };
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONNECTOR_TIMEOUT_MS);
    try {
        const res = await globalThis.fetch(parsed.href, {
            signal: controller.signal,
            // This is where "credentials are not carried across redirects"
            // is enforced: the second request is never made, rather than made
            // without the header. A 3xx then arrives as a non-ok response and
            // falls into the failure branch below, so there is deliberately no
            // separate status check for it — one that could not be told apart
            // from `!res.ok` would be untested code claiming to be a guard.
            redirect: "manual",
            headers: {
                accept: "application/json",
                ...(token === null ? {} : { authorization: `Bearer ${token}` }),
                "user-agent": "Birta-Writer/connector",
            },
        });
        if (res.status === 401) {
            return { state: "expired" };
        }
        // 403 is GitHub's rate-limit answer as well as its forbidden answer,
        // and the anonymous limit is low enough (60/hour, keyed on the IP) that
        // a big document can reach it. Both readings are "ask again later with
        // more standing", which is what the connect offer says, so they share
        // an outcome rather than guessing between them from a header.
        if (res.status === 404 || res.status === 403) {
            return { state: "notFound" };
        }
        if (!res.ok) {
            return { state: "error" };
        }
        const contentType = res.headers.get("content-type");
        if (!contentType || !/json/i.test(contentType)) {
            return { state: "error" };
        }
        const body = await readCappedText(res, CONNECTOR_MAX_BYTES);
        return { state: "ok", body: JSON.parse(body) as unknown };
    } catch (e) {
        // Offline, DNS failure, abort-on-timeout, malformed JSON. The error
        // sink is console-only, and the message never carries the credential.
        reportError("resolveEmbedCard", e);
        return { state: "error" };
    } finally {
        clearTimeout(timer);
    }
}
