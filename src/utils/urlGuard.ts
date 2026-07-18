/**
 * src/utils/urlGuard.ts
 *
 * SSRF guard for the extension's single outbound fetch site (paste-unfurl,
 * MAR-178). A pasted URL is attacker-influencable input, and the extension
 * host sits on the user's machine — often inside a corporate network — so a
 * fetch it makes on the user's behalf must never be steerable at internal
 * services: localhost admin panels, RFC1918 hosts, cloud metadata endpoints
 * (169.254.169.254), etc. The unfurled title is inserted into the document,
 * which would make any such probe an information leak, not just a request.
 *
 * The guard refuses:
 *  - well-known local hostnames (`localhost`, `*.localhost`, `*.local`,
 *    `*.internal`) without touching DNS;
 *  - IP literals in any private/reserved range (v4 and v6, including
 *    v4-mapped v6);
 *  - hostnames any of whose DNS answers land in those ranges (resolve first,
 *    reject if ANY address is non-routable — a multi-answer record with one
 *    private address is treated as hostile).
 *
 * Known limitation, accepted: the addresses are checked with a lookup that is
 * separate from the one the subsequent fetch performs, so a DNS-rebinding
 * attacker with a sub-second TTL can still race the check. Pinning the
 * connection to the vetted address requires reaching below `fetch` (a custom
 * undici Agent); for a user-initiated, once-per-paste request in a local
 * editor that trade was judged not worth the machinery. The redirect loop in
 * `_fetchUnfurlTitle` re-runs this guard on every hop, so plain
 * redirect-to-internal is covered.
 */

import { isIP } from "node:net";
import { lookup as dnsLookup } from "node:dns/promises";

/** IPv4 helper: the four octets, or null when `ip` is not dotted-quad. */
function v4Octets(ip: string): number[] | null {
    const parts = ip.split(".");
    if (parts.length !== 4) { return null; }
    const nums = parts.map((p) => Number(p));
    return nums.every((n) => Number.isInteger(n) && n >= 0 && n <= 255) ? nums : null;
}

/**
 * True when `ip` (a v4 or v6 literal) is private, loopback, link-local, or
 * otherwise not publicly routable. Unparseable input is treated as private —
 * the guard fails closed.
 */
export function isPrivateIp(ip: string): boolean {
    const v4 = v4Octets(ip);
    if (v4) {
        const [a, b] = v4;
        if (a === 0 || a === 10 || a === 127) { return true; }         // this-net, private, loopback
        if (a === 100 && b >= 64 && b <= 127) { return true; }          // CGNAT 100.64/10
        if (a === 169 && b === 254) { return true; }                    // link-local + cloud metadata
        if (a === 172 && b >= 16 && b <= 31) { return true; }           // private 172.16/12
        if (a === 192 && (b === 0 || b === 168)) { return true; }       // 192.0.0/24+192.0.2/24 doc, private 192.168/16
        if (a === 198 && (b === 18 || b === 19 || b === 51)) { return true; } // benchmarking, doc
        if (a === 203 && b === 0) { return true; }                      // doc 203.0.113/24
        if (a >= 224) { return true; }                                  // multicast + reserved + broadcast
        return false;
    }
    if (isIP(ip) === 6) {
        // Classify from the eight 16-bit words, NOT textual prefixes: the same
        // address has many spellings (`::ffff:127.0.0.1`, `::ffff:7f00:1`,
        // `0:0:0:0:0:ffff:7f00:1`), and WHATWG URL normalization hands this
        // function the compressed-hex canonical form — a dotted-quad regex here
        // is dead code and a guard BYPASS (`http://[::ffff:127.0.0.1]/` reached
        // the wire as `::ffff:7f00:1`).
        const w = v6Words(ip);
        if (!w) { return true; } // fail closed on anything unparseable
        const [w0, w1] = w;
        if (w.every((x) => x === 0)) { return true; }                            // :: unspecified
        if (w.slice(0, 7).every((x) => x === 0) && w[7] === 1) { return true; }  // ::1 loopback
        if ((w0 & 0xfe00) === 0xfc00) { return true; }                           // unique-local fc00::/7
        if ((w0 & 0xffc0) === 0xfe80) { return true; }                           // link-local fe80::/10
        // v4-mapped ::ffff:0:0/96 and NAT64 64:ff9b::/96 — judge the embedded
        // v4: on a dual-stack (or NAT64) host these sockets reach the v4 net.
        if (w.slice(0, 5).every((x) => x === 0) && w[5] === 0xffff) {
            return isPrivateIp(v4FromWords(w[6], w[7]));
        }
        if (w0 === 0x64 && w1 === 0xff9b) {
            return isPrivateIp(v4FromWords(w[6], w[7]));
        }
        return false;
    }
    return true; // not a recognizable IP literal → fail closed
}

/** Dotted-quad string from the low two 16-bit words of an IPv6 address. */
function v4FromWords(hi: number, lo: number): string {
    return `${hi >> 8}.${hi & 0xff}.${lo >> 8}.${lo & 0xff}`;
}

/**
 * The eight 16-bit words of an IPv6 literal (any textual form — compressed,
 * full, or with an embedded dotted-quad tail), or null when it doesn't parse.
 * Callers have already established `isIP(ip) === 6`.
 */
function v6Words(ip: string): number[] | null {
    let s = ip.toLowerCase();
    let tailWords: number[] = [];
    if (s.includes(".")) {
        // Embedded dotted-quad tail (`::ffff:1.2.3.4`) → two trailing words.
        const lastColon = s.lastIndexOf(":");
        const v4 = v4Octets(s.slice(lastColon + 1));
        if (!v4) { return null; }
        tailWords = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]];
        s = s.slice(0, lastColon);
        if (s.endsWith(":")) { s += ":"; } // preserve a `::` that abutted the v4
    }
    const halves = s.split("::");
    if (halves.length > 2) { return null; }
    const parse = (part: string): number[] =>
        part === "" ? [] : part.split(":").map((g) => parseInt(g, 16));
    const head = parse(halves[0]);
    const tail = halves.length === 2 ? parse(halves[1]) : [];
    const given = head.length + tail.length + tailWords.length;
    const fill = halves.length === 2 ? 8 - given : 0;
    if (halves.length === 2 ? fill < 1 : given !== 8) { return null; }
    const words = [...head, ...Array<number>(fill).fill(0), ...tail, ...tailWords];
    return words.length === 8 && words.every((x) => Number.isInteger(x) && x >= 0 && x <= 0xffff)
        ? words
        : null;
}

/** Local-only hostnames refused without a DNS round trip. */
export function isBlockedHostname(hostname: string): boolean {
    const h = hostname.toLowerCase().replace(/\.$/, "");
    return (
        h === "localhost" ||
        h.endsWith(".localhost") ||
        h.endsWith(".local") ||
        h.endsWith(".internal")
    );
}

type LookupFn = (hostname: string) => Promise<{ address: string }[]>;

const realLookup: LookupFn = async (hostname) =>
    dnsLookup(hostname, { all: true, verbatim: true });

let _lookup: LookupFn = realLookup;

/** Test seam: swap the DNS resolver (pass undefined to restore the real one). */
export function _setDnsLookupForTests(fn: LookupFn | undefined): void {
    _lookup = fn ?? realLookup;
}

/**
 * True when `url`'s host is safe to fetch: not a blocked local name, not a
 * private IP literal, and (for hostnames) every DNS answer publicly routable.
 * DNS failure → false (fail closed; the caller shows the plain link, which is
 * also what an unreachable host would produce).
 */
export async function isPubliclyRoutableUrl(url: URL): Promise<boolean> {
    if (isBlockedHostname(url.hostname)) { return false; }
    const host = url.hostname.replace(/^\[|\]$/g, ""); // URL brackets v6 literals
    if (isIP(host)) { return !isPrivateIp(host); }
    try {
        const addresses = await _lookup(host);
        return addresses.length > 0 && addresses.every((a) => !isPrivateIp(a.address));
    } catch {
        return false;
    }
}
