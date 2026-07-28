/**
 * The embed-metadata fetcher (oEmbed titles, rung 1): gates, request-URL
 * reconstruction, response hardening, and the session cache. `fetch` is
 * stubbed throughout — what's under test is what the fetcher ASKS for and how
 * it treats what comes back, never a live endpoint.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as vscode from "vscode";
import { _resetErrorSinkForTests } from "../errorSink";
import { _setDnsLookupForTests } from "../utils/urlGuard";
import { fetchEmbedTitle, _resetEmbedMetaCacheForTests } from "../utils/embedMetaFetcher";

const YT = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
const LOOM = `https://www.loom.com/share/${"0".repeat(32)}`;

/** Configure the birta config mock's gates (defaults pass everything else). */
function mockGates(opts: { network: boolean; embeds?: boolean }): void {
    (vscode.workspace.getConfiguration as unknown as ReturnType<typeof vi.fn>).mockReturnValue({
        get: vi.fn((key: string, defaultValue?: unknown) => {
            if (key === "network.enabled") { return opts.network; }
            if (key === "embeds.enabled") { return opts.embeds ?? true; }
            return defaultValue;
        }),
        inspect: vi.fn(() => undefined),
    });
}

const jsonResponse = (body: unknown, init: ResponseInit = {}): Response =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
        status: 200,
        headers: { "content-type": "application/json" },
        ...init,
    });

describe("fetchEmbedTitle", () => {
    let errorSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
        vi.clearAllMocks();
        _resetErrorSinkForTests();
        _resetEmbedMetaCacheForTests();
        mockGates({ network: true });
        _setDnsLookupForTests(async () => [{ address: "93.184.216.34" }]);
        errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    });

    afterEach(() => {
        vi.unstubAllGlobals();
        _setDnsLookupForTests(undefined);
        errorSpy.mockRestore();
    });

    it("the master network switch OFF should resolve null with ZERO fetches", async () => {
        mockGates({ network: false });
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);
        expect(await fetchEmbedTitle(YT)).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("the embeds feature switch OFF should resolve null with ZERO fetches", async () => {
        mockGates({ network: true, embeds: false });
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);
        expect(await fetchEmbedTitle(YT)).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("an unrecognized URL should resolve null with ZERO fetches", async () => {
        const fetchSpy = vi.fn();
        vi.stubGlobal("fetch", fetchSpy);
        expect(await fetchEmbedTitle("https://www.twitch.tv/videos/1234567890")).toBeNull();
        expect(await fetchEmbedTitle("https://example.com/x")).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();
    });

    it("a successful oEmbed reply should resolve the sanitized title", async () => {
        const fetchSpy = vi.fn(async () => jsonResponse({ title: "  Never Gonna  Give " }));
        vi.stubGlobal("fetch", fetchSpy);
        expect(await fetchEmbedTitle(YT)).toBe("Never Gonna Give");
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("the request URL should be REBUILT from validated parts, never the raw string", async () => {
        const fetchSpy = vi.fn(async () => jsonResponse({ title: "T" }));
        vi.stubGlobal("fetch", fetchSpy);
        // A recognized YouTube URL carrying extra params and a nonstandard host.
        await fetchEmbedTitle("https://m.youtube.com/watch?v=dQw4w9WgXcQ&t=42&si=tracking");
        const asked = fetchSpy.mock.calls[0][0] as string;
        // Endpoint is the pinned host; the url param is the CANONICAL page —
        // the tracking params and the m. host never reach the wire.
        expect(asked.startsWith("https://www.youtube.com/oembed?")).toBe(true);
        expect(asked).toContain(encodeURIComponent(YT));
        expect(asked).not.toContain("tracking");
    });

    it("a redirect status should resolve null (manual redirects, never followed)", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => new Response(null, { status: 301, headers: { location: "https://evil.example" } })));
        expect(await fetchEmbedTitle(YT)).toBeNull();
    });

    it("a non-JSON content-type should resolve null", async () => {
        vi.stubGlobal("fetch", vi.fn(async () =>
            new Response("<!doctype html>", { status: 200, headers: { "content-type": "text/html" } })));
        expect(await fetchEmbedTitle(YT)).toBeNull();
    });

    it("malformed JSON and a non-string title should both resolve null", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse("not json{{")));
        expect(await fetchEmbedTitle(YT)).toBeNull();
        _resetEmbedMetaCacheForTests();
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ title: 42 })));
        expect(await fetchEmbedTitle(YT)).toBeNull();
    });

    it("a network throw should resolve null and log via the console-only sink", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("offline"); }));
        expect(await fetchEmbedTitle(YT)).toBeNull();
        expect(errorSpy).toHaveBeenCalled();
        expect(vscode.window.showErrorMessage).not.toHaveBeenCalled();
    });

    it("the session cache should dedupe: same id → one fetch, concurrent included", async () => {
        let resolveBody: (r: Response) => void;
        const gate = new Promise<Response>((r) => { resolveBody = r; });
        const fetchSpy = vi.fn(() => gate);
        vi.stubGlobal("fetch", fetchSpy);

        const first = fetchEmbedTitle(YT);
        const second = fetchEmbedTitle(YT); // in-flight: must share the promise
        resolveBody!(jsonResponse({ title: "Once" }));
        expect(await first).toBe("Once");
        expect(await second).toBe("Once");
        expect(await fetchEmbedTitle(YT)).toBe("Once"); // settled: cache hit
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("a failure should be negatively cached — a dead endpoint is asked once", async () => {
        const fetchSpy = vi.fn(async () => new Response("nope", { status: 404 }));
        vi.stubGlobal("fetch", fetchSpy);
        expect(await fetchEmbedTitle(LOOM)).toBeNull();
        expect(await fetchEmbedTitle(LOOM)).toBeNull();
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("a closed gate should NOT poison the cache for a later enable", async () => {
        mockGates({ network: false });
        const fetchSpy = vi.fn(async () => jsonResponse({ title: "Later" }));
        vi.stubGlobal("fetch", fetchSpy);
        expect(await fetchEmbedTitle(YT)).toBeNull();
        expect(fetchSpy).not.toHaveBeenCalled();

        mockGates({ network: true });
        expect(await fetchEmbedTitle(YT)).toBe("Later");
        expect(fetchSpy).toHaveBeenCalledTimes(1);
    });

    it("networkOverride should bridge the in-flight opt-in write", async () => {
        mockGates({ network: false });
        const fetchSpy = vi.fn(async () => jsonResponse({ title: "Bridged" }));
        vi.stubGlobal("fetch", fetchSpy);
        expect(await fetchEmbedTitle(YT, { networkOverride: true })).toBe("Bridged");
    });

    it("an over-long title should be capped by sanitizeTitle", async () => {
        vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ title: "x".repeat(1000) })));
        const title = await fetchEmbedTitle(YT);
        expect(title).not.toBeNull();
        expect(title!.length).toBeLessThanOrEqual(300);
    });
});
