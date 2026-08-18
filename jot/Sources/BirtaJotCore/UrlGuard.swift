import Foundation

/// The SSRF guard for Jot's outbound fetches, and the Swift half of a check
/// that exists twice.
///
/// `src/utils/urlGuard.ts` is the other half, for the extension. Neither can
/// import the other, so the CASES live in `shared/__fixtures__/urlGuardCases.json`
/// and both test suites read them; a rule one implementation enforces and the
/// other does not is then a failing test rather than a difference nobody
/// noticed. Add a case there.
///
/// What it refuses, and why a link card needs refusing at all: a URL in a
/// document is attacker-influencable input, and this process runs on the
/// user's machine, often inside a network with things on it that answer to
/// nobody outside. A fetch made on the user's behalf must not be steerable at
/// a localhost admin page or at 169.254.169.254.
///
///  - local names (`localhost`, `*.localhost`, `*.local`, `*.internal`),
///    without touching DNS;
///  - IP literals in any private or reserved range, v4 and v6, including the
///    v4-mapped and NAT64 spellings of a v4 address;
///  - hostnames where ANY DNS answer lands in those ranges, since one private
///    answer in a multi-answer record is enough to be aimed inward.
///
/// Known limitation, the same one the TypeScript carries: the addresses
/// checked are not the connection's own, so a DNS rebind with a very short TTL
/// can still race it. Pinning the socket to a vetted address needs a custom
/// URLSession transport, and for a render-only fetch of a page the user is
/// already looking at, that machinery costs more than it buys. Every redirect
/// hop is re-checked, so redirect-to-internal, which is the reachable version
/// of this, is covered.
public enum UrlGuard {
    /// True when `ip` is private, loopback, link-local or otherwise not
    /// publicly routable. Anything unparseable is private: the guard fails
    /// closed.
    public static func isPrivateIP(_ ip: String) -> Bool {
        if let v4 = v4Octets(ip) { return isPrivateV4(v4) }
        if let words = v6Words(ip) { return isPrivateV6(words) }
        return true
    }

    /// Local-only hostnames, refused without a DNS round trip.
    public static func isBlockedHostname(_ hostname: String) -> Bool {
        var h = hostname.lowercased()
        if h.hasSuffix(".") { h.removeLast() }
        return h == "localhost"
            || h.hasSuffix(".localhost")
            || h.hasSuffix(".local")
            || h.hasSuffix(".internal")
    }

    /// Whether `url` may be fetched: an http(s) URL whose host is not a
    /// blocked name, not a private literal, and (for a name) resolves only to
    /// publicly routable addresses.
    ///
    /// `resolve` is injectable so the rules can be tested without a network,
    /// and so a test can prove DNS is NOT consulted for a literal.
    public static func isPubliclyRoutable(
        _ url: URL,
        resolve: (String) -> [String] = UrlGuard.systemResolve
    ) -> Bool {
        guard let scheme = url.scheme?.lowercased(), scheme == "http" || scheme == "https" else {
            return false
        }
        guard var host = url.host, !host.isEmpty else { return false }
        // URL keeps the brackets on a v6 literal in some spellings.
        if host.hasPrefix("["), host.hasSuffix("]") { host = String(host.dropFirst().dropLast()) }
        if isBlockedHostname(host) { return false }
        if isIPLiteral(host) { return !isPrivateIP(host) }
        let addresses = resolve(host)
        return !addresses.isEmpty && addresses.allSatisfy { !isPrivateIP($0) }
    }

    /// Whether `host` is an IP literal rather than a name.
    public static func isIPLiteral(_ host: String) -> Bool {
        v4Octets(host) != nil || v6Words(host) != nil
    }

    /// Every address `host` resolves to, or none when it does not resolve.
    /// Failing to resolve yields an empty list, which `isPubliclyRoutable`
    /// reads as "refuse": an unreachable host and a hostile one both end with
    /// the user seeing the plain link.
    public static func systemResolve(_ host: String) -> [String] {
        var hints = addrinfo(ai_flags: 0, ai_family: AF_UNSPEC, ai_socktype: SOCK_STREAM,
                             ai_protocol: 0, ai_addrlen: 0, ai_canonname: nil, ai_addr: nil, ai_next: nil)
        var result: UnsafeMutablePointer<addrinfo>?
        guard getaddrinfo(host, nil, &hints, &result) == 0, let head = result else { return [] }
        defer { freeaddrinfo(head) }
        var out: [String] = []
        var node: UnsafeMutablePointer<addrinfo>? = head
        while let current = node {
            var buffer = [CChar](repeating: 0, count: Int(NI_MAXHOST))
            if getnameinfo(current.pointee.ai_addr, current.pointee.ai_addrlen,
                           &buffer, socklen_t(buffer.count), nil, 0, NI_NUMERICHOST) == 0 {
                let address = String(cString: buffer)
                // A link-local v6 answer carries a %interface scope; the
                // classifier wants the address alone.
                out.append(address.split(separator: "%").first.map(String.init) ?? address)
            }
            node = current.pointee.ai_next
        }
        return out
    }

    // MARK: v4

    /// The four octets of a dotted-quad, or nil when `ip` is not one.
    static func v4Octets(_ ip: String) -> [Int]? {
        let parts = ip.split(separator: ".", omittingEmptySubsequences: false)
        guard parts.count == 4 else { return nil }
        var octets: [Int] = []
        for part in parts {
            // `Int("+1")` and `Int(" 1")` both parse; a dotted-quad octet is
            // digits and nothing else.
            guard !part.isEmpty, part.allSatisfy(\.isNumber), let n = Int(part), n >= 0, n <= 255 else {
                return nil
            }
            octets.append(n)
        }
        return octets
    }

    static func isPrivateV4(_ o: [Int]) -> Bool {
        let (a, b) = (o[0], o[1])
        if a == 0 || a == 10 || a == 127 { return true }           // this-net, private, loopback
        if a == 100 && b >= 64 && b <= 127 { return true }         // CGNAT 100.64/10
        if a == 169 && b == 254 { return true }                    // link-local, cloud metadata
        if a == 172 && b >= 16 && b <= 31 { return true }          // private 172.16/12
        if a == 192 && (b == 0 || b == 168) { return true }        // 192.0.0/24, 192.0.2/24, private
        if a == 198 && (b == 18 || b == 19 || b == 51) { return true } // benchmarking, documentation
        if a == 203 && b == 0 { return true }                      // documentation 203.0.113/24
        if a >= 224 { return true }                                // multicast, reserved, broadcast
        return false
    }

    // MARK: v6

    static func isPrivateV6(_ w: [Int]) -> Bool {
        if w.allSatisfy({ $0 == 0 }) { return true }                          // ::
        if w[0..<7].allSatisfy({ $0 == 0 }) && w[7] == 1 { return true }      // ::1
        if (w[0] & 0xfe00) == 0xfc00 { return true }                          // fc00::/7
        if (w[0] & 0xffc0) == 0xfe80 { return true }                          // fe80::/10
        // v4-mapped (::ffff:0:0/96) and NAT64 (64:ff9b::/96): on a dual-stack
        // or NAT64 host these reach the v4 network, so judge the v4 inside.
        if w[0..<5].allSatisfy({ $0 == 0 }) && w[5] == 0xffff {
            return isPrivateV4(v4From(w[6], w[7]))
        }
        if w[0] == 0x64 && w[1] == 0xff9b {
            return isPrivateV4(v4From(w[6], w[7]))
        }
        return false
    }

    static func v4From(_ hi: Int, _ lo: Int) -> [Int] {
        [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff]
    }

    /// The eight 16-bit words of an IPv6 literal in any textual form, or nil
    /// when it does not parse. Classifying from the words rather than from the
    /// text is what makes the many spellings of one address (`::ffff:127.0.0.1`,
    /// `::ffff:7f00:1`, `0:0:0:0:0:ffff:7f00:1`) answer alike; a prefix regex
    /// over the text is a guard bypass waiting to be found.
    static func v6Words(_ ip: String) -> [Int]? {
        var s = ip.lowercased()
        guard s.contains(":") else { return nil }
        var tail: [Int] = []
        if s.contains(".") {
            guard let lastColon = s.lastIndex(of: ":") else { return nil }
            let dotted = String(s[s.index(after: lastColon)...])
            guard let v4 = v4Octets(dotted) else { return nil }
            tail = [(v4[0] << 8) | v4[1], (v4[2] << 8) | v4[3]]
            s = String(s[s.startIndex..<lastColon])
            if s.hasSuffix(":") { s += ":" } // keep a `::` that abutted the v4
        }
        let halves = s.components(separatedBy: "::")
        guard halves.count <= 2 else { return nil }
        func parse(_ part: String) -> [Int]? {
            if part.isEmpty { return [] }
            var out: [Int] = []
            for group in part.split(separator: ":", omittingEmptySubsequences: false) {
                guard !group.isEmpty, group.count <= 4,
                      group.allSatisfy({ $0.isHexDigit }),
                      let n = Int(group, radix: 16) else { return nil }
                out.append(n)
            }
            return out
        }
        guard let head = parse(halves[0]) else { return nil }
        let rest = halves.count == 2 ? parse(halves[1]) : []
        guard let rest else { return nil }
        let given = head.count + rest.count + tail.count
        let fill = halves.count == 2 ? 8 - given : 0
        if halves.count == 2 { guard fill >= 1 else { return nil } } else { guard given == 8 else { return nil } }
        let words = head + Array(repeating: 0, count: fill) + rest + tail
        guard words.count == 8, words.allSatisfy({ $0 >= 0 && $0 <= 0xffff }) else { return nil }
        return words
    }
}
