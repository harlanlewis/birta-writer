// swift-tools-version:5.10
// Birta Writer: the macOS menu-bar scratchpad shell around dist/webview.js.
// Two targets on purpose: BirtaWriterCore holds what is decidable with no host at
// all (hotkey parsing, the flush/seq guard, atomic writes, the bridge codec);
// BirtaWriter is the AppKit/WebKit app that composes it. Both are tested, and the
// split is NOT a testability boundary: a test target depending on the app
// builds real windows, lays them out and reads their view hierarchies without
// one ever being shown.
import PackageDescription

let package = Package(
    name: "BirtaWriter",
    platforms: [.macOS(.v14)],
    targets: [
        .target(
            name: "BirtaWriterCore",
            path: "Sources/BirtaWriterCore"
        ),
        .executableTarget(
            name: "BirtaWriter",
            dependencies: ["BirtaWriterCore"],
            path: "Sources/BirtaWriter",
            linkerSettings: [
                .linkedFramework("AppKit"),
                .linkedFramework("WebKit"),
                .linkedFramework("Carbon"),
            ]
        ),
        // The `bwr` command, a second executable that ships inside the same
        // bundle at Contents/MacOS. It links AppKit for nothing and does not
        // get it: everything it does is Foundation plus one `open(1)`, which
        // is what keeps a shell command from paying for a GUI framework it
        // never draws with.
        .executableTarget(
            name: "BirtaWriterCli",
            dependencies: ["BirtaWriterCore"],
            path: "Sources/BirtaWriterCli"
        ),
        .testTarget(
            name: "BirtaWriterCoreTests",
            dependencies: ["BirtaWriterCore"],
            path: "Tests/BirtaWriterCoreTests"
        ),
        // The app target itself, under test. A test target may depend on an
        // executable target, so `@main` in Entry.swift is no obstacle and no
        // executable/library split is needed; a window AppKit has built and
        // laid out answers questions about itself before anything shows it, so
        // the suite runs unattended alongside every other test.
        .testTarget(
            name: "BirtaWriterTests",
            dependencies: ["BirtaWriter"],
            path: "Tests/BirtaWriterTests"
        ),
    ]
)
