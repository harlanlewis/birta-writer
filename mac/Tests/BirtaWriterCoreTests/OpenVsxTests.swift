import XCTest
@testable import BirtaWriterCore

/// The registry client: what a search asks, and what an answer becomes.
final class OpenVsxTests: XCTestCase {
    /// The shape open-vsx.org answered a real search with, cut to two
    /// results and the fields read here, plus one entry the parse must
    /// refuse (a download off the registry's host).
    private let answer = Data("""
    { "offset": 0, "totalSize": 3, "extensions": [
      { "averageRating": 5.0, "description": "The official Dracula Theme.", "displayName": "Dracula Theme Official",
        "downloadCount": 417260, "name": "theme-dracula", "namespace": "dracula-theme", "version": "2.25.1",
        "files": { "download": "https://open-vsx.org/api/dracula-theme/theme-dracula/2.25.1/file/dracula-theme.theme-dracula-2.25.1.vsix",
                   "icon": "https://open-vsx.org/api/dracula-theme/theme-dracula/2.25.1/file/icon.png" } },
      { "displayName": "", "downloadCount": 85454, "name": "dracula-2", "namespace": "Dracula-2", "version": "0.3.8",
        "files": { "download": "https://open-vsx.org/api/Dracula-2/dracula-2/0.3.8/file/Dracula-2.dracula-2-0.3.8.vsix" } },
      { "displayName": "Elsewhere", "downloadCount": 1, "name": "x", "namespace": "y", "version": "1",
        "files": { "download": "https://example.com/x.vsix" } }
    ] }
    """.utf8)

    func testTheSearchShouldAskForThemesAloneMostDownloadedFirst() {
        let url = OpenVsx.searchURL(query: "one dark")
        XCTAssertEqual(url.host, "open-vsx.org")
        XCTAssertEqual(url.path, "/api/-/search")
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertEqual(items.first { $0.name == "query" }?.value, "one dark")
        XCTAssertEqual(items.first { $0.name == "category" }?.value, "Themes")
        XCTAssertEqual(items.first { $0.name == "sortBy" }?.value, "downloadCount")
    }

    func testAnEmptyQueryShouldAskForTheCategorysFirstPageRatherThanForNothing() {
        // What the browser opens onto. The registry treats an absent query
        // as "everything in the category"; an empty one is sent as nothing.
        let url = OpenVsx.searchURL(query: "")
        let items = URLComponents(url: url, resolvingAgainstBaseURL: false)!.queryItems!
        XCTAssertNil(items.first { $0.name == "query" })
        XCTAssertEqual(items.first { $0.name == "category" }?.value, "Themes")
        XCTAssertEqual(items.first { $0.name == "sortBy" }?.value, "downloadCount")
    }

    func testAnAnswerShouldBecomeThemesWithTheirVSIXAndRefuseADownloadOffTheRegistry() throws {
        let themes = try OpenVsx.parse(answer)
        XCTAssertEqual(themes.map(\.id), ["dracula-theme.theme-dracula", "Dracula-2.dracula-2"])
        XCTAssertEqual(themes[0].displayName, "Dracula Theme Official")
        XCTAssertEqual(themes[0].downloads, 417260)
        XCTAssertEqual(themes[0].rating, 5.0)
        XCTAssertEqual(themes[0].download.lastPathComponent, "dracula-theme.theme-dracula-2.25.1.vsix")
        XCTAssertEqual(themes[1].displayName, "dracula-2", "an empty display name falls back to the name")
        XCTAssertNil(themes[1].rating)
    }

    func testSomethingThatIsNotASearchResultShouldThrow() {
        XCTAssertThrowsError(try OpenVsx.parse(Data("[1, 2]".utf8)))
        XCTAssertThrowsError(try OpenVsx.parse(Data("not json".utf8)))
    }

    func testAPackageRedirectShouldStayOnHttpsAndNothingElse() {
        XCTAssertNotNil(OpenVsx.redirect(URLRequest(url: URL(string: "https://openvsx.eclipsecontent.org/x.vsix")!)),
                        "the registry's own file host, over https")
        XCTAssertNil(OpenVsx.redirect(URLRequest(url: URL(string: "http://openvsx.eclipsecontent.org/x.vsix")!)),
                     "a hop down to http is refused")
        XCTAssertNil(OpenVsx.redirect(URLRequest(url: URL(string: "ftp://example.com/x.vsix")!)))
    }

    func testDownloadsShouldBePrintedShort() {
        XCTAssertEqual(OpenVsx.downloadsLabel(950), "950")
        XCTAssertEqual(OpenVsx.downloadsLabel(85_454), "85.5K")
        XCTAssertEqual(OpenVsx.downloadsLabel(1_000), "1K")
        XCTAssertEqual(OpenVsx.downloadsLabel(3_200_000), "3.2M")
    }
}
