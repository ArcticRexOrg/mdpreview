import Foundation

struct Theme: Identifiable, Hashable {
    let id: String
    let name: String
    let cssFile: String
    let codeThemeFile: String
    // For page themes that follow prefers-color-scheme: the highlight.js
    // stylesheet to use when the appearance is dark. Without it, dark mode
    // pairs a dark page with light-theme code colors — near-invisible text.
    // nil for fixed-appearance themes (and water, whose code theme is
    // already dark).
    let darkCodeThemeFile: String?

    static let all: [Theme] = [
        Theme(id: "github",   name: "GitHub",   cssFile: "github-markdown.min.css", codeThemeFile: "highlight-github.min.css", darkCodeThemeFile: "highlight-dark.min.css"),
        Theme(id: "water",    name: "Water",    cssFile: "theme-water.css",          codeThemeFile: "highlight-dark.min.css",   darkCodeThemeFile: nil),
        Theme(id: "sakura",   name: "Sakura",   cssFile: "theme-sakura.css",         codeThemeFile: "highlight-github.min.css", darkCodeThemeFile: nil),
        Theme(id: "simple",   name: "Simple",   cssFile: "theme-simple.css",         codeThemeFile: "highlight-github.min.css", darkCodeThemeFile: "highlight-dark.min.css"),
        Theme(id: "splendor", name: "Splendor", cssFile: "theme-splendor.css",       codeThemeFile: "highlight-github.min.css", darkCodeThemeFile: nil),
        Theme(id: "air",      name: "Air",      cssFile: "theme-air.css",            codeThemeFile: "highlight-github.min.css", darkCodeThemeFile: nil),
    ]
}
