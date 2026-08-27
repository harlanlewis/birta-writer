import AppKit
import BirtaJotCore

/// Birta Writer: a menu-bar agent (LSUIElement). The activation policy is
/// set here as well as in Info.plist so `swift run` during development behaves
/// like the bundled app, and because the "Show in Dock" setting can raise it
/// to `.regular`; the plist keeps the accessory default so a launch never
/// flashes an icon before the setting is read.
@main
@MainActor
enum Entry {
    static func main() {
        // Before the line below, and that is the whole of why it is here:
        // AppKit reads these while `NSApplication` comes up, so a registration
        // made from the delegate is read by nobody. `AppKitDefaults` says what
        // is turned off and how to look at the result.
        AppKitDefaults.register()
        let app = NSApplication.shared
        AppDelegate.applyActivationPolicy()
        let delegate = AppDelegate()
        app.delegate = delegate
        app.run()
    }
}
