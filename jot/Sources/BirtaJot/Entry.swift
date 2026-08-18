import AppKit

/// Birta Writer Jot: a menu-bar agent (LSUIElement) with no Dock icon. The
/// activation policy is set here as well as in Info.plist so `swift run`
/// during development behaves like the bundled app.
@main
@MainActor
enum Entry {
    static func main() {
        let app = NSApplication.shared
        app.setActivationPolicy(.accessory)
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
