import Foundation
import os

/// The three MAR-374 quantities as instrumentation, never as figures in prose:
/// os_signpost points under `com.birtalabs.jot` / `summon`, and, when
/// `BIRTA_JOT_MEASURE=1`, one `jot-measure <name> <ms-since-launch>` line on
/// stderr per mark, which `jot/scripts/measure.sh` reads. The intervals of
/// interest are `hotkey→visible`, `hotkey→caret-ready`, `terminate→ready`
/// (cold recovery) and `launch→ready`.
final class Measure {
    private let log = OSLog(subsystem: "com.birtalabs.jot", category: "summon")
    let enabled = ProcessInfo.processInfo.environment["BIRTA_JOT_MEASURE"] == "1"
    private let start = ProcessInfo.processInfo.systemUptime

    func mark(_ name: StaticString) {
        os_signpost(.event, log: log, name: name)
        guard enabled else { return }
        let ms = (ProcessInfo.processInfo.systemUptime - start) * 1000
        FileHandle.standardError.write(Data("jot-measure \(name) \(String(format: "%.1f", ms))\n".utf8))
    }

    func trace(_ text: String) {
        guard enabled else { return }
        FileHandle.standardError.write(Data("jot-trace \(text)\n".utf8))
    }

    /// The page's own `mdw:` User-Timing marks (webview/perf.ts), on request.
    func receivedPerfMarks(_ json: String) {
        guard enabled else { return }
        FileHandle.standardError.write(Data("jot-perf-marks \(json)\n".utf8))
    }
}
