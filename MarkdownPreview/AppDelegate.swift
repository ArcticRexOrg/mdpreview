import AppKit
import SwiftUI
import UniformTypeIdentifiers

class AppDelegate: NSObject, NSApplicationDelegate {
    private var pendingURLs: [URL] = []
    private var fileWindows: [NSWindow] = []

    func applicationWillFinishLaunching(_ notification: Notification) {
        // SwiftUI's @NSApplicationDelegateAdaptor does not deliver
        // application(_:open:) for kAEOpenDocuments events, so install our
        // own Apple Event handler.
        installOpenDocsHandler()
        claimDefaultMarkdownHandler()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        // SwiftUI installs its own handler for the same event and, when the
        // app was launched by a script's `launch` — as a scripted export does
        // — it does so after this point, taking the event over: every file
        // then opened a bare new window and was shown nowhere. Install ours
        // again once launch has fully settled, so it is the one in place.
        DispatchQueue.main.async { [weak self] in
            self?.installOpenDocsHandler()
        }
        flushPendingURLs()
    }

    private func installOpenDocsHandler() {
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleOpenDocs(_:withReplyEvent:)),
            forEventClass: AEEventClass(kCoreEventClass),
            andEventID: AEEventID(kAEOpenDocuments)
        )
    }

    @objc func handleOpenDocs(_ event: NSAppleEventDescriptor, withReplyEvent reply: NSAppleEventDescriptor) {
        guard let direct = event.paramDescriptor(forKeyword: AEKeyword(keyDirectObject)) else { return }
        // The Finder sends a list of files; a script saying `open POSIX file
        // "…"` sends the one file bare, and a bare descriptor reports zero
        // items — which used to make the range 1...0 and kill the app.
        let items: [NSAppleEventDescriptor] = direct.numberOfItems > 0
            ? (1...direct.numberOfItems).compactMap { direct.atIndex($0) }
            : [direct]
        for item in items {
            guard let coerced = item.coerce(toDescriptorType: DescType(typeFileURL)),
                  let url = URL(dataRepresentation: coerced.data, relativeTo: nil) else { continue }
            if ["md", "markdown"].contains(url.pathExtension.lowercased()) {
                pendingURLs.append(url)
            }
        }
        flushPendingURLs()
    }

    private func flushPendingURLs() {
        let urls = pendingURLs
        pendingURLs.removeAll()
        MainActor.assumeIsolated {
            for url in urls { open(url) }
        }
    }

    /// Give the file a new window of the main scene — one built here
    /// carries no scene toolbar (no mode switch, no theme, no export).
    ///
    /// A new window rather than an existing one: the newest window may be on
    /// another Space, where the file loads unseen and the open looks like it
    /// did nothing. A window made now is born on the Space the user is on.
    /// The exceptions: a window on this Space already showing the file is
    /// brought forward, and an empty one here — the launch window above all
    /// — takes the file rather than being left beside it showing nothing.
    ///
    /// Otherwise the file waits for the next window to be made, which takes
    /// it as it starts. At launch that is the scene's own window, already on
    /// its way, so ask for one only after a moment; a running app gets one at
    /// once. Only if none ever appears is a window built here.
    @MainActor
    private func open(_ url: URL) {
        NSApp.activate(ignoringOtherApps: true)
        let windows = OpenWindows.shared
        if let state = windows.onActiveSpace.first(where: { $0.selectedFile == url }) {
            state.window?.makeKeyAndOrderFront(nil)
            return
        }
        if let state = windows.onActiveSpace.first(where: { !$0.hasFile }) {
            state.openFile(url)
            state.window?.makeKeyAndOrderFront(nil)
            return
        }
        windows.awaitWindow(for: url)
        awaitWindow(for: url, deadline: Date().addingTimeInterval(5), requested: false)
    }

    @MainActor
    private func awaitWindow(for url: URL, deadline: Date, requested: Bool) {
        guard OpenWindows.shared.isAwaitingWindow(url) else { return }
        guard Date() < deadline else {
            _ = OpenWindows.shared.takeAwaitingFile(url)
            presentWindow(for: url)
            return
        }
        var requested = requested
        if !requested, OpenWindows.shared.hasHadWindows || deadline.timeIntervalSinceNow < 4 {
            requested = true
            requestSceneWindow()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            self?.awaitWindow(for: url, deadline: deadline, requested: requested)
        }
    }

    /// Through the scene's own action when a window has lent it, else the
    /// way a Dock click does it: a reopen event, which makes SwiftUI put up
    /// a window of the main scene when the app shows none.
    @MainActor
    private func requestSceneWindow() {
        if let makeWindow = OpenWindows.shared.makeWindow {
            makeWindow()
            return
        }
        let reopen = NSAppleEventDescriptor(
            eventClass: AEEventClass(kCoreEventClass),
            eventID: AEEventID(kAEReopenApplication),
            targetDescriptor: .currentProcess(),
            returnID: AEReturnID(kAutoGenerateReturnID),
            transactionID: AETransactionID(kAnyTransactionID)
        )
        _ = try? reopen.sendEvent(options: [.noReply], timeout: 1)
    }

    private func presentWindow(for url: URL) {
        let hosting = NSHostingController(rootView: ContentView(initialURL: url))
        let window = NSWindow(contentViewController: hosting)
        window.styleMask = [.titled, .closable, .miniaturizable, .resizable]
        window.setContentSize(NSSize(width: 1200, height: 800))
        window.title = url.lastPathComponent
        window.center()
        window.makeKeyAndOrderFront(nil)
        NSApp.activate(ignoringOtherApps: true)
        fileWindows.append(window)
    }

    private func claimDefaultMarkdownHandler() {
        guard let bundleID = Bundle.main.bundleIdentifier else { return }
        for ext in ["md", "markdown"] {
            guard let uti = UTType(filenameExtension: ext)?.identifier else { continue }
            let current = LSCopyDefaultRoleHandlerForContentType(uti as CFString, .viewer)?.takeRetainedValue() as String?
            if current != bundleID {
                LSSetDefaultRoleHandlerForContentType(uti as CFString, .viewer, bundleID as CFString)
            }
        }
    }
}

extension Notification.Name {
    static let showSearch = Notification.Name("showSearch")
    static let printDocument = Notification.Name("printDocument")
}

/// The windows currently open, and the files waiting for a new one, so a
/// file arriving from the Finder or the command line lands in a scene window
/// instead of one built by hand.
@MainActor
final class OpenWindows {
    static let shared = OpenWindows()

    private var states: [() -> AppState?] = []

    /// Whether any window has ever registered — true once the launch window
    /// is up, so a later empty list means windows were closed, not that the
    /// scene has yet to appear.
    private(set) var hasHadWindows = false

    /// Opens a new window of the main scene; set by a window that exists,
    /// since only a view can reach SwiftUI's action.
    var makeWindow: (() -> Void)?

    func register(_ state: AppState) {
        hasHadWindows = true
        guard !states.contains(where: { $0() === state }) else { return }
        states.append { [weak state] in state }
    }

    func unregister(_ state: AppState) {
        states.removeAll { $0() === state }
    }

    /// Windows on the Space the user is looking at.
    var onActiveSpace: [AppState] {
        states = states.filter { $0() != nil }
        return states.compactMap { $0() }.filter {
            guard let window = $0.window else { return false }
            return window.isVisible && window.isOnActiveSpace
        }
    }

    /// Files waiting for a new window, oldest first.
    private var awaiting: [URL] = []

    func awaitWindow(for url: URL) { awaiting.append(url) }

    func isAwaitingWindow(_ url: URL) -> Bool { awaiting.contains(url) }

    /// The oldest file waiting for a window — or the given one — taken off
    /// the list by the window that will show it.
    func takeAwaitingFile(_ url: URL? = nil) -> URL? {
        guard let index = url.map({ awaiting.firstIndex(of: $0) }) ?? awaiting.indices.first else { return nil }
        return awaiting.remove(at: index)
    }
}
