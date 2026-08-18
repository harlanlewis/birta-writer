// swift-tools-version:5.10
// Birta Writer Jot: the macOS menu-bar scratchpad shell around dist/webview.js.
// Two targets on purpose: BirtaJotCore holds everything that can be tested
// without a window (hotkey parsing, the flush/seq guard, atomic writes, the
// bridge codec); BirtaJot is the AppKit/WebKit app that composes it.
import PackageDescription

let package = Package(
    name: "BirtaJot",
    platforms: [.macOS(.v14)],
    targets: [
        .target(
            name: "BirtaJotCore",
            path: "Sources/BirtaJotCore"
        ),
        .executableTarget(
            name: "BirtaJot",
            dependencies: ["BirtaJotCore"],
            path: "Sources/BirtaJot",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
                .linkedFramework("Carbon"),
            ]
        ),
        .testTarget(
            name: "BirtaJotCoreTests",
            dependencies: ["BirtaJotCore"],
            path: "Tests/BirtaJotCoreTests"
        ),
    ]
)
