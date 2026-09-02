import Foundation
import Network

/// Whether the network this Mac is on is one to be careful with.
///
/// It exists for exactly one caller: the automatic update download. That is
/// the only thing in this app that spends real money without being asked. An
/// update archive runs to tens of megabytes, the release job publishes most
/// nights, and a laptop tethered to a phone would pay for one after another
/// for something nobody requested. Before this change nothing was fetched
/// until somebody confirmed a sheet, so the question did not arise; making the
/// download automatic is what creates it.
///
/// `isExpensive` is cellular or a personal hotspot, and `isConstrained` is Low
/// Data Mode, which is the user telling macOS this outright. Both are read,
/// because they are two different people asking for the same restraint.
///
/// The OFFER is deliberately not gated on this, and the sheet's Restart button
/// is not either. Somebody who presses it has asked, and Low Data Mode is a
/// preference about background traffic rather than a refusal to ever update.
///
/// It answers FALSE until the first path arrives, which is the opposite bias
/// from everything else on the update path, and deliberately. Elsewhere a
/// refusal costs a version and a wrong go-ahead costs somebody the app they
/// were using, so doubt refuses. Here a wrong go-ahead costs one download and
/// a refusal that stuck would be an app that silently stopped updating, so
/// doubt permits.
///
/// The window in which that bias is load-bearing is closed by STARTING the
/// monitor at launch rather than on first read. `AppDelegate` does that
/// explicitly, and the ordering is the whole reason it is a line of its own
/// there: a lazily created singleton would begin monitoring inside the first
/// check that consulted it, and so would answer that check from no path at
/// all. Started at launch, every check has an HTTP round trip's worth of head
/// start on the answer.
final class NetworkPath: @unchecked Sendable {
    static let shared = NetworkPath()

    private let monitor = NWPathMonitor()
    /// The handler runs on the monitor's own queue and the reader is on the
    /// main actor, so the flag is crossed under a lock rather than left to
    /// chance. It is one Bool, and a lock around one Bool is cheaper to reason
    /// about than any of the ways to avoid it.
    private let lock = NSLock()
    private var metered = false

    /// Begin watching. Called at launch rather than left to the first read,
    /// for the reason in the header; calling it twice is harmless, since the
    /// singleton is what starts and it starts once.
    static func start() { _ = shared }

    private init() {
        monitor.pathUpdateHandler = { [weak self] path in
            guard let self else { return }
            self.lock.lock()
            self.metered = path.isExpensive || path.isConstrained
            self.lock.unlock()
        }
        monitor.start(queue: DispatchQueue(label: "com.birtalabs.birta-writer.network-path"))
    }

    var isMetered: Bool {
        lock.lock()
        defer { lock.unlock() }
        return metered
    }
}
