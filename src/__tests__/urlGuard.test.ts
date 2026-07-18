/**
 * Unit tests for the SSRF guard (src/utils/urlGuard.ts): private/reserved IP
 * classification (v4 + v6), blocked local hostnames, and the DNS-resolving
 * URL check with an injected resolver. Pure logic — the real DNS is never hit.
 */
import { describe, it, expect, afterEach } from "vitest";
import {
    isPrivateIp,
    isBlockedHostname,
    isPubliclyRoutableUrl,
    _setDnsLookupForTests,
} from "../utils/urlGuard";

describe("isPrivateIp", () => {
    it("loopback, RFC1918, CGNAT, and link-local v4 should be private", () => {
        expect(isPrivateIp("127.0.0.1")).toBe(true);
        expect(isPrivateIp("127.255.255.254")).toBe(true);
        expect(isPrivateIp("10.0.0.5")).toBe(true);
        expect(isPrivateIp("172.16.0.1")).toBe(true);
        expect(isPrivateIp("172.31.255.255")).toBe(true);
        expect(isPrivateIp("192.168.1.1")).toBe(true);
        expect(isPrivateIp("100.64.0.1")).toBe(true);
        expect(isPrivateIp("169.254.169.254")).toBe(true); // cloud metadata
        expect(isPrivateIp("0.0.0.0")).toBe(true);
        expect(isPrivateIp("255.255.255.255")).toBe(true);
    });

    it("ordinary public v4 addresses should not be private", () => {
        expect(isPrivateIp("93.184.216.34")).toBe(false);
        expect(isPrivateIp("8.8.8.8")).toBe(false);
        expect(isPrivateIp("172.32.0.1")).toBe(false); // just past 172.16/12
        expect(isPrivateIp("100.128.0.1")).toBe(false); // just past CGNAT
    });

    it("v6 loopback, unique-local, link-local, and v4-mapped should be private", () => {
        expect(isPrivateIp("::1")).toBe(true);
        expect(isPrivateIp("::")).toBe(true);
        expect(isPrivateIp("fc00::1")).toBe(true);
        expect(isPrivateIp("fd12:3456::1")).toBe(true);
        expect(isPrivateIp("fe80::1")).toBe(true);
        expect(isPrivateIp("::ffff:192.168.0.1")).toBe(true);
        expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
        expect(isPrivateIp("2606:4700::6810:84e5")).toBe(false);
    });

    it("v4-mapped addresses in COMPRESSED-HEX form should be private (the form URL normalization emits)", () => {
        // `new URL("http://[::ffff:127.0.0.1]/").hostname` is `[::ffff:7f00:1]`
        // — a dotted-quad-only matcher never sees the dotted form on the real
        // path, which is exactly the bypass this pins.
        expect(isPrivateIp("::ffff:7f00:1")).toBe(true);      // 127.0.0.1
        expect(isPrivateIp("::ffff:a9fe:a9fe")).toBe(true);   // 169.254.169.254
        expect(isPrivateIp("::ffff:c0a8:1")).toBe(true);      // 192.168.0.1
        expect(isPrivateIp("::ffff:808:808")).toBe(false);    // 8.8.8.8
        expect(isPrivateIp("0:0:0:0:0:ffff:7f00:1")).toBe(true); // uncompressed spelling
    });

    it("NAT64 (64:ff9b::/96) addresses should be judged by their embedded v4", () => {
        expect(isPrivateIp("64:ff9b::a9fe:a9fe")).toBe(true);  // metadata via NAT64
        expect(isPrivateIp("64:ff9b::808:808")).toBe(false);   // 8.8.8.8 via NAT64
    });

    it("unparseable input should fail closed (treated as private)", () => {
        expect(isPrivateIp("not-an-ip")).toBe(true);
        expect(isPrivateIp("")).toBe(true);
    });
});

describe("isBlockedHostname", () => {
    it("localhost and *.localhost/*.local/*.internal should be blocked", () => {
        expect(isBlockedHostname("localhost")).toBe(true);
        expect(isBlockedHostname("LOCALHOST")).toBe(true);
        expect(isBlockedHostname("api.localhost")).toBe(true);
        expect(isBlockedHostname("printer.local")).toBe(true);
        expect(isBlockedHostname("db.internal")).toBe(true);
        expect(isBlockedHostname("localhost.")).toBe(true); // trailing-dot form
    });

    it("public hostnames should not be blocked", () => {
        expect(isBlockedHostname("example.com")).toBe(false);
        expect(isBlockedHostname("internal.example.com")).toBe(false); // 'internal' as a label, not TLD
        expect(isBlockedHostname("localhost.example.com")).toBe(false);
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
