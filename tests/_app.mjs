// Loads the real editing engine from template.html into jsdom — the same
// harness template-integration.test.mjs uses, factored out so the law suite can
// drive the *app* path rather than editor-core in isolation.
//
// Why it matters: the bug that started this (blocks reverting on every save)
// lives in flushActive/flushSegment in template.html, not in editor-core. A law
// asserted at the core level would have missed it. Here we can assert on the
// exact instrumentation stream the shipping app writes to editor.log, so a
// green suite and a clean production log mean the same thing.
//
// Limitation to keep in mind: jsdom does not implement contenteditable, so the
// browser's own text insertion never happens. Tests that need an edit simulate
// WebKit's DOM mutation directly and then run the real reconcile path.
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { core, marked } from './_setup.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const templateHtml = readFileSync(join(here, '../MarkdownPreview/Resources/template.html'), 'utf8');
const scriptSrc = (templateHtml.match(/<script>([\s\S]*?)<\/script>/g) || [])
  .map((b) => b.replace(/^<script>/, '').replace(/<\/script>$/, ''))
  .find((s) => s.includes('marked.use'));

export async function app(md) {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="content" class="markdown-body"></div></body>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.EditorCore = core;
  win.marked = marked;
  win.hljs = { highlightElement() {} };
  win.mermaid = { initialize() {}, parse() { return Promise.resolve(true); }, render() { return Promise.resolve({ svg: '' }); } };
  win.Paged = { Previewer: function () { this.preview = () => Promise.resolve({}); } };
  win.matchMedia = win.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  win.scrollTo = () => {};
  const log = [];
  let saved = null;
  win.webkit = { messageHandlers: {
    documentEdited: { postMessage(m) { saved = m; } },
    paginationDone: { postMessage() {} },
    editorLog: { postMessage(m) { log.push(m); } },
  } };
  win.eval(scriptSrc);
  win._rawMarkdown = md;
  win._baseMarkdown = md;
  await win.renderReading();
  return {
    win,
    doc: win.document,
    log,                                  // the editor.log stream, verbatim
    saved: () => saved,                   // last bytes posted to the save handler
    md: () => win.currentMarkdown(),
    segs: () => Array.from(win.document.querySelectorAll('#content [data-seg]')),
    editableSegs: () => Array.from(win.document.querySelectorAll('#content [data-seg][contenteditable="true"]')),
  };
}
