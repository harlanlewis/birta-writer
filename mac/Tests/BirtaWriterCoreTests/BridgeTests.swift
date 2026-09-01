import XCTest
@testable import BirtaWriterCore

final class BridgeTests: XCTestCase {
    func testParsesTheMessagesTheShellActsOn() {
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"ready"}"#), .ready)
        XCTAssertEqual(WebviewMessage.parse(##"{"type":"update","content":"# a","baseSyncVersion":0,"seq":3}"##),
                       .update(content: "# a", baseSyncVersion: 0, seq: 3))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"flushResult","id":"f1","content":"x","baseSyncVersion":1,"seq":4}"#),
                       .flushResult(id: "f1", content: "x", baseSyncVersion: 1, seq: 4))
        // The frontmatter panel's own edit. It carries no seq, which is why it
        // needs a case of its own rather than riding `update`: it rewrites the
        // block and nothing else, and the body it does not name must survive.
        XCTAssertEqual(WebviewMessage.parse(##"{"type":"frontmatterUpdate","frontmatter":"---\ntitle: A\n---\n","baseSyncVersion":2}"##),
                       .frontmatterUpdate(frontmatter: "---\ntitle: A\n---\n", baseSyncVersion: 2))
        // Clearing the panel is a real edit, not an absent field: it is how the
        // block is deleted, so an empty string must parse rather than fall to
        // `.other` and leave the file with metadata the panel no longer shows.
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"frontmatterUpdate","frontmatter":"","baseSyncVersion":0}"#),
                       .frontmatterUpdate(frontmatter: "", baseSyncVersion: 0))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"openUrl","url":"https://a.b"}"#), .openUrl("https://a.b"))
        // The host-prompt seam (MAR-395). A step that parses arrives whole.
        XCTAssertEqual(
            WebviewMessage.parse(#"{"type":"hostPrompt","id":"p1","step":{"kind":"input","title":"t","prompt":"q"}}"#),
            .hostPrompt(id: "p1", step: .input(title: "t", prompt: "q", placeholder: nil,
                                               required: nil, maxLength: nil)))
        // A step this build cannot draw is STILL a request, carried with a nil
        // step so the coordinator can answer `unsupported`. Filing it under
        // `.other` would drop it silently, and the page would then wait out
        // its whole timeout for a question nobody was ever asked.
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"hostPrompt","id":"p2","step":{"kind":"colourWheel","title":"t"}}"#),
                       .hostPrompt(id: "p2", step: nil))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"hostPrompt","id":"p3"}"#),
                       .hostPrompt(id: "p3", step: nil))
        // No id means no way to answer, so it is not a request at all.
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"hostPrompt","step":{"kind":"input","title":"t","prompt":"q"}}"#),
                       .other(type: "hostPrompt"))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"requestHostDiagnostics","id":"d1"}"#),
                       .requestHostDiagnostics(id: "d1"))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"requestHostDiagnostics"}"#),
                       .other(type: "requestHostDiagnostics"))
        // The wire name the page actually posts (`notifyAgentCancel`). The
        // parse table used to say `stopAgentRun`, which nothing sends, so a
        // click on the gutter marker reached `.other` and cancelled nothing.
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"agentCancel","requestId":"r1"}"#),
                       .agentCancel(requestId: "r1"))
        // The old spelling must not quietly work again.
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"stopAgentRun","requestId":"r1"}"#),
                       .other(type: "stopAgentRun"))
        // The app acts on the merge outcome now: `partial` and `conflict` leave
        // the agent's version only in the copy beside the note.
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"agentMergeResult","requestId":"r1","outcome":"conflict"}"#),
                       .agentMergeResult(requestId: "r1", outcome: "conflict"))
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"agentMergeResult","requestId":"r1"}"#),
                       .other(type: "agentMergeResult"))
        // An attachment's bytes are a plain base64 STRING, not the `$bytes`
        // wrapper `uploadImage` uses: the composer encodes this one itself
        // (`shared/messages.ts`).
        XCTAssertEqual(
            WebviewMessage.parse(#"{"type":"agentAttachment","id":"a1","name":"shot.png","bytes":"AQID"}"#),
            .agentAttachment(id: "a1", name: "shot.png", bytes: Data([1, 2, 3])))
        // Undecodable or absent bytes still PARSE, and that is deliberate. The
        // composer disables Send until every attachment resolves, so the one
        // outcome that must not happen is falling through to `.other` and
        // never answering: an empty payload is answered with a null path,
        // which frees the button.
        XCTAssertEqual(
            WebviewMessage.parse(#"{"type":"agentAttachment","id":"a1","name":"x"}"#),
            .agentAttachment(id: "a1", name: "x", bytes: Data()))
        XCTAssertEqual(
            WebviewMessage.parse(#"{"type":"agentAttachment","name":"x","bytes":"AQID"}"#),
            .other(type: "agentAttachment"))
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
    /// something the app never offers, with a named allow-list for the third case.
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

    /// The fallback arm of the entry choice. Today's page cannot reach it:
    /// `webview/agentContext.ts` posts one selection and `primary` 0, which is
    /// what `EditorSelectionContext` says it does. The arm is there for the
    /// multi-entry shape that type already permits, and this pins what it does
    /// when the index and the list disagree, which is to place the caret
    /// somewhere rather than answer nil. The two-selection case above is
    /// unreachable for the same reason.
    func testAPrimaryIndexPastTheEndShouldFallBackToTheFirstSelection() {
        let json = #"""
        {"type":"editorContextResult","id":"c1","context":{"selections":[
          {"anchor":{"line":9,"column":2},"active":{"line":9,"column":7},"text":"y"}],
          "primary":4,"isEmpty":false}}
        """#
        XCTAssertEqual(
            WebviewMessage.parse(json),
            .editorContextResult(id: "c1", selection: .init(
                anchor: .init(line: 9, column: 2),
                active: .init(line: 9, column: 7),
                isEmpty: false)))
    }

    /// The other end of that fallback: with nothing in the list there is no
    /// first entry to fall back to, and the reply carries no selection. It is
    /// still a reply, for the reason the null-context case above gives, rather
    /// than an `.other` the caller's pending closure would wait out.
    func testAnEmptySelectionListShouldBeAnAnswerCarryingNoSelection() {
        let json = #"""
        {"type":"editorContextResult","id":"c1","context":{"selections":[],
          "primary":0,"isEmpty":true}}
        """#
        XCTAssertEqual(WebviewMessage.parse(json),
                       .editorContextResult(id: "c1", selection: nil))
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
        XCTAssertEqual(WebviewMessage.parse(#"{"type":"frontmatterUpdate","frontmatter":"x"}"#),
                       .other(type: "frontmatterUpdate"))
        XCTAssertNil(WebviewMessage.parse("not json"))
        XCTAssertNil(WebviewMessage.parse(#"{"noType":1}"#))
    }

    func testHostMessagesEncodeTheSharedShapes() {
        XCTAssertEqual(HostMessage.initDoc(content: "# a", frontmatter: "", lineOffset: 0, syncVersion: 0,
                                           viewStateJSON: #"{"scrollY":3}"#).jsonString(),
                       ##"{"content":"# a","frontmatter":"","lineOffset":0,"syncVersion":0,"type":"init","viewState":{"scrollY":3}}"##)
        XCTAssertEqual(HostMessage.initDoc(content: "", frontmatter: "", lineOffset: 0, syncVersion: 0,
                                           viewStateJSON: "garbage").jsonString(),
                       #"{"content":"","frontmatter":"","lineOffset":0,"syncVersion":0,"type":"init"}"#)
        XCTAssertEqual(HostMessage.externalUpdate(content: "", frontmatter: "", lineOffset: 0, syncVersion: 2).jsonString(),
                       #"{"content":"","frontmatter":"","lineOffset":0,"syncVersion":2,"type":"externalUpdate"}"#)
        // The panel's half of a document, on both messages that carry one. A
        // host that sends only `content` sends the panel nothing to draw, and
        // an offset the page never hears leaves every document line it reports
        // short by the block (webview/agentContext.ts adds it back).
        XCTAssertEqual(HostMessage.initDoc(content: "# a", frontmatter: "---\ntitle: A\n---\n", lineOffset: 3,
                                           syncVersion: 1, viewStateJSON: nil).jsonString(),
                       ##"{"content":"# a","frontmatter":"---\ntitle: A\n---\n","lineOffset":3,"syncVersion":1,"type":"init"}"##)
        XCTAssertEqual(HostMessage.externalUpdate(content: "# a", frontmatter: "+++\ntitle = \"A\"\n+++\n",
                                                  lineOffset: 3, syncVersion: 4).jsonString(),
                       ##"{"content":"# a","frontmatter":"+++\ntitle = \"A\"\n+++\n","lineOffset":3,"syncVersion":4,"type":"externalUpdate"}"##)
        // A panel edit's whole wire footprint: the page's `lineMapUpdate` with
        // no map on it. The map describes the body, the body did not move, and
        // sending the document instead would redraw the panel being typed in.
        XCTAssertEqual(HostMessage.lineOffsetUpdate(lineOffset: 5).jsonString(),
                       #"{"lineOffset":5,"type":"lineMapUpdate"}"#)
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

    /// The outline panel's three memories, which the page reads from three
    /// different places: the visibility from `__i18n`, the width from a CSS
    /// rule in the served HTML, and the side from a class on the body tag
    /// (`BirtaSchemeHandler.renderPage`, checked in `WebHostPageTests`).
    ///
    /// The width is here rather than in the boot script deliberately, and the
    /// negative case is the one that matters: a default install has never
    /// dragged the panel's edge, so the rule must be ABSENT rather than a
    /// number this side chose, or the page's own default is overridden by a
    /// value nobody set.
    func testTheOutlinePanelsMemoriesShouldReachThePageOnTheirOwnChannels() {
        XCTAssertEqual(BootConfig().tocRootStyle, "", "an untouched panel gets no width rule")
        XCTAssertEqual(BootConfig(tocWidth: 320).tocRootStyle, ":root { --toc-width: 320px; }")
        XCTAssertEqual(BootConfig(tocVisibility: "shown").i18nObject()["tocVisibility"] as? String, "shown")
        // The width does NOT travel in the boot script; a copy there would be a
        // second source for one fact, and the one that loses is whichever runs
        // last.
        XCTAssertFalse(BootConfig(tocWidth: 320).userScript(themeClass: "vscode-dark").contains("--toc-width"))
    }

    /// What the reader has said about the Checks, handed back at the next page
    /// load, which this window does on every file it opens.
    ///
    /// The shape is the point. The OPTIONS go back under the page's own option
    /// keys, untranslated, because the one key whose name differs from its
    /// config field is the page's to translate and a copy of that mapping here
    /// is what went stale before. The EXCEPTIONS go back as a config field,
    /// because they are a list the reader built rather than a decision about
    /// which checks this surface can run.
    func testBootConfigShouldHandBackTheChecksAnswersAndNothingElseAboutThem() {
        let cfg = BootConfig(proofreadOptions: ["proofreading": false, "fillers": true],
                             styleExceptions: ["ours to keep"])
        let i18n = cfg.i18nObject()
        XCTAssertEqual(i18n["proofreadOptions"] as? [String: Bool],
                       ["proofreading": false, "fillers": true])
        XCTAssertEqual((i18n["proofread"] as? [String: [String]])?["styleExceptions"],
                       ["ours to keep"])
        // No computed config beside them, and `proofreadingEnabled` above all:
        // sending one is what held the whole pass off on this surface.
        let proofread = i18n["proofread"] as? [String: Any]
        XCTAssertEqual(proofread?.keys.sorted(), ["styleExceptions"])
        XCTAssertNil(proofread?["proofreadingEnabled"])
    }

    func testAnUntouchedInstallShouldHandBackNoChecksAnswersAtAll() {
        // Empty rather than absent is fine for both, and the page treats them
        // the same; what must not appear is a value this side invented.
        let i18n = BootConfig().i18nObject()
        XCTAssertEqual((i18n["proofreadOptions"] as? [String: Bool])?.isEmpty, true)
        XCTAssertEqual((i18n["proofread"] as? [String: [String]])?["styleExceptions"], [])
    }

    func testBootConfigCarriesTheAppsDecisionsAndTheShim() {
        let cfg = BootConfig(toolbarJSON: #"{"placements":{"bold":"hidden"},"order":[],"visible":true}"#,
                             networkEnabled: false, hostCapabilities: [], viewStateJSON: #"{"scrollY":1}"#)
        let i18n = cfg.i18nObject()
        XCTAssertEqual(i18n["isMac"] as? Bool, true)
        XCTAssertEqual(i18n["network"] as? Bool, false)
        XCTAssertEqual(i18n["embedsEnabled"] as? Bool, false)
        XCTAssertEqual(i18n["calcEnabled"] as? Bool, true)
        XCTAssertEqual(i18n["tocVisibility"] as? String, "hidden")
        // The proofread blob carries the kept phrases and NOTHING about which
        // checks can run: that is decided by the page from the capabilities
        // above. A computed config here would be a second declarer of it, which
        // is what held the whole pass off on this surface for as long as it
        // existed, by testing a capability name that had been renamed away.
        XCTAssertNil((i18n["proofread"] as? [String: Any])?["proofreadingEnabled"])
        // The host's own facts live under one key, not scattered among the
        // user's settings beside them (shared/hostProfile.ts).
        let host = i18n["host"] as? [String: Any]
        XCTAssertEqual((host?["capabilities"] as? [String]) ?? ["x"], [])
        // Spelled out rather than derived, and it has to stay that way: this is
        // the check that a NEW arrangement was declared here deliberately, so a
        // list built from the thing under test would agree with any change at
        // all. The cost is that adding one means editing this line, which is
        // the point of it: every arrangement the app has gained has gone red here
        // first, in a commit that added it to the bridge and ran no Swift.
        XCTAssertEqual(host?["arrangements"] as? [String],
                       ["typographyInGearMenu", "formattingInSecondRow", "fixedToolbarLayout",
                        "barMenusOnClick", "nativeFindBar", "nativeDatePicker",
                        "fixedTocSide", "tocToggleInBar"])
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

    /// A shortcut row's optional halves crossing into the page.
    ///
    /// `AppMenuTests` holds `AppMenu.shortcuts` against the menu table and
    /// `hostProfile.test.ts` holds the e2e page against that same table, and
    /// NEITHER of them looks at the dictionary this builds. Drop `command` here
    /// and every one of those stays green while the panel's tooltips stop
    /// naming keys: the page resolves a tooltip's chord BY command
    /// (`webview/commandChords.ts`) and groups the cheatsheet BY section.
    func testAShortcutRowShouldCarryItsCommandAndSectionAndOmitWhatItHasNot() {
        let cfg = BootConfig(hostShortcuts: [
            HostShortcut(keys: "Mod-k", label: "Link…", command: "insertLink", section: "Format"),
            HostShortcut(keys: "Mod-s", label: "Save"),
        ])
        let host = cfg.i18nObject()["host"] as? [String: Any]
        let rows = host?["shortcuts"] as? [[String: Any]]
        XCTAssertEqual(rows?.count, 2)
        XCTAssertEqual(rows?.first?["keys"] as? String, "Mod-k")
        XCTAssertEqual(rows?.first?["label"] as? String, "Link…")
        XCTAssertEqual(rows?.first?["command"] as? String, "insertLink")
        XCTAssertEqual(rows?.first?["section"] as? String, "Format")
        // Omitted rather than sent as null, because the page's field is
        // optional and its absence is the claim "this key runs no command".
        XCTAssertEqual(rows?.last?.keys.sorted(), ["keys", "label"])
        // And it survives serialization, which is the form the page reads.
        let script = cfg.userScript(themeClass: "vscode-dark")
        XCTAssertTrue(script.contains(#""command":"insertLink""#), script)
        XCTAssertTrue(script.contains(#""section":"Format""#), script)
    }

    func testEveryNetworkFeatureRidesTheOneSwitch() {
        let on = BootConfig(networkEnabled: true).i18nObject()
        XCTAssertEqual(on["network"] as? Bool, true)
        XCTAssertEqual(on["embedsEnabled"] as? Bool, true)
        XCTAssertEqual(on["linkCardsEnabled"] as? Bool, true)
        XCTAssertEqual(on["pasteUnfurl"] as? Bool, true)
        XCTAssertEqual(HostMessage.editorCommand("openFind").jsonString(), #"{"command":"openFind","type":"editorCommand"}"#)
        // The shape `shared/messages.ts` declares for `hostTooltip`, both ways
        // round. Hiding sends a null text and NO rect: the page reads the null
        // as "take it away", and a box for a tooltip that is not being drawn
        // would be a number nothing means.
        XCTAssertEqual(
            HostMessage.hostTooltip(text: "New Note  ⌘N",
                                    rect: CGRect(x: 136, y: 4, width: 26, height: 24)).jsonString(),
            #"{"rect":{"height":24,"width":26,"x":136,"y":4},"text":"New Note  ⌘N","type":"hostTooltip"}"#)
        XCTAssertEqual(HostMessage.hostTooltip(text: nil, rect: nil).jsonString(),
                       #"{"text":null,"type":"hostTooltip"}"#)
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

    /// The reply the composer is waiting on. `path` is null on failure rather
    /// than absent: the page reads it to decide between a resolved chip and a
    /// failed one, and both stop the Send button waiting.
    func testAgentAttachmentSavedCarriesItsPathOrAnExplicitNull() {
        let ok = HostMessage.agentAttachmentSaved(id: "a1", path: "/tmp/birta-ai-1/1-shot.png").jsonObject()
        XCTAssertEqual(ok["type"] as? String, "agentAttachmentSaved")
        XCTAssertEqual(ok["id"] as? String, "a1")
        XCTAssertEqual(ok["path"] as? String, "/tmp/birta-ai-1/1-shot.png")

        let failed = HostMessage.agentAttachmentSaved(id: "a1", path: nil).jsonObject()
        XCTAssertTrue(failed["path"] is NSNull)
        XCTAssertTrue(JSONSerialization.isValidJSONObject(failed))
    }
}
