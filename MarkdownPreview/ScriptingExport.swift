import AppKit

/// `export <markdown file> to <pdf file> [theme <name>]`
///
/// The scripted counterpart of the Save PDF button, rendering off-screen so a
/// script can convert files without the app showing (or disturbing) a
/// document window. Page size, margins, headers, footers and branding come
/// from the same `pdf.json` the on-screen export uses, read at call time.
@objc(ExportPDFCommand)
final class ExportPDFCommand: NSScriptCommand {

    override func performDefaultImplementation() -> Any? {
        let source: URL
        do {
            source = try Self.fileURL(from: directParameter, label: "the file to export")
        } catch {
            return fail(error.localizedDescription)
        }

        guard FileManager.default.fileExists(atPath: source.path) else {
            return fail("There is no file at \(source.path).")
        }

        let destination: URL
        if let raw = evaluatedArguments?["Destination"] {
            do {
                destination = try Self.fileURL(from: raw, label: "the destination")
            } catch {
                return fail(error.localizedDescription)
            }
        } else {
            destination = source.deletingPathExtension().appendingPathExtension("pdf")
        }

        let theme: Theme
        if let name = evaluatedArguments?["Theme"] as? String {
            guard let match = Self.theme(named: name) else {
                let names = Theme.all.map(\.name).joined(separator: ", ")
                return fail("\"\(name)\" is not a MarkdownPreview theme. Choose one of: \(names).")
            }
            theme = match
        } else {
            theme = Theme.all[0]
        }

        // Rendering is a webview round-trip; hold the Apple Event open until
        // the PDF exists rather than replying before there is a file.
        suspendExecution()
        MainActor.assumeIsolated {
            HeadlessPDFRenderer.render(url: source, theme: theme, config: PDFConfig.load()) { [weak self] result in
                guard let self else { return }
                switch result {
                case .success(let data):
                    do {
                        try data.write(to: destination)
                        self.resumeExecution(withResult: destination.path)
                    } catch {
                        self.fail("Can't write \(destination.path): \(error.localizedDescription)")
                        self.resumeExecution(withResult: nil)
                    }
                case .failure(let error):
                    self.fail(error.localizedDescription)
                    self.resumeExecution(withResult: nil)
                }
            }
        }
        return nil
    }

    // MARK: - Arguments

    /// Accepts what a script is likely to hand over: a `file`/alias (arriving
    /// as an NSURL), a POSIX path string — the natural form from a shell — or
    /// a raw descriptor.
    private static func fileURL(from argument: Any?, label: String) throws -> URL {
        switch argument {
        case let url as URL:
            return url.standardizedFileURL
        case let string as String:
            let expanded = NSString(string: string).expandingTildeInPath
            guard expanded.hasPrefix("/") else {
                throw ScriptingArgumentError("\(label) must be an absolute POSIX path or a file reference, not \"\(string)\".")
            }
            return URL(fileURLWithPath: expanded).standardizedFileURL
        case let descriptor as NSAppleEventDescriptor:
            guard let coerced = descriptor.coerce(toDescriptorType: DescType(typeFileURL)),
                  let url = URL(dataRepresentation: coerced.data, relativeTo: nil) else {
                throw ScriptingArgumentError("\(label) is not a file.")
            }
            return url.standardizedFileURL
        default:
            throw ScriptingArgumentError("Specify \(label).")
        }
    }

    private static func theme(named name: String) -> Theme? {
        let wanted = name.lowercased()
        return Theme.all.first { $0.id.lowercased() == wanted || $0.name.lowercased() == wanted }
    }

    @discardableResult
    private func fail(_ message: String) -> Any? {
        scriptErrorNumber = Int(errOSAGeneralError)
        scriptErrorString = message
        return nil
    }
}

private struct ScriptingArgumentError: LocalizedError {
    let message: String
    init(_ message: String) { self.message = message }
    var errorDescription: String? { message }
}
