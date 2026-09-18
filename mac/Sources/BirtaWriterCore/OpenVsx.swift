import Foundation

/// A theme extension as the Open VSX registry lists it, for the browser
/// in the Appearance pane.
///
/// Open VSX (open-vsx.org, the Eclipse Foundation's registry) rather than
/// the Visual Studio Marketplace, whose terms allow only Microsoft's own
/// products to query it; the popular themes are published to both, this
/// project publishes the extension to both, and Open VSX has a documented
/// public API with a VSIX to download per result. `ThemeStore` reads that
/// VSIX exactly as it reads one chosen from disk.
public struct OpenVsxTheme: Equatable, Sendable, Identifiable {
    public var id: String { "\(namespace).\(name)" }
    public let namespace: String
    public let name: String
    public let displayName: String
    public let version: String
    public let downloads: Int
    public let rating: Double?
    public let download: URL

    public init(namespace: String, name: String, displayName: String, version: String,
                downloads: Int, rating: Double?, download: URL) {
        self.namespace = namespace
        self.name = name
        self.displayName = displayName
        self.version = version
        self.downloads = downloads
        self.rating = rating
        self.download = download
    }
}

public enum OpenVsx {
    /// The one host every request goes to.
    public static let host = "open-vsx.org"

    /// The search, over theme extensions alone, most downloaded first. An
    /// empty query is the registry's own first page: the most downloaded of
    /// the category, which is what the browser opens onto.
    public static func searchURL(query: String, size: Int = 30) -> URL {
        var components = URLComponents()
        components.scheme = "https"
        components.host = host
        components.path = "/api/-/search"
        components.queryItems = (query.isEmpty ? [] : [URLQueryItem(name: "query", value: query)]) + [
            URLQueryItem(name: "category", value: "Themes"),
            URLQueryItem(name: "size", value: String(size)),
            URLQueryItem(name: "sortBy", value: "downloadCount"),
            URLQueryItem(name: "sortOrder", value: "desc"),
        ]
        return components.url!
    }

    /// The results in a search response, in the registry's order. An
    /// entry with no VSIX to download, or one not on the registry's own
    /// host, is left out: the download is fetched without further
    /// checking, so the URL has to come from where the listing did.
    public static func parse(_ data: Data) throws -> [OpenVsxTheme] {
        guard let object = try JSONSerialization.jsonObject(with: data) as? [String: Any],
              let extensions = object["extensions"] as? [[String: Any]] else {
            throw NSError(domain: "OpenVsx", code: 1,
                          userInfo: [NSLocalizedDescriptionKey: "The registry's answer was not a search result."])
        }
        return extensions.compactMap { entry in
            guard let namespace = entry["namespace"] as? String, let name = entry["name"] as? String,
                  let version = entry["version"] as? String,
                  let files = entry["files"] as? [String: Any],
                  let downloadString = files["download"] as? String,
                  let download = URL(string: downloadString),
                  download.scheme == "https", download.host == host else { return nil }
            return OpenVsxTheme(
                namespace: namespace, name: name,
                displayName: (entry["displayName"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? name,
                version: version,
                downloads: entry["downloadCount"] as? Int ?? 0,
                rating: entry["averageRating"] as? Double,
                download: download)
        }
    }

    /// The one rule over the package's redirect: it stays on https. The
    /// registry hands the file off to a host of its own, which is the
    /// registry's to choose; a hop down to http would carry the package in
    /// the clear, and a hop to nowhere is refused the same way.
    public static func redirect(_ request: URLRequest) -> URLRequest? {
        request.url?.scheme == "https" ? request : nil
    }

    /// A download count as the browser prints it.
    public static func downloadsLabel(_ count: Int) -> String {
        switch count {
        case ..<1_000: return "\(count)"
        case ..<1_000_000: return String(format: "%.1fK", Double(count) / 1_000).replacingOccurrences(of: ".0K", with: "K")
        default: return String(format: "%.1fM", Double(count) / 1_000_000).replacingOccurrences(of: ".0M", with: "M")
        }
    }
}
