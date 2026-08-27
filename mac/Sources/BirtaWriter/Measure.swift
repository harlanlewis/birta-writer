import Foundation
import os

/// The three MAR-374 quantities as instrumentation, never as figures in prose:
/// os_signpost points under `com.birtalabs.birta-writer` / `summon`, and, when
/// `BIRTA_MAC_MEASURE=1`, one `mac-measure <name> <ms-since-launch>` line on
/// stderr per mark, which `mac/scripts/measure.sh` reads. The intervals of
/// interest are `hotkey→visible`, `hotkey→caret-ready`, `terminate→ready`
/// (cold recovery) and `launch→ready`.
final class Measure {
    private let log = OSLog(subsystem: "com.birtalabs.birta-writer", category: "summon")
    /// Whether this process is being measured at all.
    ///
    /// Static as well as per-instance because the app decides whether to
    /// install the measurement signals before it has any window to ask.
    static let isEnabled = ProcessInfo.processInfo.environment["BIRTA_MAC_MEASURE"] == "1"
    let enabled = Measure.isEnabled
    private let start = ProcessInfo.processInfo.systemUptime

    func mark(_ name: StaticString) {
        os_signpost(.event, log: log, name: name)
        guard enabled else { return }
        let ms = (ProcessInfo.processInfo.systemUptime - start) * 1000
        FileHandle.standardError.write(Data("mac-measure \(name) \(String(format: "%.1f", ms))\n".utf8))
    }

    func trace(_ text: String) {
        Measure.trace(text)
    }

    /// The same line, from something that has no `Measure` of its own.
    ///
    /// Static for the reason `isEnabled` is: a few facts worth tracing belong
    /// to the app rather than to a window, and the alternative is a second way
    /// to write a `birta-trace` line. There was one, briefly, on a different
    /// stream and behind a different condition, which is how a trace ends up
    /// appearing in runs nobody is measuring.
    static func trace(_ text: String) {
        guard isEnabled else { return }
        FileHandle.standardError.write(Data("birta-trace \(text)\n".utf8))
    }

    /// The page's own `mdw:` User-Timing marks (webview/perf.ts), on request.
    func receivedPerfMarks(_ json: String) {
        guard enabled else { return }
        FileHandle.standardError.write(Data("mac-perf-marks \(json)\n".utf8))
    }
}
