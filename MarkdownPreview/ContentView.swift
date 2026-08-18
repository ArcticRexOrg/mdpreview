import SwiftUI

@MainActor
final class AppState: ObservableObject {
    @Published var rootNodes: [FileNode] = []
    @Published var rootDirectoryName: String = ""
    @Published var selectedFile: URL? {
        didSet { onSelectionChanged() }
    }
    @Published var markdownContent: String = ""
    @Published var exportPDFTrigger: Int = 0
    @Published var viewPDFTrigger: Int = 0
    @Published var printTrigger: Int = 0
    @Published var currentTheme: Theme = Theme.all[0]
    @Published var showSearch: Bool = false
    @Published var searchText: String = ""
    @Published var searchForwardTrigger: Int = 0
    @Published var searchBackwardTrigger: Int = 0
    @Published var viewMode: ViewMode = .reading
    @Published var viewModeTrigger: Int = 0
    @Published var pdfConfig: PDFConfig = PDFConfig.load()
    @Published var diskChangeContent: String = ""
    @Published var diskChangeTrigger: Int = 0

    /// The exact text we last wrote to disk from the editor. Used to recognise
    /// (and ignore) the file-watcher event our own write produces.
    private var lastSavedFromEditor: String?

    func exportPDF() { exportPDFTrigger += 1 }
    func viewPDF() { viewPDFTrigger += 1 }
    func printDocument() { printTrigger += 1 }
    func findNext() { searchForwardTrigger += 1 }
    func findPrevious() { searchBackwardTrigger += 1 }

    func toggleViewMode() {
        viewMode = viewMode == .reading ? .document : .reading
        if viewMode == .document {
            // Re-read config so edits take effect immediately
            pdfConfig = PDFConfig.load()
        }
        viewModeTrigger += 1
    }

    var resolvedPDFConfigJSON: String {
        let title = selectedFile?.deletingPathExtension().lastPathComponent ?? "Untitled"
        let formatter = DateFormatter()
        formatter.dateStyle = .long
        let date = formatter.string(from: Date())
        return pdfConfig.resolvedJSON(title: title, date: date)
    }

    private let watcher = FileWatcher()
    private let defaultRootURL = URL(fileURLWithPath:
        ProcessInfo.processInfo.environment["MDPREVIEW_ROOT"]
            ?? FileManager.default.currentDirectoryPath
    )

    init(initialURL: URL? = nil) {
        if let url = initialURL {
            let dir = url.deletingLastPathComponent()
            rootDirectoryName = dir.lastPathComponent
            rootNodes = FileNode.loadChildren(of: dir)
            _claimedURL = url
        } else {
            rootDirectoryName = defaultRootURL.lastPathComponent
            rootNodes = FileNode.loadChildren(of: defaultRootURL)
        }
        watcher.onChange = { [weak self] in
            self?.onExternalChange()
        }
        NotificationCenter.default.addObserver(forName: .showSearch, object: nil, queue: .main) { [weak self] _ in
            self?.showSearch = true
        }
        NotificationCenter.default.addObserver(forName: .printDocument, object: nil, queue: .main) { [weak self] _ in
            self?.printDocument()
        }
        // Deferred so didSet fires after init completes
        if let url = _claimedURL {
            DispatchQueue.main.async { self.selectedFile = url }
        }
    }
    private var _claimedURL: URL?

    func openFile(_ url: URL) {
        let dir = url.deletingLastPathComponent()
        rootDirectoryName = dir.lastPathComponent
        rootNodes = FileNode.loadChildren(of: dir)
        selectedFile = url
    }

    private func onSelectionChanged() {
        reloadCurrentFile()
        if let url = selectedFile {
            watcher.watch(url: url)
        } else {
            watcher.stop()
        }
    }

    /// Full (re)load triggered by selecting a file. Pushes content through the
    /// normal render path and establishes the in-sync baseline.
    private func reloadCurrentFile() {
        guard let url = selectedFile,
              let content = try? String(contentsOf: url, encoding: .utf8) else {
            markdownContent = ""
            return
        }
        markdownContent = content
        lastSavedFromEditor = content
    }

    /// The file watcher fired. Ignore our own write echo; otherwise route a
    /// genuine external change to the editor's 3-way merge (reading mode) or a
    /// plain reload (document mode).
    private func onExternalChange() {
        guard let url = selectedFile,
              let disk = try? String(contentsOf: url, encoding: .utf8) else { return }
        if EditorSync.shouldIgnoreReload(disk: disk, lastSaved: lastSavedFromEditor) { return }
        if viewMode == .reading {
            lastSavedFromEditor = disk
            diskChangeContent = disk
            diskChangeTrigger += 1
        } else {
            lastSavedFromEditor = disk
            markdownContent = disk
        }
    }

    /// Persist an edit made in the rendered view. Writing is what produces the
    /// watcher echo that `onExternalChange` then ignores via `lastSavedFromEditor`.
    ///
    /// Returns nil when the write landed. When the disk holds a change the
    /// watcher has not yet delivered (its callback lags the actual write),
    /// writing blind would clobber the other writer — and the echo
    /// suppression would then swallow their change without a trace. Decline
    /// instead and return the disk content; the caller hands it to the
    /// editor's 3-way merge, whose result comes back as a fresh save. The
    /// read-compare-write here still has a window, but microseconds instead
    /// of the watcher's latency.
    func saveEditedContent(_ md: String) -> String? {
        guard let url = selectedFile else { return nil }
        if let disk = try? String(contentsOf: url, encoding: .utf8),
           disk != lastSavedFromEditor, disk != md {
            lastSavedFromEditor = disk
            markdownContent = md
            return disk
        }
        lastSavedFromEditor = md
        // Keep the SwiftUI source of truth at the editor's state: leaving it
        // at the load-time snapshot meant any later updateNSView pass (a
        // theme change, an external diskChangeTrigger) re-rendered the STALE
        // snapshot over the live document — wiping in-flight typing and
        // resetting the dirty flag, so the following disk merge ran as
        // "idle" and took the disk wholesale. The coordinator's own echo
        // guard (lastRenderedContent, already advanced by documentEdited)
        // makes this assignment render-neutral.
        markdownContent = md
        try? md.write(to: url, atomically: true, encoding: .utf8)
        return nil
    }
}

struct ContentView: View {
    @StateObject private var state: AppState
    @Environment(\.openWindow) private var openWindow

    init(initialURL: URL? = nil) {
        _state = StateObject(wrappedValue: AppState(initialURL: initialURL))
    }

    var body: some View {
        NavigationSplitView {
            FileTreeView(nodes: state.rootNodes, selectedFile: $state.selectedFile, directoryName: state.rootDirectoryName)
                .navigationSplitViewColumnWidth(min: 200, ideal: 260, max: 400)
        } detail: {
            if state.selectedFile != nil {
                ZStack(alignment: .bottom) {
                    MarkdownWebView(
                        markdownContent: state.markdownContent,
                        exportTrigger: state.exportPDFTrigger,
                        viewPDFTrigger: state.viewPDFTrigger,
                        printTrigger: state.printTrigger,
                        exportFilename: state.selectedFile?.deletingPathExtension().lastPathComponent ?? "document",
                        theme: state.currentTheme,
                        searchText: state.searchText,
                        searchForwardTrigger: state.searchForwardTrigger,
                        searchBackwardTrigger: state.searchBackwardTrigger,
                        viewMode: state.viewMode,
                        pdfConfigJSON: state.resolvedPDFConfigJSON,
                        viewModeTrigger: state.viewModeTrigger,
                        baseURL: state.selectedFile?.deletingLastPathComponent(),
                        diskChangeContent: state.diskChangeContent,
                        diskChangeTrigger: state.diskChangeTrigger,
                        onEdit: { state.saveEditedContent($0) }
                    )
                    if state.showSearch {
                        SearchBar(
                            text: $state.searchText,
                            onNext: state.findNext,
                            onPrevious: state.findPrevious,
                            onClose: {
                                state.showSearch = false
                                state.searchText = ""
                            }
                        )
                        .transition(.move(edge: .bottom).combined(with: .opacity))
                    }
                }
                .animation(.easeInOut(duration: 0.15), value: state.showSearch)
                .toolbar(id: "main") {
                    ToolbarItem(id: "mode") {
                        Picker("Mode", selection: Binding(
                            get: { state.viewMode },
                            set: { newMode in
                                state.viewMode = newMode
                                if newMode == .document {
                                    state.pdfConfig = PDFConfig.load()
                                }
                                state.viewModeTrigger += 1
                            }
                        )) {
                            ForEach(ViewMode.allCases) { mode in
                                Label(mode.label, systemImage: mode.icon).tag(mode)
                            }
                        }
                        .pickerStyle(.segmented)
                        .help("Switch between Reading and Document mode")
                    }
                    ToolbarItem(id: "search") {
                        Button {
                            withAnimation { state.showSearch.toggle() }
                            if !state.showSearch { state.searchText = "" }
                        } label: {
                            Label("Find", systemImage: "magnifyingglass")
                        }
                    }
                    ToolbarItem(id: "theme") {
                        Picker("Theme", selection: $state.currentTheme) {
                            ForEach(Theme.all) { theme in
                                Text(theme.name).tag(theme)
                            }
                        }
                        .pickerStyle(.menu)
                        .help("Switch theme")
                    }
                    ToolbarItem(id: "viewpdf") {
                        Button {
                            state.viewPDF()
                        } label: {
                            Label("View PDF", systemImage: "eye.fill")
                        }
                        .opacity(state.viewMode == .document ? 1 : 0)
                        .disabled(state.viewMode != .document)
                    }
                    ToolbarItem(id: "savepdf") {
                        Button {
                            state.exportPDF()
                        } label: {
                            Label("Save PDF", systemImage: "arrow.down.doc")
                        }
                        .opacity(state.viewMode == .document ? 1 : 0)
                        .disabled(state.viewMode != .document)
                    }
                    ToolbarItem(id: "print") {
                        Button {
                            state.printDocument()
                        } label: {
                            Label("Print", systemImage: "printer")
                        }
                        .opacity(state.viewMode == .document ? 1 : 0)
                        .disabled(state.viewMode != .document)
                    }
                }
            } else {
                ContentUnavailableView(
                    "No file selected",
                    systemImage: "doc.text",
                    description: Text("Select a Markdown file from the sidebar")
                )
            }
        }
        .navigationTitle(state.selectedFile?.lastPathComponent ?? "MarkdownPreview")
    }
}
