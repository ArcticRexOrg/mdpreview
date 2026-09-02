import AppKit
import WebKit

enum PDFRenderError: LocalizedError {
    case templateMissing
    case unreadableSource(URL)
    case pagination(String)
    case timedOut
    case noPages

    var errorDescription: String? {
        switch self {
        case .templateMissing:
            return "MarkdownPreview's render template is missing from the application bundle."
        case .unreadableSource(let url):
            return "Can't read \(url.path)."
        case .pagination(let message):
            return "Rendering failed: \(message)"
        case .timedOut:
            return "Rendering timed out."
        case .noPages:
            return "The document produced no pages."
        }
    }
}

/// Renders a Markdown file to a paginated PDF with no window on screen.
///
/// Document mode lives entirely in template.html, so the export drives the
/// same pipeline the visible view does — render, theme, paginate with
/// Paged.js, capture each page — in a webview parented to a window parked off
/// every display. What that costs is a page WebKit considers hidden, and a
/// hidden page gets no animation frames, so `start` also turns the view's
/// occlusion tracking off; without it Paged.js never finishes laying out.
@MainActor
final class HeadlessPDFRenderer: NSObject, WKNavigationDelegate, WKScriptMessageHandler {

    /// Renders `url` and hands back the PDF bytes. Always calls back on the
    /// main thread, exactly once.
    static func render(url: URL,
                       theme: Theme,
                       config: PDFConfig,
                       completion: @escaping (Result<Data, Error>) -> Void) {
        guard let markdown = try? String(contentsOf: url, encoding: .utf8) else {
            completion(.failure(PDFRenderError.unreadableSource(url)))
            return
        }
        guard let template = Bundle.main.resourceURL?.appendingPathComponent("template.html"),
              FileManager.default.fileExists(atPath: template.path) else {
            completion(.failure(PDFRenderError.templateMissing))
            return
        }

        let formatter = DateFormatter()
        formatter.dateStyle = .long
        let configJSON = config.resolvedJSON(
            title: url.deletingPathExtension().lastPathComponent,
            date: formatter.string(from: Date())
        )

        let renderer = HeadlessPDFRenderer(
            markdown: markdown,
            baseURL: url.deletingLastPathComponent(),
            theme: theme,
            configJSON: configJSON,
            completion: completion
        )
        live.insert(renderer)
        renderer.start(template: template)
    }

    /// Renders outlive the call that started them, so keep them alive until
    /// they report back.
    private static var live: Set<HeadlessPDFRenderer> = []

    private let markdown: String
    private let baseURL: URL
    private let theme: Theme
    private let configJSON: String
    private var completion: ((Result<Data, Error>) -> Void)?
    private var window: NSWindow?
    private var webView: WKWebView?
    private var timeout: DispatchWorkItem?
    private var activity: NSObjectProtocol?

    /// Generous, because the first render in a freshly launched app takes
    /// tens of seconds — see the note in `start` — and a slow PDF beats a
    /// failed one. Stays under AppleScript's own 120s reply limit.
    private static let renderTimeout: TimeInterval = 110

    private init(markdown: String,
                 baseURL: URL,
                 theme: Theme,
                 configJSON: String,
                 completion: @escaping (Result<Data, Error>) -> Void) {
        self.markdown = markdown
        self.baseURL = baseURL
        self.theme = theme
        self.configJSON = configJSON
        self.completion = completion
    }

    private func start(template: URL) {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        config.userContentController.add(self, name: "paginationDone")

        // Wide enough that the largest configurable page box (A3, 297mm) lays
        // out without the viewport constraining it.
        let frame = NSRect(x: 0, y: 0, width: 1400, height: 2000)
        let webView = WKWebView(frame: frame, configuration: config)
        webView.navigationDelegate = self
        // Match document mode: light appearance, so prefers-color-scheme: dark
        // can never match and produce a dark-on-dark PDF.
        webView.appearance = NSAppearance(named: .aqua)
        // A window off-screen is an occluded window, and WebKit stops
        // servicing a hidden page's animation frames — which is what Paged.js
        // steps its layout on, so pagination would never finish. This is
        // WebKit's own switch for views that render without being seen.
        let occlusionSetter = NSSelectorFromString("_setWindowOcclusionDetectionEnabled:")
        if webView.responds(to: occlusionSetter) {
            webView.setValue(false, forKey: "windowOcclusionDetectionEnabled")
        }
        self.webView = webView

        // Ordered in so the document is laid out, parked off every display so
        // nothing is seen. Note that WebKit rates a page it cannot see as
        // out of view and runs its content process at background priority:
        // the first render in a fresh process takes tens of seconds, every
        // one after it under a second. Neither turning off occlusion
        // detection, an activity token, nor an on-screen transparent window
        // shifts that, so an export from a cold app is simply slow.
        let window = NSWindow(contentRect: frame, styleMask: .borderless, backing: .buffered, defer: false)
        window.isReleasedWhenClosed = false
        window.isExcludedFromWindowsMenu = true
        window.collectionBehavior = [.transient, .ignoresCycle]
        window.contentView = webView
        window.setFrameOrigin(NSPoint(x: -30000, y: -30000))
        window.orderBack(nil)
        self.window = window

        let timeout = DispatchWorkItem { [weak self] in
            self?.finish(.failure(PDFRenderError.timedOut))
        }
        self.timeout = timeout
        DispatchQueue.main.asyncAfter(deadline: .now() + Self.renderTimeout, execute: timeout)

        // An app launched by a script is a background app, and a background
        // app is App Napped: its timers are throttled to a crawl, and
        // Paged.js lays out on those timers. On screen this never shows up,
        // because exporting means someone is using the app.
        activity = ProcessInfo.processInfo.beginActivity(
            options: [.userInitiated, .latencyCritical],
            reason: "Rendering a PDF"
        )
        webView.loadFileURL(template, allowingReadAccessTo: URL(fileURLWithPath: "/"))
    }

    // MARK: - Pipeline

    func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
        guard let baseHref = json(baseURL.absoluteString),
              let markdownJSON = json(markdown) else {
            finish(.failure(PDFRenderError.pagination("could not encode the document for rendering")))
            return
        }
        let darkCodeTheme = theme.darkCodeThemeFile.map { "'\($0)'" } ?? "null"
        webView.evaluateJavaScript("setBaseURL(\(baseHref))", completionHandler: nil)
        webView.evaluateJavaScript("setTheme('\(theme.cssFile)', '\(theme.codeThemeFile)', \(darkCodeTheme))", completionHandler: nil)
        // Load the content while still in reading mode, then switch: entering
        // document mode with an empty document would paginate nothing and
        // report a spurious paginationDone before the real one.
        webView.evaluateJavaScript("renderMarkdown(\(markdownJSON))") { [weak self] _, error in
            guard let self else { return }
            if let error {
                self.finish(.failure(PDFRenderError.pagination(error.localizedDescription)))
                return
            }
            webView.evaluateJavaScript("setViewMode('document', \(self.configJSON))") { _, error in
                if let error {
                    self.finish(.failure(PDFRenderError.pagination(error.localizedDescription)))
                }
            }
        }
    }

    func webView(_ webView: WKWebView, didFail navigation: WKNavigation!, withError error: Error) {
        finish(.failure(error))
    }

    func webView(_ webView: WKWebView, didFailProvisionalNavigation navigation: WKNavigation!, withError error: Error) {
        finish(.failure(error))
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == "paginationDone" else { return }
        captureWhenImagesAreLoaded()
    }

    /// Pagination reports done before the images it laid out have finished
    /// loading — the running-header logo is one — and capturing at that
    /// moment prints an empty header. On screen nobody sees this, because the
    /// seconds before someone clicks Save PDF are more than enough.
    private func captureWhenImagesAreLoaded(attempt: Int = 0) {
        guard let webView else { return }
        let js = "Array.prototype.every.call(document.images, function(i){ return i.complete; })"
        webView.evaluateJavaScript(js) { [weak self] result, _ in
            guard let self, let webView = self.webView else { return }
            let loaded = (result as? Bool) ?? true
            guard loaded || attempt >= Self.imageWaitAttempts else {
                DispatchQueue.main.asyncAfter(deadline: .now() + Self.imageWaitInterval) {
                    self.captureWhenImagesAreLoaded(attempt: attempt + 1)
                }
                return
            }
            PagedPDFCapture.capture(webView: webView) { [weak self] data in
                guard let data else {
                    self?.finish(.failure(PDFRenderError.noPages))
                    return
                }
                self?.finish(.success(data))
            }
        }
    }

    private static let imageWaitInterval: TimeInterval = 0.2
    private static let imageWaitAttempts = 15

    // MARK: - Teardown

    private func finish(_ result: Result<Data, Error>) {
        guard let completion else { return }   // a later paginationDone, or the timeout losing a race
        self.completion = nil
        timeout?.cancel()
        timeout = nil
        if let activity {
            ProcessInfo.processInfo.endActivity(activity)
            self.activity = nil
        }
        webView?.configuration.userContentController.removeScriptMessageHandler(forName: "paginationDone")
        webView?.navigationDelegate = nil
        window?.orderOut(nil)
        window?.contentView = nil
        window = nil
        webView = nil
        completion(result)
        Self.live.remove(self)
    }

    private func json(_ string: String) -> String? {
        guard let data = try? JSONEncoder().encode(string) else { return nil }
        return String(data: data, encoding: .utf8)
    }
}
