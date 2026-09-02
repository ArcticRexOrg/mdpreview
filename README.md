# MarkdownPreview

A lightweight macOS Markdown viewer that auto-refreshes when files change on disk.

## Why this exists

Claude Code is great for working with text documents, and Markdown is a natural output format — but proofreading rendered Markdown is a pain. Reading raw markup in the terminal is rough. Opening an IDE is heavyweight and brings in a lot of noise. Something like Obsidian can render it, but presupposes a whole vault structure when you just want to view one file. And most of these tools won't automatically update when an external process edits the file.

MarkdownPreview fills that gap: a viewer you can leave open on one side of your screen while you work in a terminal on the other. When Claude (or anything else) writes to a `.md` file, the preview updates immediately. No manual reload, no project scaffolding, no overhead.

Pair it with PDF export and configurable templates, and you can go from a rough draft to print-ready professional output in one sitting.

## Features

- **Auto-reload** — watches files for changes and refreshes the preview instantly
- **File tree navigation** — browse directories and select Markdown files from a sidebar
- **Live preview** — rendered in WebKit with 6 built-in themes (GitHub, Water, Sakura, Simple, Splendor, Air)
- **Document mode** — print-optimized paginated layout using Paged.js, with headers, footers, and logo placement
- **PDF export** — configurable page size, margins, headers/footers, and company branding
- **AppleScript** — render Markdown to PDF from a script or the shell, without opening a window
- **Find in document** — Cmd+F search with forward/backward navigation
- **Syntax highlighting** — code blocks highlighted via Highlight.js

## Requirements

- macOS 14.0 (Sonoma) or later
- Xcode 16+

## Build

```bash
make build      # compile
make install    # build and install to /Applications
make open       # install and launch
make clean      # clean derived data
```

## Usage

Open the app and select a Markdown file from the file tree, or open a `.md` file directly — MarkdownPreview registers as a viewer for Markdown files.

Set `MDPREVIEW_ROOT` to control the default browsing directory.

PDF export settings are stored in `~/Library/Application Support/MarkdownPreview/pdf.json`.

## Scripting

MarkdownPreview is scriptable, so a build script or a batch job can produce the same PDF the Save PDF button does — same page setup from `pdf.json`, same Paged.js layout — rendered off-screen, without disturbing any open window.

```applescript
tell application "MarkdownPreview"
    export "/Users/me/notes/report.md" to "/Users/me/notes/report.pdf"
end tell
```

From the shell:

```bash
osascript -e 'tell application "MarkdownPreview" to export "/path/to/report.md"'
```

- The direct parameter and `to` take an absolute POSIX path or a file reference (`POSIX file "…"`, an alias).
- `to` is optional; it defaults to the Markdown file with a `.pdf` extension.
- `theme` is optional and takes a theme name — GitHub (the default), Water, Sakura, Simple, Splendor or Air.
- The result is the POSIX path of the PDF that was written; failures come back as AppleScript errors.

```applescript
export POSIX file "/path/report.md" to POSIX file "/path/report.pdf" theme "Sakura"
```

The full dictionary is in Script Editor (File ▸ Open Dictionary ▸ MarkdownPreview).
