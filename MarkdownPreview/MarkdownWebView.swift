import SwiftUI
import WebKit
import PDFKit
import UniformTypeIdentifiers

struct MarkdownWebView: NSViewRepresentable {
    let markdownContent: String
    let exportTrigger: Int
    let viewPDFTrigger: Int
    let printTrigger: Int
    var exportFilename: String = "document"
    var theme: Theme = Theme.all[0]
    var searchText: String = ""
    var searchForwardTrigger: Int = 0
    var searchBackwardTrigger: Int = 0
    var viewMode: ViewMode = .reading
    var pdfConfigJSON: String = "{}"
    var viewModeTrigger: Int = 0
    var baseURL: URL?
    var diskChangeContent: String = ""
    var diskChangeTrigger: Int = 0
    var onEdit: (String) -> String? = { _ in nil }

    func makeCoordinator() -> Coordinator {
        Coordinator()
    }

    func makeNSView(context: Context) -> WKWebView {
        let config = WKWebViewConfiguration()
        config.preferences.setValue(true, forKey: "allowFileAccessFromFileURLs")
        config.userContentController.add(context.coordinator, name: "paginationDone")
        config.userContentController.add(context.coordinator, name: "consoleLog")
        config.userContentController.add(context.coordinator, name: "documentEdited")
        config.userContentController.add(context.coordinator, name: "editorLog")
        config.userContentController.add(context.coordinator, name: "openLink")
        let consoleScript = WKUserScript(
            source: "var _origLog = console.log; console.log = function() { var msg = Array.from(arguments).map(String).join(' '); _origLog.apply(console, arguments); window.webkit.messageHandlers.consoleLog.postMessage(msg); };",
            injectionTime: .atDocumentStart,
            forMainFrameOnly: true
        )
        config.userContentController.addUserScript(consoleScript)

        let webView = WKWebView(frame: .zero, configuration: config)
        webView.navigationDelegate = context.coordinator
        webView.uiDelegate = context.coordinator
        context.coordinator.webView = webView

        if let resourcesURL = Bundle.main.resourceURL {
            let templateURL = resourcesURL.appendingPathComponent("template.html")
            // Grant read access to / so images referenced by relative paths in markdown files work
            let rootAccess = URL(fileURLWithPath: "/")
            webView.loadFileURL(templateURL, allowingReadAccessTo: rootAccess)
        }

        return webView
    }

    func updateNSView(_ webView: WKWebView, context: Context) {
        let coord = context.coordinator
        coord.docTag = exportFilename

        // View mode change
        if viewModeTrigger != coord.lastViewModeTrigger {
            coord.lastViewModeTrigger = viewModeTrigger
            coord.currentViewMode = viewMode
            coord.setViewMode(viewMode, configJSON: pdfConfigJSON)
        }

        // Base URL change (for resolving relative image paths)
        if baseURL != coord.lastBaseURL {
            coord.lastBaseURL = baseURL
            coord.updateBaseURL(baseURL)
        }

        // Deliver editor saves to the app (write file + echo suppression).
        coord.onDocumentEdited = onEdit

        // Content change — also pass config so document mode always has it
        coord.render(markdownContent, viewMode: viewMode, configJSON: pdfConfigJSON)

        // External disk change while editing: hand to JS for 3-way merge rather
        // than clobbering the live DOM.
        if diskChangeTrigger != coord.lastDiskChangeTrigger {
            coord.lastDiskChangeTrigger = diskChangeTrigger
            coord.applyDiskChange(diskChangeContent)
        }

        // Theme change
        if theme.id != coord.lastThemeID {
            coord.lastThemeID = theme.id
            coord.applyTheme(theme)
        }

        // Export triggers
        if exportTrigger != coord.lastExportTrigger {
            coord.lastExportTrigger = exportTrigger
            coord.exportPDF(filename: exportFilename)
        }
        if viewPDFTrigger != coord.lastViewPDFTrigger {
            coord.lastViewPDFTrigger = viewPDFTrigger
            coord.viewPDF(filename: exportFilename)
        }
        if printTrigger != coord.lastPrintTrigger {
            coord.lastPrintTrigger = printTrigger
            coord.printDocument()
        }

        // Search triggers
        if searchForwardTrigger != coord.lastSearchForwardTrigger {
            coord.lastSearchForwardTrigger = searchForwardTrigger
            coord.find(searchText, backwards: false)
        }
        if searchBackwardTrigger != coord.lastSearchBackwardTrigger {
            coord.lastSearchBackwardTrigger = searchBackwardTrigger
            coord.find(searchText, backwards: true)
        }
        if searchText != coord.lastSearchText {
            coord.lastSearchText = searchText
            coord.find(searchText, backwards: false, newQuery: true)
        }
    }

    final class Coordinator: NSObject, WKNavigationDelegate, WKUIDelegate, WKScriptMessageHandler {
        weak var webView: WKWebView?
        private var isLoaded = false
        private var pendingContent: String?
        private var lastRenderedContent: String = ""
        private var pendingTheme: Theme?
        private var pendingViewMode: (ViewMode, String)?
        private var pendingBaseURL: URL?
        var lastExportTrigger: Int = 0
        var lastViewPDFTrigger: Int = 0
        var lastPrintTrigger: Int = 0
        var lastSearchForwardTrigger: Int = 0
        var lastSearchBackwardTrigger: Int = 0
        var lastSearchText: String = ""
        var lastThemeID: String = ""
        var lastViewModeTrigger: Int = -1
        var lastBaseURL: URL?
        var currentViewMode: ViewMode = .reading
        var lastDiskChangeTrigger: Int = 0
        var onDocumentEdited: ((String) -> String?)?

        // Editing transcript: every editing event/outcome the JS editor logs,
        // appended to ~/Library/Logs/MarkdownPreview/editor.log so a bug report
        // can include the exact action sequence that produced it.
        private lazy var editorLogHandle: FileHandle? = {
            let dir = FileManager.default.urls(for: .libraryDirectory, in: .userDomainMask)[0]
                .appendingPathComponent("Logs/MarkdownPreview", isDirectory: true)
            try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
            let url = dir.appendingPathComponent("editor.log")
            if !FileManager.default.fileExists(atPath: url.path) {
                FileManager.default.createFile(atPath: url.path, contents: nil)
            }
            let handle = try? FileHandle(forWritingTo: url)
            handle?.seekToEndOfFile()
            return handle
        }()
        private let editorLogStamp: DateFormatter = {
            let f = DateFormatter()
            f.dateFormat = "yyyy-MM-dd HH:mm:ss.SSS"
            return f
        }()
        // Several windows append to the same editor.log; tag each line with its
        // document so the interleaved streams can be told apart.
        var docTag: String = "?"
        private func appendEditorLog(_ line: String) {
            guard let data = "\(editorLogStamp.string(from: Date())) [\(docTag)] \(line)\n".data(using: .utf8) else { return }
            editorLogHandle?.write(data)
        }

        func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
            if message.name == "editorLog" {
                if let line = message.body as? String { appendEditorLog(line) }
                return
            }
            if message.name == "consoleLog" {
                print("[JS] \(message.body)")
                return
            }
            if message.name == "documentEdited" {
                if let md = message.body as? String {
                    // The DOM is now the source of truth for this content; mark it
                    // rendered so the watcher echo of our own write can't re-render
                    // and move the cursor.
                    lastRenderedContent = md
                    // Report the write's fate back to the editor: a landed
                    // save retires its provisional baseline; a declined one
                    // (unseen disk change underneath) hands the disk content
                    // to the 3-way merge with the honest baseline restored.
                    if let disk = onDocumentEdited?(md) ?? nil,
                       let data = try? JSONEncoder().encode(disk),
                       let json = String(data: data, encoding: .utf8) {
                        webView?.evaluateJavaScript("saveDeclined(\(json))", completionHandler: nil)
                    } else {
                        webView?.evaluateJavaScript("saveLanded()", completionHandler: nil)
                    }
                }
                return
            }
            if message.name == "openLink" {
                if let href = message.body as? String, let url = URL(string: href) {
                    openExternally(url)
                }
                return
            }
            if message.name == "paginationDone" {
                // Fade in the webview now that pagination is complete
                guard let webView else { return }
                NSAnimationContext.runAnimationGroup { context in
                    context.duration = 0.15
                    webView.animator().alphaValue = 1
                }
            }
        }

        func find(_ text: String, backwards: Bool, newQuery: Bool = false) {
            guard let webView else { return }
            guard !text.isEmpty else {
                webView.evaluateJavaScript("window.getSelection().removeAllRanges()", completionHandler: nil)
                return
            }
            guard let jsonData = try? JSONEncoder().encode(text),
                  let jsonString = String(data: jsonData, encoding: .utf8) else { return }
            let clear = newQuery ? "window.getSelection().removeAllRanges();" : ""
            let js = "\(clear)window.find(\(jsonString), false, \(backwards), true)"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func applyDiskChange(_ md: String) {
            guard let webView,
                  let data = try? JSONEncoder().encode(md),
                  let json = String(data: data, encoding: .utf8) else { return }
            // markdownContent is unchanged on this path, so render() no-ops; if JS
            // merges and saves, the documentEdited echo records the merged content.
            webView.evaluateJavaScript("applyDiskChange(\(json))", completionHandler: nil)
        }

        func updateBaseURL(_ url: URL?) {
            if isLoaded {
                evaluateBaseURL(url)
            } else {
                pendingBaseURL = url
            }
        }

        private func evaluateBaseURL(_ url: URL?) {
            guard let webView, let url else { return }
            let baseHref = url.absoluteString
            guard let jsonData = try? JSONEncoder().encode(baseHref),
                  let jsonString = String(data: jsonData, encoding: .utf8) else { return }
            let js = "setBaseURL(\(jsonString))"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func applyTheme(_ theme: Theme) {
            if isLoaded {
                evaluateTheme(theme)
            } else {
                pendingTheme = theme
            }
        }

        private func evaluateTheme(_ theme: Theme) {
            guard let webView else { return }
            let darkCodeTheme = theme.darkCodeThemeFile.map { "'\($0)'" } ?? "null"
            let js = "setTheme('\(theme.cssFile)', '\(theme.codeThemeFile)', \(darkCodeTheme))"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }

        func setViewMode(_ mode: ViewMode, configJSON: String) {
            if isLoaded {
                evaluateViewMode(mode, configJSON: configJSON)
            } else {
                pendingViewMode = (mode, configJSON)
            }
        }

        private func evaluateViewMode(_ mode: ViewMode, configJSON: String) {
            guard let webView else { return }
            // Hide webview at the native layer to prevent any flash
            webView.alphaValue = 0
            if mode == .reading {
                // Allow OS appearance (dark mode) in reading view
                webView.appearance = nil
                let js = "setViewMode('reading', null)"
                webView.evaluateJavaScript(js) { _, _ in
                    // Reading mode is synchronous — restore immediately
                    NSAnimationContext.runAnimationGroup { context in
                        context.duration = 0.15
                        webView.animator().alphaValue = 1
                    }
                }
            } else {
                // Force light appearance so prefers-color-scheme: dark never matches
                webView.appearance = NSAppearance(named: .aqua)
                // Document mode: JS will post paginationDone message when ready
                let js = "setViewMode('document', \(configJSON))"
                webView.evaluateJavaScript(js, completionHandler: nil)
            }
        }

        func exportPDF(filename: String) {
            guard let webView else { return }
            PagedPDFCapture.capture(webView: webView) { data in
                guard let data else { return }
                let panel = NSSavePanel()
                panel.allowedContentTypes = [.pdf]
                panel.nameFieldStringValue = filename + ".pdf"
                panel.canCreateDirectories = true
                if panel.runModal() == .OK, let url = panel.url {
                    try? data.write(to: url)
                }
            }
        }

        func viewPDF(filename: String) {
            guard let webView else { return }
            PagedPDFCapture.capture(webView: webView) { data in
                guard let data else { return }
                let url = FileManager.default.temporaryDirectory
                    .appendingPathComponent(filename + ".pdf")
                try? data.write(to: url)
                NSWorkspace.shared.open(url)
            }
        }

        func printDocument() {
            guard let webView, currentViewMode == .document else { return }
            PagedPDFCapture.capture(webView: webView) { data in
                guard let data, let pdfDoc = PDFDocument(data: data) else { return }
                let printOp = pdfDoc.printOperation(for: NSPrintInfo.shared, scalingMode: .pageScaleToFit, autoRotate: true)
                printOp?.showsPrintPanel = true
                printOp?.showsProgressPanel = true
                printOp?.run()
            }
        }

        func render(_ content: String, viewMode: ViewMode = .reading, configJSON: String = "{}") {
            guard content != lastRenderedContent else { return }
            lastRenderedContent = content
            if isLoaded {
                // Ensure JS has the current config before rendering
                if viewMode == .document {
                    webView?.evaluateJavaScript("_currentConfig = \(configJSON)", completionHandler: nil)
                }
                evaluateRender(content)
            } else {
                pendingContent = content
            }
        }

        // Every link open goes to the system, never the webview: the JS layer
        // intercepts clicks (it is the only path that can offer Cmd+click
        // inside editable blocks, where no navigation ever fires) and posts
        // openLink; this policy check is the safety net for any link that
        // still starts a navigation, which would otherwise replace the
        // rendered document with no way back.
        func webView(_ webView: WKWebView, decidePolicyFor navigationAction: WKNavigationAction,
                     decisionHandler: @escaping (WKNavigationActionPolicy) -> Void) {
            if navigationAction.navigationType == .linkActivated, let url = navigationAction.request.url {
                // Same-document fragment jumps stay in the webview.
                let strip = { (u: URL) in u.absoluteString.split(separator: "#", maxSplits: 1)[0] }
                if let current = webView.url, strip(url) == strip(current) {
                    decisionHandler(.allow)
                    return
                }
                decisionHandler(.cancel)
                openExternally(url)
                return
            }
            decisionHandler(.allow)
        }

        private func openExternally(_ url: URL) {
            guard let scheme = url.scheme?.lowercased(),
                  ["http", "https", "mailto", "file"].contains(scheme) else { return }
            NSWorkspace.shared.open(url)
        }

        func webView(_ webView: WKWebView, didFinish navigation: WKNavigation!) {
            isLoaded = true
            if let url = pendingBaseURL {
                pendingBaseURL = nil
                evaluateBaseURL(url)
            }
            if let (mode, config) = pendingViewMode {
                pendingViewMode = nil
                evaluateViewMode(mode, configJSON: config)
            }
            if let theme = pendingTheme {
                pendingTheme = nil
                evaluateTheme(theme)
            }
            if let content = pendingContent {
                pendingContent = nil
                evaluateRender(content)
            }
        }

        private func evaluateRender(_ content: String) {
            guard let webView else { return }
            guard let jsonData = try? JSONEncoder().encode(content),
                  let jsonString = String(data: jsonData, encoding: .utf8) else { return }
            let js = "renderMarkdown(\(jsonString))"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }
}
