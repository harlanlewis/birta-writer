/**
 * Unit tests for the SSRF guard (src/utils/urlGuard.ts): private/reserved IP
 * classification (v4 + v6), blocked local hostnames, and the DNS-resolving
 * URL check with an injected resolver. Pure logic, the real DNS is never hit.
 *
 * The classification cases come from `shared/__fixtures__/urlGuardCases.json`,
 * which `mac/Tests/BirtaWriterCoreTests/UrlGuardTests.swift` reads as well. There
 * are two implementations of this guard, one per surface, and neither language
 * can import the other; sharing the cases is what makes a rule that only one
 * of them enforces show up as a failing test. Add a case to that file.
 */
import { describe, it, expect, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
    isPrivateIp,
    isBlockedHostname,
    isPubliclyRoutableUrl,
    _setDnsLookupForTests,
} from "../utils/urlGuard";

/** `[value, expected, why]` rows, shared with the Swift suite. */
const CASES = JSON.parse(readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "..", "shared", "__fixtures__", "urlGuardCases.json"),
    "utf8",
)) as { privateIps: [string, boolean, string][]; blockedHostnames: [string, boolean, string][] };

describe("isPrivateIp", () => {
    it("every shared address case should classify as the fixture says", () => {
        // The count is asserted so an unreadable or emptied fixture fails here
        // rather than passing with nothing run.
        expect(CASES.privateIps.length).toBeGreaterThanOrEqual(25);
        for (const [ip, expected, why] of CASES.privateIps) {
            expect(isPrivateIp(ip), `${ip}: ${why}`).toBe(expected);
        }
    });
});

describe("isBlockedHostname", () => {
    it("every shared hostname case should classify as the fixture says", () => {
        expect(CASES.blockedHostnames.length).toBeGreaterThanOrEqual(8);
        for (const [host, expected, why] of CASES.blockedHostnames) {
            expect(isBlockedHostname(host), `${host}: ${why}`).toBe(expected);
        }
    });
});

describe("isPubliclyRoutableUrl", () => {
    afterEach(() => {
        _setDnsLookupForTests(undefined);
    });

    it("an IP-literal URL should be judged without DNS", async () => {
        _setDnsLookupForTests(async () => {
            throw new Error("DNS must not be consulted for IP literals");
        });
        expect(await isPubliclyRoutableUrl(new URL("http://192.168.1.1/"))).toBe(false);
        expect(await isPubliclyRoutableUrl(new URL("http://8.8.8.8/"))).toBe(true);
        expect(await isPubliclyRoutableUrl(new URL("http://[::1]/"))).toBe(false);
    });

    it("a v4-mapped IPv6 URL should be refused THROUGH URL normalization (the real path)", async () => {
        _setDnsLookupForTests(async () => {
            throw new Error("DNS must not be consulted for IP literals");
        });
        // URL serializes these to compressed hex before the guard ever sees them.
        expect(await isPubliclyRoutableUrl(new URL("http://[::ffff:127.0.0.1]/"))).toBe(false);
        expect(await isPubliclyRoutableUrl(new URL("http://[::ffff:169.254.169.254]/"))).toBe(false);
        expect(await isPubliclyRoutableUrl(new URL("http://[::ffff:192.168.0.1]/"))).toBe(false);
        expect(await isPubliclyRoutableUrl(new URL("http://[64:ff9b::7f00:1]/"))).toBe(false);
        expect(await isPubliclyRoutableUrl(new URL("http://[2606:4700::6810:84e5]/"))).toBe(true);
    });

    it("a hostname resolving to a v4-mapped private address should be refused", async () => {
        _setDnsLookupForTests(async () => [{ address: "::ffff:10.0.0.5" }]);
        expect(await isPubliclyRoutableUrl(new URL("https://sneaky.example"))).toBe(false);
    });

    it("a hostname with any private DNS answer should be refused", async () => {
        _setDnsLookupForTests(async () => [
            { address: "93.184.216.34" },
            { address: "10.0.0.5" }, // one private answer poisons the set
        ]);
        expect(await isPubliclyRoutableUrl(new URL("https://evil.example"))).toBe(false);
    });

    it("a hostname resolving only publicly should be allowed", async () => {
        _setDnsLookupForTests(async () => [{ address: "93.184.216.34" }]);
        expect(await isPubliclyRoutableUrl(new URL("https://example.com"))).toBe(true);
    });

    it("DNS failure or an empty answer should fail closed", async () => {
        _setDnsLookupForTests(async () => {
            throw new Error("NXDOMAIN");
        });
        expect(await isPubliclyRoutableUrl(new URL("https://nope.example"))).toBe(false);
        _setDnsLookupForTests(async () => []);
        expect(await isPubliclyRoutableUrl(new URL("https://empty.example"))).toBe(false);
    });

    it("blocked hostnames should be refused before DNS", async () => {
        _setDnsLookupForTests(async () => {
            throw new Error("DNS must not be consulted for blocked names");
        });
        expect(await isPubliclyRoutableUrl(new URL("http://localhost:3000/"))).toBe(false);
    });
});
