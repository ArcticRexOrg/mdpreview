import WebKit
import PDFKit

/// Turns a webview showing Paged.js output into a PDF.
///
/// `WKWebView.createPDF` paginates on its own — pages of arbitrary height cut
/// wherever the rect happens to end — so the Paged.js page boxes would be
/// sliced across PDF pages. Instead each `.pagedjs_page` is captured on its
/// own and the single-page results are merged, so a PDF page is exactly a
/// laid-out page. Shared by the on-screen document mode and the headless
/// AppleScript export, which must produce byte-identical output.
enum PagedPDFCapture {

    /// Capture each Paged.js page individually and merge into one PDF.
    /// Calls back with nil when the document holds no paginated pages.
    static func capture(webView: WKWebView, completion: @escaping (Data?) -> Void) {
        // Get bounding rects of all .pagedjs_page elements
        let js = """
        (function(){
            var pages = document.querySelectorAll('.pagedjs_page');
            if (!pages.length) return null;
            // Remove visual gaps for clean capture
            var container = document.querySelector('.pagedjs_pages');
            if (container) container.style.padding = '0';
            pages.forEach(function(p){ p.style.marginBottom = '0'; p.style.boxShadow = 'none'; });
            var rects = [];
            pages.forEach(function(p){
                var r = p.getBoundingClientRect();
                rects.push({x: r.x, y: r.y + window.scrollY, w: r.width, h: r.height});
            });
            return JSON.stringify(rects);
        })()
        """
        webView.evaluateJavaScript(js) { result, _ in
            guard let jsonStr = result as? String,
                  let jsonData = jsonStr.data(using: .utf8),
                  let rects = try? JSONSerialization.jsonObject(with: jsonData) as? [[String: Double]] else {
                completion(nil)
                return
            }

            let pageRects = rects.compactMap { dict -> CGRect? in
                guard let x = dict["x"], let y = dict["y"],
                      let w = dict["w"], let h = dict["h"] else { return nil }
                return CGRect(x: x, y: y, width: w, height: h)
            }

            guard !pageRects.isEmpty else {
                completion(nil)
                return
            }

            capturePages(webView: webView, rects: pageRects, index: 0, document: PDFDocument()) { mergedDoc in
                // Restore visual gaps
                let restore = """
                (function(){
                    var c = document.querySelector('.pagedjs_pages');
                    if (c) c.style.padding = '';
                    document.querySelectorAll('.pagedjs_page').forEach(function(p){
                        p.style.marginBottom = '';
                        p.style.boxShadow = '';
                    });
                })()
                """
                webView.evaluateJavaScript(restore, completionHandler: nil)
                completion(mergedDoc.dataRepresentation())
            }
        }
    }

    private static func capturePages(webView: WKWebView, rects: [CGRect], index: Int, document: PDFDocument, completion: @escaping (PDFDocument) -> Void) {
        guard index < rects.count else {
            completion(document)
            return
        }
        let config = WKPDFConfiguration()
        config.rect = rects[index]
        webView.createPDF(configuration: config) { result in
            if case .success(let data) = result,
               let pagePDF = PDFDocument(data: data),
               let page = pagePDF.page(at: 0) {
                document.insert(page, at: document.pageCount)
            }
            capturePages(webView: webView, rects: rects, index: index + 1, document: document, completion: completion)
        }
    }
}
