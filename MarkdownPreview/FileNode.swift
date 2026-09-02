import Foundation

@MainActor
final class FileNode: Identifiable, ObservableObject {
    let url: URL
    var name: String { url.lastPathComponent }
    let isDirectory: Bool

    @Published var children: [FileNode]?
    @Published var isExpanded: Bool = false

    nonisolated var id: URL { url }

    init(url: URL, isDirectory: Bool) {
        self.url = url
        self.isDirectory = isDirectory
    }

    func loadChildrenIfNeeded() {
        guard isDirectory, children == nil else { return }
        children = Self.loadChildren(of: url)
    }

    static func loadChildren(of url: URL) -> [FileNode] {
        scan(url).map { FileNode(url: $0.url, isDirectory: $0.isDirectory) }
    }

    /// What a directory contributes to the tree, as plain values so the walk
    /// can run off the main thread — `containsMarkdown` descends a whole
    /// subtree per candidate directory, which on a large root costs tens of
    /// seconds, and the main thread is where the rendered view and the
    /// scripted PDF export both have to run.
    nonisolated static func scan(_ url: URL) -> [(url: URL, isDirectory: Bool)] {
        let fm = FileManager.default
        guard let entries = try? fm.contentsOfDirectory(
            at: url,
            includingPropertiesForKeys: [.isDirectoryKey, .isHiddenKey],
            options: [.skipsHiddenFiles]
        ) else { return [] }

        var found: [(url: URL, isDirectory: Bool)] = []
        for entry in entries {
            let isDir = (try? entry.resourceValues(forKeys: [.isDirectoryKey]).isDirectory) ?? false
            if isDir {
                // Only include directories that contain at least one .md file (recursively)
                if containsMarkdown(url: entry) {
                    found.append((entry, true))
                }
            } else if entry.pathExtension.lowercased() == "md" {
                found.append((entry, false))
            }
        }

        return found.sorted { a, b in
            if a.isDirectory != b.isDirectory { return a.isDirectory }
            return a.url.lastPathComponent.localizedCaseInsensitiveCompare(b.url.lastPathComponent) == .orderedAscending
        }
    }

    /// Directories with no Markdown anywhere under them are left out of the
    /// tree. Finding one is cheap; proving there is none costs the whole
    /// subtree, so the search gives up after `searchLimit` entries and keeps
    /// the directory. Unbounded, a root like `/` — which is what a launch
    /// from a script inherits as its working directory — walks the disk.
    nonisolated private static func containsMarkdown(url: URL) -> Bool {
        let fm = FileManager.default
        guard let enumerator = fm.enumerator(
            at: url,
            includingPropertiesForKeys: [.isRegularFileKey],
            options: [.skipsHiddenFiles]
        ) else { return false }
        var examined = 0
        for case let fileURL as URL in enumerator {
            if fileURL.pathExtension.lowercased() == "md" { return true }
            examined += 1
            if examined >= searchLimit { return true }
        }
        return false
    }

    /// Entries to look at before giving a directory the benefit of the doubt.
    /// Generous for a project directory, bounded for a filesystem.
    private static let searchLimit = 2000
}
