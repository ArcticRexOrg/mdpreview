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
        NSAppleEventManager.shared().setEventHandler(
            self,
            andSelector: #selector(handleOpenDocs(_:withReplyEvent:)),
            forEventClass: AEEventClass(kCoreEventClass),
            andEventID: AEEventID(kAEOpenDocuments)
        )
        claimDefaultMarkdownHandler()
    }

    func applicationDidFinishLaunching(_ notification: Notification) {
        flushPendingURLs()
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
    @MainActor
    private func open(_ url: URL, deadline: Date? = nil) {
        if let state = OpenWindows.shared.newest {
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
        DispatchQueue.main.asyncAfter(deadline: .now() + 0.1) { [weak self] in
            self?.open(url, deadline: deadline)
        }
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

    func register(_ state: AppState) {
        states.append { [weak state] in state }
    }

    var newest: AppState? {
        states = states.filter { $0() != nil }
        return states.last?()
    }
}
