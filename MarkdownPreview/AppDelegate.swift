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

    /// Hand the file to a window SwiftUI already made. One built here carries
    /// no scene toolbar — no mode switch, no theme, no export — and leaves
    /// the empty launch window sitting in front of it showing nothing.
    ///
    /// At launch the file arrives before the scene exists, so keep asking
    /// until it does; only if it never appears is a window built here.
    ///
    /// A running app with no window gets none from SwiftUI on its own: one
    /// launched by a script never had one, and one whose windows were all
    /// closed keeps running without. The file used to wait out the deadline
    /// for the fallback — or, before a closed window's state was
    /// unregistered, be given to that state and show nowhere. So ask the
    /// scene for a window: at once when one has existed before, otherwise
    /// after a moment, since at launch the scene's own window is on its way.
    @MainActor
    private func open(_ url: URL, deadline: Date? = nil) {
        if let state = OpenWindows.shared.newest {
            sceneWindowRequested = false
            state.openFile(url)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        let deadline = deadline ?? Date().addingTimeInterval(5)
        guard Date() < deadline else {
            presentWindow(for: url)
            NSApp.activate(ignoringOtherApps: true)
            return
        }
        if !sceneWindowRequested,
           OpenWindows.shared.hasHadWindows || deadline.timeIntervalSinceNow < 4 {
            sceneWindowRequested = true
            requestSceneWindow()
        }
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            self?.open(url, deadline: deadline)
        }
    }

    private var sceneWindowRequested = false

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

/// The windows currently open, newest first, so a file arriving from the
/// Finder can be given to one instead of a window built by hand.
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

    var newest: AppState? {
        states = states.filter { $0() != nil }
        return states.last?()
    }
}
