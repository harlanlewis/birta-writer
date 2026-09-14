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

/**
 * A POST body and the encoding its recipient requires.
 *
 * `form` exists because RFC 6749 requires the OAuth token endpoint to take
 * `application/x-www-form-urlencoded`, so the exchange cannot ride the JSON
 * path a GraphQL card uses.
 */
export type ConnectorRequestBody =
    | { kind: "json"; value: unknown }
    | { kind: "form"; value: URLSearchParams };

const CONTENT_TYPE: Record<ConnectorRequestBody["kind"], string> = {
    json: "application/json",
    form: "application/x-www-form-urlencoded",
};

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
    /**
     * Anything else: offline, refused, rate-limited, malformed, redirected.
     *
     * `status` is present when the failure was an HTTP response rather than a
     * transport or parse failure, and absent when there was no response to read
     * a status off. The card path ignores it; the OAuth path needs it, because
     * the states above are a CARD's vocabulary and a token endpoint does not
     * share it. RFC 6749 has that endpoint answer 400 for a refused grant,
     * which is indistinguishable here from being offline unless the status
     * travels with the failure.
     */
    | { state: "error"; status?: number };

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
    /**
     * A body to POST. Absent means GET.
     *
     * Two encodings because the two callers have no choice about theirs. A
     * GraphQL card is JSON, which is what Linear's API accepts and the only
     * reason this parameter exists at all. An OAuth token exchange is
     * form-encoded, which RFC 6749 requires of the token endpoint, so sending
     * it as JSON would be refused by a spec-compliant provider.
     *
     * It changes the method and the content type and NOTHING else: the https
     * check, the pinned-host check, the SSRF guard, the manual redirect, the
     * timeout and the capped read all run exactly as before, which is why this
     * stays one enforcement site rather than becoming two.
     */
    requestBody?: ConnectorRequestBody,
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
            ...(requestBody === undefined
                ? {}
                : {
                    method: "POST",
                    body: requestBody.kind === "json"
                        ? JSON.stringify(requestBody.value)
                        : requestBody.value.toString(),
                }),
            headers: {
                accept: "application/json",
                ...(requestBody === undefined ? {} : { "content-type": CONTENT_TYPE[requestBody.kind] }),
                ...(token === null ? {} : { authorization: `Bearer ${token}` }),
                "user-agent": "Birta-Writer/connector",
            },
        });
        if (res.status === 401) {
            return { state: "expired" };
        }
        // 404 is the not-visible answer, and for GitHub it is also the
        // private-repository answer: it replies 404 rather than 403 so an
        // anonymous caller cannot probe for existence.
        if (res.status === 404) {
            return { state: "notFound" };
        }
        // 403 is the rate-limit answer as well as the forbidden one. It counts
        // as not-visible ONLY for an anonymous read, where connecting genuinely
        // helps: the anonymous budget is 60/hour keyed on the IP and shared
        // with everything else on it, against 5,000/hour for any signed-in
        // user. For a request that already carried a credential, connecting
        // more buys nothing — every authenticated tier shares one budget — so
        // offering an upgrade there would be a suggestion that cannot work.
        if (res.status === 403) {
            return token === null ? { state: "notFound" } : { state: "error", status: 403 };
        }
        if (!res.ok) {
            return { state: "error", status: res.status };
        }
        const contentType = res.headers.get("content-type");
        if (!contentType || !/json/i.test(contentType)) {
            // No status: the response arrived and was a success by HTTP's
            // reckoning, so carrying a 200 here would tell the OAuth path the
            // provider refused when the provider answered fine and sent
            // something unreadable.
            return { state: "error" };
        }
        const body = await readCappedText(res, CONNECTOR_MAX_BYTES);
        return { state: "ok", body: JSON.parse(body) as unknown };
    } catch (e) {
        // Offline, DNS failure, abort-on-timeout, malformed JSON. The error
        // sink is console-only, and the message never carries the credential.
        // Named for the guarded fetch rather than for cards: token exchanges
        // ride this same site, and logging one as a card resolution sends
        // whoever reads the sink looking in the wrong place.
        reportError("connectorFetch", e);
        return { state: "error" };
    } finally {
        clearTimeout(timer);
    }
}
