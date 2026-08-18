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
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"uploadImage","id":"u1","data":null,"mimeType":"image/png","altText":""}"#), .uploadImage(id: "u1"))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"viewState","state":{"scrollY":12}}"#), .viewState(json: #"{"scrollY":12}"#))
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
        XCTAssertEqual((i18n["hostCapabilities"] as? [String]) ?? ["x"], [])
        XCTAssertEqual((i18n["toolbar"] as? [String: Any])?["placements"] as? [String: String], ["bold": "hidden"])

        let script = cfg.userScript(themeClass: "vscode-dark")
        XCTAssertTrue(script.contains(#"window.__i18n = {"#))
        XCTAssertTrue(script.contains(#""hostCapabilities":[]"#))
        XCTAssertTrue(script.contains(#"var state = {"scrollY":1};"#))
        XCTAssertTrue(script.contains(#"document.body.classList.add("vscode-dark")"#))
        XCTAssertFalse(script.contains("documentElement"), "one theme class, on body, the one the bridge reads")
        XCTAssertTrue(script.contains("window.acquireVsCodeApi = function"))
        XCTAssertTrue(script.contains("webkit.messageHandlers.birta.postMessage(JSON.stringify(m, replacer))"))
        XCTAssertFalse(script.contains("<"), "script text is inline-safe")
    }

    func testNetworkOptInEnablesEmbedsAndNotTheHostFetchedFeatures() {
        let on = BootConfig(networkEnabled: true).i18nObject()
        XCTAssertEqual(on["network"] as? Bool, true)
        XCTAssertEqual(on["embedsEnabled"] as? Bool, true)
        // Link cards and unfurl are answered by the host, which Jot does not do yet.
        XCTAssertEqual(on["linkCardsEnabled"] as? Bool, false)
        XCTAssertEqual(on["pasteUnfurl"] as? Bool, false)
        XCTAssertEqual(HostMessage.editorCommand("openFind").jsonString(), #"{"command":"openFind","type":"editorCommand"}"#)
    }
}
