import XCTest
@testable import BirtaJotCore

final class BridgeTests: XCTestCase {
    func testParsesTheMessagesTheShellActsOn() {
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"ready"}"#), .ready)
        XCTAssertEqual(WebviewMessage.parse(##"{"type":"update","content":"# a","baseSyncVersion":0,"seq":3}"##),
                       .update(content: "# a", baseSyncVersion: 0, seq: 3))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"flushResult","id":"f1","content":"x","baseSyncVersion":1,"seq":4}"#),
                       .flushResult(id: "f1", content: "x", baseSyncVersion: 1, seq: 4))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"openUrl","url":"https://a.b"}"#), .openUrl("https://a.b"))
        // The wire name the page actually posts (`notifyAgentCancel`). The
        // parse table used to say `stopAgentRun`, which nothing sends, so a
        // click on the gutter marker reached `.other` and cancelled nothing.
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"agentCancel","requestId":"r1"}"#),
                       .agentCancel(requestId: "r1"))
        // The old spelling must not quietly work again.
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"stopAgentRun","requestId":"r1"}"#),
                       .other(type: "stopAgentRun"))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"clipboardWrite","format":"markdown","data":"**b**"}"#),
                       .clipboardWrite(format: "markdown", data: "**b**"))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"setToolbarLayout","item":{"id":"bold","placement":"hidden"},"order":["italic","bold"]}"#),
                       .setToolbarLayout(itemId: "bold", placement: "hidden", order: ["italic", "bold"]))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"setToolbarLayout","order":[]}"#),
                       .setToolbarLayout(itemId: nil, placement: nil, order: []))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"setToolbarVisible","visible":false}"#), .setToolbarVisible(false))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"setFontPreset","preset":"serif"}"#), .setFontPreset("serif"))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"setFontSize","size":110}"#), .setFontSize(110))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"setContentWidth","mode":"fixed"}"#), .setContentWidth("fixed"))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"focusState","focused":true}"#), .focusState(true))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"crash","message":"boom","source":"error"}"#), .crash(message: "boom", source: "error"))
        // "hi" as base64, in the `$bytes` wrapper the page-side shim writes.
        XCTAssertEqual(
            WebviewMessage.parse(#"{"type":"uploadImage","id":"u1","data":{"$bytes":"aGk="},"mimeType":"image/png","altText":"a shot"}"#),
            .uploadImage(id: "u1", data: Data("hi".utf8), mimeType: "image/png", altText: "a shot"))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"viewState","state":{"scrollY":12}}"#), .viewState(json: #"{"scrollY":12}"#))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"copyAgentReference"}"#), .copyAgentReference)
    }

    /// This list is hand-written, and by AGENTS.md's own rule that is a list a
    /// new case never joins. It is how `copyAgentReference` sat unparsed while
    /// a live button posted it: unhandled messages fall to `.other`, which is
    /// traced and dropped, so a dead control and a message the host correctly
    /// never offers look exactly alike from here.
    ///
    /// The durable form is a guard that derives both sides: every outbound type
    /// in `shared/messages.ts` is either parsed here, or posted only by
    /// something Jot never offers, with a named allow-list for the third case.
    /// That is a bigger piece of work than this file and is not built.

    func testAnEditorContextReplyCarriesThePrimarySelection() {
        let json = #"""
        {"type":"editorContextResult","id":"c1","context":{"selections":[
          {"anchor":{"line":3,"column":0},"active":{"line":5,"column":4},"text":"x"}],
          "primary":0,"isEmpty":false}}
        """#
        XCTAssertEqual(
            WebviewMessage.parse(json),
            .editorContextResult(id: "c1", selection: .init(
                anchor: .init(line: 3, column: 0),
                active: .init(line: 5, column: 4),
                isEmpty: false)))
    }

    func testAnEditorContextReplyWithNoContextIsAnAnswerRatherThanAFailureToParse() {
        // The page answers with null when it cannot place the selection, and
        // the reply still has to arrive: the caller is holding a closure for
        // this id, and dropping it as `.other` would leave it pending until
        // the timeout, reporting the wrong reason.
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"editorContextResult","id":"c1","context":null}"#),
                       .editorContextResult(id: "c1", selection: nil))
    }

    func testAnEditorContextReplyReadsThePrimaryIndexRatherThanTheFirstEntry() {
        let json = #"""
        {"type":"editorContextResult","id":"c1","context":{"selections":[
          {"anchor":{"line":1,"column":0},"active":{"line":1,"column":0},"text":""},
          {"anchor":{"line":9,"column":2},"active":{"line":9,"column":7},"text":"y"}],
          "primary":1,"isEmpty":false}}
        """#
        XCTAssertEqual(
            WebviewMessage.parse(json),
            .editorContextResult(id: "c1", selection: .init(
                anchor: .init(line: 9, column: 2),
                active: .init(line: 9, column: 7),
                isEmpty: false)))
    }

    func testAContextRequestNamesTheIdItWillBeAnsweredWith() {
        let object = HostMessage.requestEditorContext(id: "c1").jsonObject()
        XCTAssertEqual(object["type"] as? String, "requestEditorContext")
        XCTAssertEqual(object["id"] as? String, "c1")
    }

    func testAnUploadWithNoBytesIsNotAnUpload() {
        // The old shim posted `null` in place of the typed array, so an upload
        // arrived with nothing in it. Reading that as an upload of zero bytes
        // would write an empty file and report success; it has to be the case
        // the shell answers with an error instead.
        for payload in [#"null"#, #""""#, #"{"$bytes":""}"#, #"{"$bytes":"!!!not base64"}"#, #"[1,2,3]"#] {
            XCTAssertEqual(
                WebviewMessage.parse(#"{"type":"uploadImage","id":"u1","data":\#(payload),"mimeType":"image/png"}"#),
                .other(type: "uploadImage"),
                "payload \(payload) must not read as an upload")
        }
    }

    func testTheShimEncodesBytesRatherThanDroppingThem() {
        // The script is the other half of BinaryPayload, and it is text here
        // rather than behaviour, so this pins the contract it implements: the
        // wrapper key, and that a typed array is encoded rather than nulled.
        let script = BootConfig().userScript(themeClass: "vscode-light")

        XCTAssertTrue(script.contains("\"\(BinaryPayload.key)\""), script)
        XCTAssertTrue(script.contains("btoa"))
        XCTAssertTrue(script.contains("ArrayBuffer.isView"))
        XCTAssertFalse(script.contains("return null"), "a typed array must not be dropped any more")
    }

    func testUnknownAndMalformedAreNeverFatal() {
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"wordCount","doc":{}}"#), .other(type: "wordCount"))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"update","content":"x"}"#), .other(type: "update"))
        XCTAssertNil(WebviewMessage.parse("not json"))
        XCTAssertNil(WebviewMessage.parse(#"{"noType":1}"#))
    }

    func testHostMessagesEncodeTheSharedShapes() {
        XCTAssertEqual(HostMessage.initDoc(content: "# a", syncVersion: 0, viewStateJSON: #"{"scrollY":3}"#).jsonString(),
                       ##"{"content":"# a","syncVersion":0,"type":"init","viewState":{"scrollY":3}}"##)
        XCTAssertEqual(HostMessage.initDoc(content: "", syncVersion: 0, viewStateJSON: "garbage").jsonString(),
                       #"{"content":"","syncVersion":0,"type":"init"}"#)
        XCTAssertEqual(HostMessage.externalUpdate(content: "", syncVersion: 2).jsonString(),
                       #"{"content":"","syncVersion":2,"type":"externalUpdate"}"#)
        XCTAssertEqual(HostMessage.flushSave(id: "f").jsonString(), #"{"id":"f","type":"flushSave"}"#)
        XCTAssertEqual(HostMessage.flushAck(id: "f", applied: true).jsonString(), #"{"applied":true,"id":"f","type":"flushAck"}"#)
        XCTAssertEqual(HostMessage.imageUploadError(id: "u", error: "no").jsonString(),
                       #"{"error":"no","id":"u","type":"imageUploadError"}"#)
        XCTAssertEqual(HostMessage.toolbarConfig(json: #"{"placements":{"bold":"hidden"},"order":[],"visible":true}"#).jsonString(),
                       #"{"config":{"order":[],"placements":{"bold":"hidden"},"visible":true},"type":"toolbarConfig"}"#)
    }

    func testToolbarLayoutFoldsMessagesAndRoundTrips() {
        var l = ToolbarLayout()
        l.apply(itemId: "bold", placement: "hidden", order: ["italic"])
        l.apply(itemId: nil, placement: nil, order: ["italic", "link"])
        XCTAssertEqual(l.placements, ["bold": "hidden"])
        XCTAssertEqual(l.order, ["italic", "link"])
        XCTAssertEqual(ToolbarLayout.fromJSON(l.json), l)
        XCTAssertEqual(ToolbarLayout.fromJSON(nil), ToolbarLayout())
        XCTAssertEqual(ToolbarLayout.fromJSON("{bad"), ToolbarLayout())
    }

    func testBootConfigCarriesJotDecisionsAndTheShim() {
        let cfg = BootConfig(toolbarJSON: #"{"placements":{"bold":"hidden"},"order":[],"visible":true}"#,
                             networkEnabled: false, hostCapabilities: [], viewStateJSON: #"{"scrollY":1}"#)
        let i18n = cfg.i18nObject()
        XCTAssertEqual(i18n["isMac"] as? Bool, true)
        XCTAssertEqual(i18n["network"] as? Bool, false)
        XCTAssertEqual(i18n["embedsEnabled"] as? Bool, false)
        XCTAssertEqual(i18n["calcEnabled"] as? Bool, true)
        XCTAssertEqual(i18n["tocVisibility"] as? String, "hidden")
        XCTAssertEqual((i18n["proofread"] as? [String: Bool])?["proofreadingEnabled"], false)
        // The host's own facts live under one key, not scattered among the
        // user's settings beside them (shared/hostProfile.ts).
        let host = i18n["host"] as? [String: Any]
        XCTAssertEqual((host?["capabilities"] as? [String]) ?? ["x"], [])
        // Spelled out rather than derived, and it has to stay that way: this is
        // the check that a NEW arrangement was declared here deliberately, so a
        // list built from the thing under test would agree with any change at
        // all. The cost is that adding one means editing this line, which is
        // the point of it: every arrangement Jot has gained has gone red here
        // first, in a commit that added it to the bridge and ran no Swift.
        XCTAssertEqual(host?["arrangements"] as? [String],
                       ["typographyInGearMenu", "formattingInSecondRow", "fixedToolbarLayout",
                        "barMenusOnClick", "nativeFindBar", "nativeDatePicker"])
        XCTAssertNotNil(host?["shortcuts"] as? [[String: String]])
        XCTAssertEqual((i18n["toolbar"] as? [String: Any])?["placements"] as? [String: String], ["bold": "hidden"])

        let script = cfg.userScript(themeClass: "vscode-dark")
        XCTAssertTrue(script.contains(#"window.__i18n = {"#))
        XCTAssertTrue(script.contains(#""capabilities":[]"#))
        XCTAssertTrue(script.contains(#"var state = {"scrollY":1};"#))
        XCTAssertTrue(script.contains(#"document.body.classList.add("vscode-dark")"#))
        XCTAssertFalse(script.contains("documentElement"), "one theme class, on body, the one the bridge reads")
        XCTAssertTrue(script.contains("window.acquireVsCodeApi = function"))
        XCTAssertTrue(script.contains("webkit.messageHandlers.birta.postMessage(JSON.stringify(m, replacer))"))
        XCTAssertFalse(script.contains("<"), "script text is inline-safe")
    }

    func testEveryNetworkFeatureRidesTheOneSwitch() {
        let on = BootConfig(networkEnabled: true).i18nObject()
        XCTAssertEqual(on["network"] as? Bool, true)
        XCTAssertEqual(on["embedsEnabled"] as? Bool, true)
        XCTAssertEqual(on["linkCardsEnabled"] as? Bool, true)
        XCTAssertEqual(on["pasteUnfurl"] as? Bool, true)
        XCTAssertEqual(HostMessage.editorCommand("openFind").jsonString(), #"{"command":"openFind","type":"editorCommand"}"#)
    }

    func testEveryNetworkFeatureIsOffByDefault() {
        // The default matters more than the opt-in: with the switch untouched,
        // nothing here may put a request on the wire.
        let off = BootConfig().i18nObject()
        for key in ["network", "embedsEnabled", "linkCardsEnabled", "pasteUnfurl"] {
            XCTAssertEqual(off[key] as? Bool, false, key)
        }
    }

    func testAutoApplyIsNotDeclaredSoAFetchedTitleStaysAnOffer() {
        // Absent means the page's own default, which is false. Stating it true
        // here would make a fetched title rewrite the document by itself, and
        // that is the line between rung 1 and something that writes.
        XCTAssertNil(BootConfig(networkEnabled: true).i18nObject()["pasteUnfurlAutoApply"])
    }

    func testLinkDataRepliesCarryNullRatherThanEmptyFields() {
        XCTAssertEqual(HostMessage.linkCardResult(id: "c1", url: "https://a.b", title: nil, description: nil).jsonString(),
                       #"{"card":null,"id":"c1","type":"linkCardResult","url":"https:\/\/a.b"}"#)
        XCTAssertEqual(HostMessage.linkCardResult(id: "c1", url: "https://a.b", title: "T", description: nil).jsonString(),
                       #"{"card":{"description":null,"title":"T"},"id":"c1","type":"linkCardResult","url":"https:\/\/a.b"}"#)
        XCTAssertEqual(HostMessage.unfurlResult(id: "u1", url: "https://a.b", title: nil).jsonString(),
                       #"{"id":"u1","title":null,"type":"unfurlResult","url":"https:\/\/a.b"}"#)
        XCTAssertEqual(HostMessage.embedMetaResult(id: "e1", url: "https://a.b", title: nil).jsonString(),
                       #"{"id":"e1","title":null,"type":"embedMetaResult","url":"https:\/\/a.b"}"#)
    }

    func testTheLinkDataRequestsParse() {
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"resolveLinkCard","id":"c1","url":"https://a.b"}"#),
                       .resolveLinkCard(id: "c1", url: "https://a.b"))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"unfurlUrl","id":"u1","url":"https://a.b"}"#),
                       .unfurlUrl(id: "u1", url: "https://a.b"))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"resolveEmbedMeta","id":"e1","url":"https://a.b"}"#),
                       .resolveEmbedMeta(id: "e1", url: "https://a.b"))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"unfurlUrl","id":"u1"}"#), .other(type: "unfurlUrl"))
    }
}
