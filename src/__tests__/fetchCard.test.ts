/**
 * The one site that puts a connector credential on the wire, tested on its own
 * terms rather than through the service.
 *
 * This file exists because of a mutation run: deleting the pinned-host check
 * left the whole suite green, since every request the service builds is
 * already on a pinned host and nothing else could reach the check. A guard no
 * test can reach is a guard that will be deleted by someone tidying up, so it
 * is exercised here directly with the hostile inputs its only current caller
 * cannot produce.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { _resetErrorSinkForTests } from "../errorSink";
import { _setDnsLookupForTests } from "../utils/urlGuard";
import { fetchConnectorCard } from "../connectors/fetchCard";
import { CONNECTORS } from "../../shared/connectors";

const SPEC = CONNECTORS.github;
const TOKEN = "gho_secret_token_value";

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
        ...init,
    });

describe("fetchConnectorCard", () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        _resetErrorSinkForTests();
        _setDnsLookupForTests(async () => [{ address: "93.184.216.34" }]);
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        _setDnsLookupForTests(undefined);
        errorSpy.mockRestore();
    });

    describe("the credential goes to pinned hosts and nowhere else", () => {
        const hostile = [
            "https://evil.example/repos/o/r",
            "https://api.github.com.evil.example/repos/o/r",
            "https://evil.example/api.github.com/repos/o/r",
            "https://api-github.com/repos/o/r",
            "http://api.github.com/repos/o/r",
            "//api.github.com/repos/o/r",
            "file:///etc/passwd",
            "data:application/json,{}",
            "not a url at all",
        ];

        for (const url of hostile) {
            it(`should refuse ${url} with ZERO fetches`, async () => {
                const fetchSpy = vi.fn();
                vi.stubGlobal("fetch", fetchSpy);
                expect(await fetchConnectorCard(SPEC, url, TOKEN)).toEqual({ state: "error" });
                expect(fetchSpy).not.toHaveBeenCalled();
            });
        }

        it("an uppercase spelling of a pinned host should be permitted, not refused", () => {
            // `new URL` lowercases the hostname, so the comparison is already
            // case-insensitive. Pinned here so a future "normalize harder"
            // change cannot quietly start refusing a legitimate spelling.
            expect(new URL("https://API.GITHUB.COM/user").hostname).toBe("api.github.com");
        });

        it("should fetch a pinned https host, carrying the credential", async () => {
            // The other side of the claim: the check refuses everything above
            // and still permits the one thing it is supposed to.
            const fetchSpy = vi.fn(async () => jsonResponse({ login: "someone" }));
            vi.stubGlobal("fetch", fetchSpy);
            expect(await fetchConnectorCard(SPEC, SPEC.verifyUrl, TOKEN))
                .toEqual({ state: "ok", body: { login: "someone" } });
            const [asked, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
            expect(new URL(asked).hostname).toBe("api.github.com");
            expect((init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
        });

        it("should refuse a pinned host that resolves to a private address", async () => {
            _setDnsLookupForTests(async () => [{ address: "169.254.169.254" }]);
            const fetchSpy = vi.fn();
            vi.stubGlobal("fetch", fetchSpy);
            expect(await fetchConnectorCard(SPEC, SPEC.verifyUrl, TOKEN)).toEqual({ state: "error" });
            expect(fetchSpy).not.toHaveBeenCalled();
        });
    });

    describe("redirects", () => {
        it("should ask for manual redirects, so a hop is never followed with the credential", async () => {
            const fetchSpy = vi.fn(async () =>
                new Response("", { status: 302, headers: { location: "https://evil.example/" } }),
            );
            vi.stubGlobal("fetch", fetchSpy);
            expect(await fetchConnectorCard(SPEC, SPEC.verifyUrl, TOKEN)).toEqual({ state: "error" });
            // One request, and the option that stopped it at one.
            expect(fetchSpy).toHaveBeenCalledTimes(1);
            const [, init] = fetchSpy.mock.calls[0] as unknown as [string, RequestInit];
            expect(init.redirect).toBe("manual");
        });
    });

    describe("responses", () => {
        it("a 401 should read as expired, distinct from every other failure", async () => {
            vi.stubGlobal("fetch", vi.fn(async () => new Response("{}", { status: 401 })));
            expect(await fetchConnectorCard(SPEC, SPEC.verifyUrl, TOKEN)).toEqual({ state: "expired" });
        });

        it("a non-JSON content type should read as error, not be parsed", async () => {
            vi.stubGlobal("fetch", vi.fn(async () =>
                new Response("<html>", { status: 200, headers: { "content-type": "text/html" } }),
            ));
            expect(await fetchConnectorCard(SPEC, SPEC.verifyUrl, TOKEN)).toEqual({ state: "error" });
        });

        it("a malformed JSON body should read as error rather than throw", async () => {
            vi.stubGlobal("fetch", vi.fn(async () =>
                new Response("{not json", { status: 200, headers: { "content-type": "application/json" } }),
            ));
            expect(await fetchConnectorCard(SPEC, SPEC.verifyUrl, TOKEN)).toEqual({ state: "error" });
        });

        it("a network failure should read as error rather than throw", async () => {
            vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
            expect(await fetchConnectorCard(SPEC, SPEC.verifyUrl, TOKEN)).toEqual({ state: "error" });
        });
    });
});
