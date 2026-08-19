import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { core, marked } from './_setup.mjs';

// Integration tests for the editing handlers that live in template.html. We
// load the page's inline editing script into jsdom with the real EditorCore +
// marked, then drive list edits the way WKWebView would: place a caret and
// dispatch the same beforeinput / keydown events the app handles. Structural
// ops preventDefault and re-render synchronously, so we can read the resulting
// document straight back out of currentMarkdown().

const here = dirname(fileURLToPath(import.meta.url));
const templateHtml = readFileSync(join(here, '../MarkdownPreview/Resources/template.html'), 'utf8');
// The big inline script (the one that calls marked.use).
const scriptSrc = (templateHtml.match(/<script>([\s\S]*?)<\/script>/g) || [])
  .map((b) => b.replace(/^<script>/, '').replace(/<\/script>$/, ''))
  .find((s) => s.includes('marked.use'));

async function setup(md) {
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
  let saved = null;
  const log = [];
  const opened = [];
  win.webkit = { messageHandlers: {
    documentEdited: { postMessage(m) { saved = m; } },
    paginationDone: { postMessage() {} },
    editorLog: { postMessage(m) { log.push(m); } },
    openLink: { postMessage(m) { opened.push(m); } },
  } };
  win.eval(scriptSrc);
  win._rawMarkdown = md;
  win._baseMarkdown = md;
  await win.renderReading(); // await so editing listeners (bound after the await) are live
  return {
    win, doc: win.document, log, opened,
    seg: () => win.document.querySelector('#content [data-seg]'),
    md: () => win.currentMarkdown(),
    saved: () => saved,
  };
}

// Place a collapsed caret. `where` is { text, at } (in a text node containing
// `text`, at char offset `at`) or { liEmpty:n } (in the n-th empty <li>).
function caret(win, where) {
  const doc = win.document, sel = win.getSelection(), r = doc.createRange();
  if (where.liEmpty != null) {
    const li = Array.from(doc.querySelectorAll('li')).filter((e) => e.textContent === '')[where.liEmpty];
    r.setStart(li, 0);
  } else {
    const walk = doc.createTreeWalker(doc.getElementById('content'), win.NodeFilter.SHOW_TEXT);
    let n, node = null;
    while ((n = walk.nextNode())) { if (n.textContent.includes(where.text)) { node = n; break; } }
    r.setStart(node, where.at);
  }
  r.collapse(true);
  sel.removeAllRanges(); sel.addRange(r);
}

function beforeInput(win, inputType, data) {
  const ev = new win.InputEvent('beforeinput', { inputType, data: data ?? null, bubbles: true, cancelable: true });
  const a = win.getSelection().anchorNode;
  (a.nodeType === 1 ? a : a.parentNode).dispatchEvent(ev);
  return ev;
}
function pressTab(win, shift) {
  const ev = new win.KeyboardEvent('keydown', { key: 'Tab', shiftKey: !!shift, bubbles: true, cancelable: true });
  (win.getSelection().anchorNode.nodeType === 1 ? win.getSelection().anchorNode : win.getSelection().anchorNode.parentNode)
    .dispatchEvent(ev);
}

test('Return at the end of a list item creates a new item', async () => {
  const t = await setup('- one\n- two\n');
  caret(t.win, { text: 'two', at: 3 }); // end of "two"
  beforeInput(t.win, 'insertParagraph');
  assert.equal(t.md(), '- one\n- two\n-'); // bare-bullet empty item (renders 3 bullets)
});

test('frontmatter renders as a read-only metadata panel without changing source', async () => {
  const md = '---\nname: get-moving\ndescription: >-\n  Lead <decisively> & safely.\n---\n\n# Get Moving\n';
  const t = await setup(md);
  const panel = t.doc.querySelector('.frontmatter');
  const segment = panel && panel.closest('[data-seg]');

  assert.ok(panel, 'frontmatter panel should be present');
  assert.match(panel.textContent, /Frontmatter/);
  assert.match(panel.textContent, /name: get-moving/);
  assert.match(panel.textContent, /Lead <decisively> & safely\./);
  assert.equal(panel.querySelector('decisively'), null, 'YAML-looking HTML must render as text');
  assert.equal(segment.getAttribute('contenteditable'), 'true', 'frontmatter edits as opaque text');
  assert.equal(panel.querySelector('.frontmatter-label').getAttribute('contenteditable'), 'false', 'the label does not');
  assert.equal(t.doc.querySelector('.frontmatter hr'), null);
  assert.equal(t.doc.querySelector('.frontmatter h2'), null);
  assert.equal(t.doc.querySelector('h1').textContent, 'Get Moving');
  assert.equal(t.md(), md);
});

test('document rendering uses the same frontmatter presentation', async () => {
  const md = '---\nname: doc\n---\n\n# Title\n';
  const t = await setup(md);
  const scratch = t.doc.createElement('div');
  scratch.innerHTML = t.win.renderDocumentMarkdown(md);

  assert.ok(scratch.querySelector('.frontmatter'));
  assert.equal(scratch.querySelector('.frontmatter').textContent.includes('name: doc'), true);
  assert.equal(scratch.querySelector('hr'), null);
  assert.equal(scratch.querySelector('h2'), null);
  assert.equal(scratch.querySelector('h1').textContent, 'Title');
});

test('Backspace at the start of an item merges it into the previous one', async () => {
  const t = await setup('- one\n- two\n');
  caret(t.win, { text: 'two', at: 0 });
  beforeInput(t.win, 'deleteContentBackward');
  assert.equal(t.md(), '- onetwo\n');
});

test('Backspace at the start of the first item outdents it to a paragraph', async () => {
  const t = await setup('- one\n- two\n');
  caret(t.win, { text: 'one', at: 0 });
  beforeInput(t.win, 'deleteContentBackward');
  assert.equal(t.md(), 'one\n\n- two\n');
});

test('Tab nests a list item; Shift+Tab unnests it', async () => {
  const t = await setup('- one\n- two\n');
  caret(t.win, { text: 'two', at: 1 });
  pressTab(t.win, false);
  assert.equal(t.md(), '- one\n  - two\n');
  caret(t.win, { text: 'two', at: 1 });
  pressTab(t.win, true);
  assert.equal(t.md(), '- one\n- two\n');
});

test('Return on an empty item exits the list (empty bullet dropped)', async () => {
  const t = await setup('- one\n- \n');
  caret(t.win, { liEmpty: 0 }); // the empty second item
  beforeInput(t.win, 'insertParagraph');
  // The empty bullet is gone; a transient blank line holds the caret.
  assert.equal(t.md(), '- one');
});

test('typing into a freshly created empty item folds into the list', async () => {
  const t = await setup('- one\n- two\n');
  caret(t.win, { text: 'two', at: 3 });
  beforeInput(t.win, 'insertParagraph'); // -> "- one\n- two\n- \n", caret in empty item
  beforeInput(t.win, 'insertText', 'x');
  assert.equal(t.md(), '- one\n- two\n- x');
});

test('Enter then Tab at the end of the last item nests it without a heading', async () => {
  const t = await setup('- one\n- two\n\nAfter.\n');
  caret(t.win, { text: 'two', at: 3 });   // end of last item
  beforeInput(t.win, 'insertParagraph');  // new empty item
  pressTab(t.win, false);                 // nest it
  const md = t.md();
  assert.equal(md, '- one\n- two\n  *\n\nAfter.\n');
  assert.ok(!/<h[1-6]/.test(marked.parse(md)), '"After." must not become a heading');
});

test('Exiting a list keeps the blank line before a following paragraph', async () => {
  const t = await setup('- a\n- b\n\nAfter.\n');
  caret(t.win, { text: 'b', at: 1 });      // end of last item
  beforeInput(t.win, 'insertParagraph');   // new empty item
  beforeInput(t.win, 'insertParagraph');   // Return on empty item -> exit
  const md = t.md();
  assert.equal(md, '- a\n- b\n\nAfter.\n');  // separator preserved, empty item dropped
  const html = marked.parse(md);
  assert.ok(/<p>After\.<\/p>/.test(html), '"After." must stay its own paragraph');
});

test('typing more chars in a nested item then Return keeps all the text', async () => {
  const t = await setup('- one\n  * x');   // a realized nested sub-item "x"
  // The browser inserts "yz" into the <li> (jsdom does not, so set it directly).
  const lis = t.doc.querySelectorAll('li');
  const nested = lis[lis.length - 1];
  nested.firstChild.textContent = 'xyz';
  const r = t.doc.createRange(); r.setStart(nested.firstChild, 3); r.collapse(true);
  const sel = t.win.getSelection(); sel.removeAllRanges(); sel.addRange(r);
  nested.dispatchEvent(new t.win.InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true }));
  assert.equal(t.md(), '- one\n  * xyz\n  *'); // all of "xyz" kept, new sub-item added
});

test('Tab on a blank line starts a new list', async () => {
  const t = await setup('hello\n');
  caret(t.win, { text: 'hello', at: 5 });
  beforeInput(t.win, 'insertParagraph'); // end of paragraph -> transient blank line
  pressTab(t.win, false);                // -> new list
  beforeInput(t.win, 'insertText', 'x');
  assert.equal(t.md(), 'hello\n\n- x\n');
});

// Select `text` (within a single text node) and press a Cmd+key shortcut the
// way onKeydown receives it from WKWebView.
function selectAndPressCmd(win, text, key) {
  const doc = win.document, sel = win.getSelection(), r = doc.createRange();
  const walk = doc.createTreeWalker(doc.getElementById('content'), win.NodeFilter.SHOW_TEXT);
  let n, node = null;
  while ((n = walk.nextNode())) { if (n.textContent.includes(text)) { node = n; break; } }
  const i = node.textContent.indexOf(text);
  r.setStart(node, i); r.setEnd(node, i + text.length);
  sel.removeAllRanges(); sel.addRange(r);
  const ev = new win.KeyboardEvent('keydown', { key, metaKey: true, bubbles: true, cancelable: true });
  win.getSelection().anchorNode.parentNode.dispatchEvent(ev);
}

// Select from the text node containing `fromText` to the one containing
// `toText` (whole-node endpoints), dispatch the delete beforeinput, and — when
// the handler doesn't claim it — mutate the DOM the way the browser would.
function selectAndDelete(t, fromText, toText) {
  const doc = t.win.document, sel = t.win.getSelection(), r = doc.createRange();
  const walk = doc.createTreeWalker(doc.getElementById('content'), t.win.NodeFilter.SHOW_TEXT);
  let n, a = null, b = null;
  while ((n = walk.nextNode())) {
    if (!a && n.textContent.includes(fromText)) a = n;
    if (n.textContent.includes(toText)) b = n;
  }
  r.setStart(a, a.textContent.indexOf(fromText));
  r.setEnd(b, b.textContent.indexOf(toText) + toText.length);
  sel.removeAllRanges(); sel.addRange(r);
  const ev = new t.win.InputEvent('beforeinput', { inputType: 'deleteContentBackward', bubbles: true, cancelable: true });
  (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentNode).dispatchEvent(ev);
  if (!ev.defaultPrevented) r.deleteContents();
}

test('deleting a whole list section then Return does not resurrect it', async () => {
  const t = await setup('## Heading\n\n- one\n- two\n- three\n');
  selectAndDelete(t, 'one', 'three');
  beforeInput(t.win, 'insertParagraph');
  assert.ok(!t.md().includes('two'), 'deleted items resurrected in source: ' + JSON.stringify(t.md()));
  assert.ok(!t.doc.getElementById('content').textContent.includes('two'),
    'deleted items resurrected in DOM');
  assert.ok(t.md().includes('## Heading'), 'heading must survive');
});

test('a multi-leaf deletion then Cmd+I elsewhere keeps both edits', async () => {
  const t = await setup('keep **gone** also\n\nhello world\n');
  selectAndDelete(t, 'gone', 'gone'); // deletes the whole bold run's text
  selectAndPressCmd(t.win, 'world', 'i');
  assert.ok(!t.md().includes('gone'), 'deleted text resurrected: ' + JSON.stringify(t.md()));
  assert.ok(t.md().includes('*world*'), 'italic lost: ' + JSON.stringify(t.md()));
});

test('a selection spanning two blocks deletes across them', async () => {
  const t = await setup('alpha bravo\n\ncharlie delta\n');
  selectAndDelete(t, 'bravo', 'charlie');
  assert.equal(t.md(), 'alpha  delta\n');
});

// The pitch-deck.md bug: delete an italic sentence (the browser keeps the
// emptied <em> in the DOM), type/paste into the gap — the new text displayed
// italic while the source said plain, so Cmd+I "did nothing" (it wrapped
// already-italic-looking text). After a save-path flush the block must be
// re-rendered from source so DOM formatting matches it again.
test('deleting an italic run then typing into the gap stays plain', async () => {
  const t = await setup('Veloci. *Meetings in. Judged.* tail\n');
  selectAndDelete(t, 'Meetings in. Judged.', 'Meetings in. Judged.');
  t.win.saveNow(); // reconciles the deletion and refreshes the stale block
  assert.equal(t.win.currentMarkdown(), 'Veloci.  tail\n');
  assert.equal(t.doc.querySelector('[data-seg] em'), null,
    'zombie <em> must be gone after the refresh');
  // type at the restored caret — must come out plain, in DOM and source
  const sel = t.win.getSelection();
  const ev = new t.win.InputEvent('beforeinput', { inputType: 'insertText', data: 'X', bubbles: true, cancelable: true });
  const anchor = sel.anchorNode;
  (anchor.nodeType === 1 ? anchor : anchor.parentNode).dispatchEvent(ev);
  if (!ev.defaultPrevented && anchor.nodeType === 3) anchor.insertData(sel.anchorOffset, 'X');
  t.win.saveNow();
  assert.equal(t.win.currentMarkdown(), 'Veloci. X tail\n');
  assert.equal(t.doc.querySelector('[data-seg] em'), null, 'typed text must not be italic');
});

test('Cmd+B then Cmd+I on the same word stacks bold and italic', async () => {
  const t = await setup('hello world\n');
  selectAndPressCmd(t.win, 'world', 'b');
  assert.equal(t.md(), 'hello **world**\n');
  // doEmphasis restores the selection over "world" inside the bold run
  selectAndPressCmd(t.win, 'world', 'i');
  assert.equal(t.md(), 'hello ***world***\n');
});

// --- Cross-block selection: copy-only --------------------------------------
//
// Cmd+A (and cross-block mouse drags) exist so the user can Cmd+C the whole
// document. While a selection spans more than one block the blocks are parked
// contenteditable=false — the selection renders as an ordinary page selection
// (greyed via #content.cross-select) and native copy works; every key that
// would EDIT the selection is refused, leaving the source untouched.

// Dispatch a keydown on the document, the way the capture-phase router
// receives it from WKWebView regardless of where focus sits.
function pressDocKey(t, key, init) {
  const ev = new t.win.KeyboardEvent('keydown', Object.assign({ key, bubbles: true, cancelable: true }, init || {}));
  t.doc.dispatchEvent(ev);
  return ev;
}
const segDivs = (t) => Array.from(t.doc.querySelectorAll('#content [data-seg]'));

test('Cmd+A selects first block through last and parks blocks read-only', async () => {
  const t = await setup('# Head\n\nalpha bravo\n\n- one\n- two\n');
  const ev = pressDocKey(t, 'a', { metaKey: true });
  assert.equal(ev.defaultPrevented, true, 'Cmd+A must be claimed');
  const sel = t.win.getSelection();
  assert.equal(sel.rangeCount, 1);
  const text = sel.getRangeAt(0).toString();
  assert.ok(text.includes('Head') && text.includes('two'),
    `selection must span the whole document: ${JSON.stringify(text)}`);
  assert.ok(segDivs(t).every((d) => d.getAttribute('contenteditable') === 'false'),
    'all blocks parked read-only');
  assert.ok(t.doc.getElementById('content').classList.contains('cross-select'),
    'grey-selection signal class present');
});

test('Cmd+A twice is idempotent', async () => {
  const t = await setup('alpha\n\nbravo\n');
  const before = t.md();
  pressDocKey(t, 'a', { metaKey: true });
  pressDocKey(t, 'a', { metaKey: true });
  const sel = t.win.getSelection();
  assert.equal(sel.rangeCount, 1);
  assert.ok(sel.getRangeAt(0).toString().includes('bravo'));
  assert.equal(t.md(), before);
});

test('editing keys over a select-all are refused and leave the source untouched', async () => {
  const t = await setup('alpha\n\n- one\n- two\n');
  const before = t.md();
  pressDocKey(t, 'a', { metaKey: true });
  for (const [key, init] of [['Backspace'], ['Delete'], ['Enter'], ['Tab'], ['x'],
    ['x', { metaKey: true }], ['v', { metaKey: true }], ['b', { metaKey: true }]]) {
    const ev = pressDocKey(t, key, init);
    assert.equal(ev.defaultPrevented, true, `${init && init.metaKey ? 'Cmd+' : ''}${key} must be refused`);
  }
  assert.equal(t.md(), before, 'source must be byte-identical');
  // Cmd+C is NOT intercepted — native copy of the page selection
  const c = pressDocKey(t, 'c', { metaKey: true });
  assert.equal(c.defaultPrevented, false, 'Cmd+C must fall through to native copy');
  t.win.saveNow();
  assert.equal(t.saved(), null, 'an unchanged document posts no save at all');
});

test('Escape collapses a select-all and restores per-block editing', async () => {
  const t = await setup('alpha\n\n- one\n- two\n');
  pressDocKey(t, 'a', { metaKey: true });
  const ev = pressDocKey(t, 'Escape');
  assert.equal(ev.defaultPrevented, true);
  assert.ok(t.win.getSelection().isCollapsed, 'selection collapsed');
  assert.ok(!t.doc.getElementById('content').classList.contains('cross-select'),
    'grey-selection signal removed');
  assert.ok(segDivs(t).every((d) => d.getAttribute('contenteditable') === 'true'),
    'editable blocks restored');
});

test('Cmd+A in a single-block document selects within the block, still editable', async () => {
  const t = await setup('hello world\n');
  const ev = pressDocKey(t, 'a', { metaKey: true });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(t.win.getSelection().getRangeAt(0).toString(), 'hello world');
  assert.equal(t.seg().getAttribute('contenteditable'), 'true', 'single block stays editable');
  assert.ok(!t.doc.getElementById('content').classList.contains('cross-select'));
});

test('Cmd+A flushes a pending DOM edit before parking the blocks', async () => {
  const t = await setup('alpha bravo\n\nsecond\n');
  const walk = t.doc.createTreeWalker(t.doc.getElementById('content'), t.win.NodeFilter.SHOW_TEXT);
  let n, node = null;
  while ((n = walk.nextNode())) { if (n.textContent.includes('bravo')) { node = n; break; } }
  node.textContent = 'alpha Xbravo'; // a typed-but-unflushed DOM edit
  pressDocKey(t, 'a', { metaKey: true });
  assert.ok(t.md().includes('alpha Xbravo'), `pending edit must reach the source: ${JSON.stringify(t.md())}`);
});

// Drive a cross-block mouse drag with stubbed geometry: jsdom has no layout,
// so caretRangeFromPoint is faked with a coordinate→position map.
function dragSetup(t, pointMap) {
  t.doc.caretRangeFromPoint = (x, y) => {
    const p = pointMap[x + ',' + y];
    if (!p) return null;
    const r = t.doc.createRange();
    r.setStart(p.node, p.offset);
    r.collapse(true);
    return r;
  };
  t.win.scrollBy = () => {};
}
function mouse(t, type, target, x, y) {
  target.dispatchEvent(new t.win.MouseEvent(type, { button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true }));
}

test('the grey signal tracks the selection span live during a drag', async () => {
  const t = await setup('alpha bravo\n\ncharlie delta\n');
  const textNode = (s) => {
    const walk = t.doc.createTreeWalker(t.doc.getElementById('content'), t.win.NodeFilter.SHOW_TEXT);
    let n; while ((n = walk.nextNode())) if (n.textContent.includes(s)) return n;
  };
  const a = textNode('alpha'), c = textNode('charlie');
  dragSetup(t, {
    '10,100': { node: a, offset: 2 },   // mousedown anchor inside block 1
    '10,200': { node: c, offset: 3 },   // drag down into block 2
    '40,100': { node: a, offset: 8 },   // drag back up inside block 1
  });
  const content = t.doc.getElementById('content');
  mouse(t, 'mousedown', a.parentNode, 10, 100);
  mouse(t, 'mousemove', c.parentNode, 10, 200); // crosses into block 2
  assert.ok(content.classList.contains('cross-select'),
    'spanning two blocks: grey signal on');
  assert.ok(t.win.crossBlockSel(), 'selection must span the two blocks');
  mouse(t, 'mousemove', a.parentNode, 40, 100); // back inside block 1
  assert.ok(!content.classList.contains('cross-select'),
    'selection back within one block: signal must return to blue');
  mouse(t, 'mouseup', a.parentNode, 40, 100);
  assert.ok(!content.classList.contains('cross-select'), 'signal off after release');
  assert.ok(segDivs(t).every((d) => d.getAttribute('contenteditable') === 'true'),
    'single-block release restores per-block editing');
});

test('Cmd+Z routed at document level still undoes after Cmd+A', async () => {
  const t = await setup('hello world\n\nsecond\n');
  selectAndPressCmd(t.win, 'world', 'b');
  assert.equal(t.md(), 'hello **world**\n\nsecond\n');
  pressDocKey(t, 'a', { metaKey: true });
  const ev = pressDocKey(t, 'z', { metaKey: true });
  assert.equal(ev.defaultPrevented, true);
  assert.equal(t.md(), 'hello world\n\nsecond\n', 'undo must apply');
  assert.ok(!t.doc.getElementById('content').classList.contains('cross-select'),
    'the re-render exits cross mode');
});

// --- applyDiskChange: the app must never write a file the user isn't editing ---

test('a disk change on an idle document is taken verbatim, never written back', async () => {
  // Blocks ending in code spans were the killer: the lossy DOM read-back
  // manufactured "local edits" out of nothing, and every external restore got
  // re-mangled and saved within seconds. Idle → disk wins, no post, ever.
  const t = await setup('Run tests via `/tdd`\n\n- configured via `make test`\n');
  const disk = '# Restored by someone else\n\nRun tests via `/tdd`\n';
  t.win.applyDiskChange(disk);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(t.md(), disk, 'the editor adopts the disk content exactly');
  assert.equal(t.saved(), null, 'no save may be scheduled or posted');
  t.win.saveNow(); // even a forced save (blur path) has nothing to persist
  assert.equal(t.saved(), null, 'an idle document never posts to Swift');
});

test('a disk change with real unsaved edits still merges and persists', async () => {
  const t = await setup('alpha\n\nbravo\n');
  caret(t.win, { text: 'alpha', at: 5 });
  beforeInput(t.win, 'insertText', 'X'); // marks the doc dirty (jsdom does not mutate the DOM itself)
  const walk = t.doc.createTreeWalker(t.doc.getElementById('content'), t.win.NodeFilter.SHOW_TEXT);
  let node; while ((node = walk.nextNode())) if (node.textContent.includes('alpha')) break;
  node.textContent = 'alphaX'; // what WebKit's default insert would have done
  t.win.applyDiskChange('alpha\n\nbravo2\n');
  await new Promise((r) => setTimeout(r, 0));
  t.win.saveNow();
  assert.equal(t.saved(), 'alphaX\n\nbravo2\n', 'local edit and disk edit both survive');
});

// --- table cells ------------------------------------------------------------
// Cells are the only editable part of a table. The scaffolding — pipes,
// alignment row, column padding — is reproduced byte for byte, so editing one
// cell must not reflow the table on disk.

test('a table is offered for editing', async () => {
  const t = await setup('| A | B |\n|---|---|\n| x | y |\n');
  const div = t.doc.querySelector('#content [data-seg]');
  assert.equal(div.getAttribute('contenteditable'), 'true');
  assert.ok(div.querySelector('table'));
});

test('typing in a cell rewrites that cell and nothing else', async () => {
  const md = '| Col A | Col B |\n|-------|-------|\n| one   | two   |\n';
  const t = await setup(md);
  const cell = Array.from(t.doc.querySelectorAll('td')).find((c) => c.textContent === 'one');
  cell.firstChild.textContent = 'once';           // WebKit's insertion, simulated
  t.win.flushActive();
  assert.equal(t.md(), '| Col A | Col B |\n|-------|-------|\n| once   | two   |\n');
});

test('editing a header cell keeps the alignment row intact', async () => {
  const md = '|Left|Right|\n|:---|----:|\n|a|b|\n';
  const t = await setup(md);
  const th = t.doc.querySelectorAll('th')[1];
  th.firstChild.textContent = 'Right side';
  t.win.flushActive();
  assert.equal(t.md(), '|Left|Right side|\n|:---|----:|\n|a|b|\n');
});

test('an escaped pipe in a cell survives an edit to its neighbour', async () => {
  const md = '| Expression | Meaning |\n| --- | --- |\n| x \\| y | alternation |\n';
  const t = await setup(md);
  const cell = Array.from(t.doc.querySelectorAll('td')).find((c) => c.textContent === 'alternation');
  cell.firstChild.textContent = 'or';
  t.win.flushActive();
  assert.equal(t.md(), '| Expression | Meaning |\n| --- | --- |\n| x \\| y | or |\n');
});

test('emphasis inside a cell is preserved when other text changes', async () => {
  const md = '| Item | Notes |\n| --- | --- |\n| **bold** | plain |\n';
  const t = await setup(md);
  const cell = Array.from(t.doc.querySelectorAll('td')).find((c) => c.textContent === 'plain');
  cell.firstChild.textContent = 'plainer';
  t.win.flushActive();
  assert.equal(t.md(), '| Item | Notes |\n| --- | --- |\n| **bold** | plainer |\n');
});

test('an untouched table is never rewritten', async () => {
  const md = '|a|b|\n|-|-|\n|1|2|\n\nAfter.\n';
  const t = await setup(md);
  t.win.flushActive();
  assert.equal(t.md(), md);
  assert.equal(t.saved(), null);
});

// --- handler failures are recorded ------------------------------------------
// An exception inside an event listener is reported to the console and then
// dropped by the browser, so a half-finished handler used to leave the editor
// in an odd state with nothing in editor.log to explain it.

test('an exception in a handler is logged with the block it happened in', async () => {
  const t = await setup('- one\n- two\n');
  t.win.splitBlockAt = null;                      // sabotage the split path
  const orig = t.win.EditorCore.splitBlock;
  t.win.EditorCore.splitBlock = () => { throw new Error('boom'); };
  caret(t.win, { text: 'two', at: 3 });
  beforeInput(t.win, 'insertParagraph');
  t.win.EditorCore.splitBlock = orig;
  const logged = t.log.filter((l) => l.startsWith('HANDLER'));
  assert.equal(logged.length, 1, `expected one handler failure, got ${JSON.stringify(t.log.slice(-4))}`);
  assert.match(logged[0], /beforeinput THREW/);
  assert.match(logged[0], /boom/);
  assert.match(logged[0], /seg=\d/);
});

test('the document survives a handler that throws', async () => {
  const md = '- one\n- two\n';
  const t = await setup(md);
  const orig = t.win.EditorCore.splitBlock;
  t.win.EditorCore.splitBlock = () => { throw new Error('boom'); };
  caret(t.win, { text: 'two', at: 3 });
  beforeInput(t.win, 'insertParagraph');
  t.win.EditorCore.splitBlock = orig;
  assert.equal(t.md(), md, 'source must be unchanged after a failed handler');
});

// --- the caret survives the post-flush re-render -----------------------------
// The 2026-08-12 incident: typing "…During that " at the end of a list item,
// pausing 500ms (the debounced flush), then typing "time " landed the caret one
// character into the NEXT item ("Ntime …ote that"). WebKit strands the trailing
// space as &nbsp;; the reconciler correctly sheds it from the source; the
// immediate re-render then ate the space on screen and shifted every display
// offset by one. The contract pinned here: the file gets the clean source, the
// screen keeps the typed space, the caret does not move, and the next words
// land where they were aimed.

test('a trailing space typed at an item end survives the flush without moving the caret', async () => {
  const t = await setup('- alpha bravo\n- Note that charlie\n');
  // The user appends " During that" and a space; WebKit strands it as nbsp.
  const walk = t.doc.createTreeWalker(t.doc.getElementById('content'), t.win.NodeFilter.SHOW_TEXT);
  let n, node = null;
  while ((n = walk.nextNode())) if (n.textContent === 'alpha bravo') { node = n; break; }
  node.textContent = 'alpha bravo During that\u00a0';
  caret(t.win, { text: 'alpha bravo During that', at: node.textContent.length });
  t.win.saveNow();
  // The file gets clean source — the engine's nbsp is shed…
  assert.equal(t.md(), '- alpha bravo During that\n- Note that charlie\n');
  // …but the screen keeps the typed space and the caret has not moved.
  const sel = t.win.getSelection();
  assert.equal(sel.anchorNode.textContent, 'alpha bravo During that\u00a0', 'live text keeps the space');
  assert.equal(sel.anchorOffset, sel.anchorNode.textContent.length, 'caret still at the end of the text');
  assert.ok(t.doc.querySelector('li').contains(sel.anchorNode), 'caret still in the first item');
  // Typing resumes: WebKit solidifies the nbsp into a plain space.
  sel.anchorNode.textContent = 'alpha bravo During that time';
  caret(t.win, { text: 'alpha bravo During that time', at: 'alpha bravo During that time'.length });
  t.win.saveNow();
  assert.equal(t.md(), '- alpha bravo During that time\n- Note that charlie\n');
  assert.ok(t.doc.querySelector('li').contains(t.win.getSelection().anchorNode), 'caret still in the first item');
});

// An artifact-only flush — the DOM holds just a stranded edge nbsp, the source
// needs nothing — used to be reported as unreconcilable so the REVERT would
// shed it. A revert re-renders from source: it destroys the caret and eats any
// keystroke whose DOM mutation is still in flight (burst-start flushes run
// inside beforeinput, before the browser inserts the character). 2026-08-12,
// second incident: caret thrown to block start, "nsure no co" typed there,
// then discarded by the next revert.

test('an artifact-only flush neither reverts nor moves the caret', async () => {
  const t = await setup('- one\n- two\n- three\n\ntail paragraph\n');
  const li = t.doc.querySelectorAll('li')[1];
  const w = t.doc.createTreeWalker(li, t.win.NodeFilter.SHOW_TEXT);
  const node = w.nextNode();
  node.textContent = 'two ';
  caret(t.win, { text: 'two', at: node.textContent.length });
  t.win.saveNow();
  assert.ok(!t.log.some((l) => l.includes('REVERT') || l.includes('FAILED')),
    `no revert, got: ${JSON.stringify(t.log.slice(-3))}`);
  assert.equal(t.md(), '- one\n- two\n- three\n\ntail paragraph\n', 'source stays clean');
  const sel = t.win.getSelection();
  assert.equal(sel.anchorNode, node, 'caret still in the same text node');
  assert.equal(sel.anchorOffset, node.textContent.length, 'caret unmoved');
  assert.ok(node.textContent.endsWith(' '), 'screen keeps the artifact while the caret is on it');
  // Caret leaves the block (the deferral is per block, so another item of the
  // same list would keep it): the artifact sheds on the next flush.
  caret(t.win, { text: 'tail paragraph', at: 0 });
  t.win.saveNow();
  assert.equal(t.doc.querySelectorAll('li')[1].textContent, 'two', 'artifact shed once the caret left');
});

// --- external disk changes must not move a parked caret -----------------------
// applyDiskChange rebuilds the whole document (verbatim when idle, three-way
// merge when dirty). Before 2026-08-12 neither branch restored the selection:
// any external write — another window saving the same file, another session
// editing it, git — threw a parked caret to wherever WebKit re-anchored it.

test('a verbatim disk change does not move a parked caret', async () => {
  const t = await setup('- one\n- two\n- three\n\npara\n');
  caret(t.win, { text: 'two', at: 2 });
  // Echo: same content arrives from disk (the multi-window case).
  t.win.applyDiskChange('- one\n- two\n- three\n\npara\n');
  let sel = t.win.getSelection();
  assert.equal(sel.anchorNode.textContent, 'two', 'caret still in its item');
  assert.equal(sel.anchorOffset, 2, 'caret at the same offset');
  // A real external edit elsewhere in the document.
  t.win.applyDiskChange('- one\n- two\n- three\n\nPARA changed\n');
  sel = t.win.getSelection();
  assert.equal(sel.anchorNode.textContent, 'two', 'caret survives a distant edit');
  assert.equal(sel.anchorOffset, 2);
  assert.equal(t.md(), '- one\n- two\n- three\n\nPARA changed\n');
});

test('a merged disk change keeps the caret with the local edit', async () => {
  const t = await setup('- one\n- two\n- three\n\npara\n');
  // Local unsaved edit: "two" -> "twoX", caret after the X.
  const w = t.doc.createTreeWalker(t.doc.getElementById('content'), t.win.NodeFilter.SHOW_TEXT);
  let n, node = null;
  while ((n = w.nextNode())) if (n.textContent === 'two') { node = n; break; }
  node.textContent = 'twoX';
  caret(t.win, { text: 'twoX', at: 4 });
  t.win.scheduleSave(); // mark dirty the way real typing does
  // External edit to a different block arrives before our save.
  t.win.applyDiskChange('- one\n- two\n- three\n\nPARA changed\n');
  assert.ok(t.md().includes('twoX'), 'local edit survives the merge');
  assert.ok(t.md().includes('PARA changed'), 'disk edit survives the merge');
  const sel = t.win.getSelection();
  assert.equal(sel.anchorNode.textContent, 'twoX', 'caret stayed with the local edit');
  assert.equal(sel.anchorOffset, 4);
});

test('typing that strands a space at a table cell edge folds without a revert', async () => {
  // 2026-08-12, third incident: td/th were not edge-trim containers, so a
  // stranded nbsp in a cell could never be shed — reconcile failed and the
  // REVERT discarded the whole unfolded typing run.
  const t = await setup('| A | B |\n|---|---|\n| one | expected |\n');
  const td = t.doc.querySelectorAll('td')[1];
  const w = t.doc.createTreeWalker(td, t.win.NodeFilter.SHOW_TEXT);
  const node = w.nextNode();
  node.textContent = 'expected to ';
  const sel = t.win.getSelection(), r = t.doc.createRange();
  r.setStart(node, node.textContent.length); r.collapse(true);
  sel.removeAllRanges(); sel.addRange(r);
  t.win.saveNow();
  assert.ok(!t.log.some((l) => l.includes('REVERT') || l.includes('FAILED')),
    `no revert, got: ${JSON.stringify(t.log.slice(-3))}`);
  assert.ok(t.md().includes('expected to'), 'typed text folds into the cell source');
  assert.equal(t.win.getSelection().anchorNode, node, 'caret unmoved');
});

// A table containing empty cells was silently read-only: a whitespace-only
// cell counted its padding twice (leading and trailing regexes overlapping),
// the byte-tiling check failed, and blockCoords demoted the block. 2026-08-12,
// fourth incident — the comparison-matrix table with checkmark cells.
test('tables with empty cells are editable and fold edits', async () => {
  const t = await setup('| | B |\n|---|---|\n| x | |\n');
  const seg = t.doc.querySelector('[data-seg]');
  assert.equal(seg.getAttribute('contenteditable'), 'true', 'table with empty cells is editable');
  const empty = [...t.doc.querySelectorAll('td')].find((td) => td.textContent === '');
  empty.appendChild(t.doc.createTextNode('filled'));
  const sel = t.win.getSelection(), r = t.doc.createRange();
  r.setStart(empty.firstChild, 6); r.collapse(true);
  sel.removeAllRanges(); sel.addRange(r);
  t.win.saveNow();
  assert.ok(t.md().includes('filled'), `edit folds into source, got ${JSON.stringify(t.md())}`);
  assert.ok(!t.log.some((l) => l.includes('REVERT') || l.includes('FAILED')),
    `no revert, got: ${JSON.stringify(t.log.slice(-3))}`);
});

// A demoted block (would be editable, but its offset map can't be trusted)
// must announce itself instead of silently eating clicks; inherently
// read-only blocks (code fences) stay unadorned.
test('demoted blocks are marked seg-readonly, inherent ones are not', async () => {
  // The blockquote whose text marked re-indents is a known format-limited
  // (demoted) shape; the code fence is inherently read-only.
  const t = await setup('> foo\n    - bar\n\n```\ncode\n```\n\nplain text\n');
  const segs = [...t.doc.querySelectorAll('[data-seg]')];
  const demoted = segs.filter((d) => d.classList.contains('seg-readonly'));
  const editable = segs.filter((d) => d.getAttribute('contenteditable') === 'true');
  for (const d of demoted) {
    assert.equal(d.getAttribute('contenteditable'), 'false', 'marked blocks are read-only');
    assert.ok(d.getAttribute('title'), 'marked blocks explain themselves');
  }
  const code = segs.find((d) => d.querySelector('pre'));
  assert.ok(code, 'code fence rendered');
  assert.ok(!code.classList.contains('seg-readonly'), 'code fence is not marked');
  assert.ok(editable.length >= 1, 'plain paragraph stays editable');
  assert.ok(demoted.length >= 1, `expected a demoted block in this doc, got ${segs.map((d) => d.getAttribute('contenteditable'))}`);
});

// Links: contenteditable swallows link clicks and a followed link would
// replace the webview's document, so the click handler routes opens to Swift.
// Plain click opens where there is no caret to place; in an editable block
// the caret keeps the plain click and Cmd+click opens.
function clickOn(win, el, opts = {}) {
  const ev = new win.MouseEvent('click', { bubbles: true, cancelable: true, button: 0, ...opts });
  el.dispatchEvent(ev);
  return ev;
}

test('plain click on a link in an editable block places the caret, not the browser', async () => {
  const t = await setup('see [the docs](https://example.com/docs) here\n');
  const a = t.doc.querySelector('a');
  // In WebKit, contenteditable itself suppresses the navigation; jsdom would
  // actually navigate, so absorb the default at the end of the bubble phase
  // and record whether our handler had (wrongly) prevented it before then.
  let prevented = null;
  t.doc.addEventListener('click', (e) => { prevented = e.defaultPrevented; e.preventDefault(); });
  clickOn(t.win, a);
  assert.equal(t.opened.length, 0, 'no open posted');
  assert.equal(prevented, false, 'default (caret placement) must survive');
});

test('cmd+click on a link in an editable block opens it via Swift', async () => {
  const t = await setup('see [the docs](https://example.com/docs) here\n');
  const a = t.doc.querySelector('a');
  const ev = clickOn(t.win, a, { metaKey: true });
  assert.deepEqual(t.opened, ['https://example.com/docs']);
  assert.ok(ev.defaultPrevented, 'navigation must be suppressed');
});

test('plain click on a link in a read-only block opens it via Swift', async () => {
  // A raw HTML block renders read-only (contenteditable=false).
  const t = await setup('<div>see <a href="https://example.com/x">x</a></div>\n');
  const a = t.doc.querySelector('#content a');
  assert.ok(a, 'link rendered');
  assert.equal(a.closest('[contenteditable="true"]'), null, 'block must be read-only');
  const ev = clickOn(t.win, a);
  assert.deepEqual(t.opened, ['https://example.com/x']);
  assert.ok(ev.defaultPrevented, 'navigation must be suppressed');
});

test('click on a fragment link scrolls in place, never leaves the page', async () => {
  const t = await setup('# Target\n\nsee [above](#target)\n');
  const a = t.doc.querySelector('a[href="#target"]');
  assert.ok(a, 'fragment link rendered');
  let scrolled = false;
  const h = t.doc.getElementById('target');
  if (h) h.scrollIntoView = () => { scrolled = true; };
  const ev = clickOn(t.win, a, { metaKey: true });
  assert.equal(t.opened.length, 0, 'fragment must not open externally');
  assert.ok(ev.defaultPrevented, 'handled in page');
  if (h) assert.ok(scrolled, 'scrolled to the anchor');
});

// WebKit fires no beforeinput for a Backspace/Delete with nothing to consume
// inside the block's own contenteditable island (block start, empty block,
// block end) — so these ops must ride the keydown. The older merge tests
// above dispatch beforeinput directly, which real WebKit never sends at a
// block edge; these drive the keydown path the app actually gets.
function pressKey(win, key, opts = {}) {
  const sel = win.getSelection();
  const target = sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentNode;
  const ev = new win.KeyboardEvent('keydown', { key, bubbles: true, cancelable: true, ...opts });
  target.dispatchEvent(ev);
  return ev;
}

test('keydown Backspace at the start of a paragraph merges it into the previous', async () => {
  const t = await setup('alpha one\n\nbeta two\n');
  caret(t.win, { text: 'beta', at: 0 });
  const ev = pressKey(t.win, 'Backspace');
  assert.ok(ev.defaultPrevented, 'must be handled at keydown — no beforeinput will come');
  assert.equal(t.md(), 'alpha onebeta two\n');
});

test('keydown Backspace at the start of the first list item outdents it', async () => {
  const t = await setup('- one\n- two\n');
  caret(t.win, { text: 'one', at: 0 });
  const ev = pressKey(t.win, 'Backspace');
  assert.ok(ev.defaultPrevented);
  assert.equal(t.md(), 'one\n\n- two\n');
});

test('keydown Backspace removes an empty (transient) paragraph', async () => {
  const t = await setup('alpha one\n');
  caret(t.win, { text: 'alpha one', at: 9 });
  beforeInput(t.win, 'insertParagraph'); // transient empty paragraph below
  const ev = pressKey(t.win, 'Backspace');
  assert.ok(ev.defaultPrevented);
  assert.equal(t.md(), 'alpha one\n');
  assert.ok(!t.win._segments.some((s) => s.transient), 'transient gone');
});

test('Enter at the start of a paragraph opens an empty paragraph above, typing fills it', async () => {
  const t = await setup('alpha one\n\nbeta two\n');
  caret(t.win, { text: 'beta', at: 0 });
  beforeInput(t.win, 'insertParagraph');
  assert.equal(t.md().replace(/\n+$/, '\n'), 'alpha one\n\nbeta two\n', 'no bytes until typed into');
  assert.ok(t.win._segments.some((s) => s.transient), 'transient paragraph present');
  beforeInput(t.win, 'insertText', 'x');
  assert.equal(t.md(), 'alpha one\n\nx\n\nbeta two\n');
});

// Selection deletes inside one block are performed by the editor, not WebKit
// — WebKit fuses the surviving halves into one formatting run (bold leaks
// over previously-plain text and gets written to the file). Contract: a
// text-only edit never changes the formatting of text it didn't touch.
function rangeSelect(t, fromText, fromOff, toText, toOff) {
  const doc = t.win.document, sel = t.win.getSelection(), r = doc.createRange();
  const walk = doc.createTreeWalker(doc.getElementById('content'), t.win.NodeFilter.SHOW_TEXT);
  let n, a = null, b = null;
  while ((n = walk.nextNode())) {
    if (!a && n.textContent.includes(fromText)) a = n;
    if (n.textContent.includes(toText)) b = n;
  }
  r.setStart(a, a.textContent.indexOf(fromText) + fromOff);
  r.setEnd(b, b.textContent.indexOf(toText) + toOff);
  sel.removeAllRanges(); sel.addRange(r);
  return r;
}
function dispatchInput(t, inputType, data) {
  const sel = t.win.getSelection();
  const ev = new t.win.InputEvent('beforeinput', { inputType, data: data ?? null, bubbles: true, cancelable: true });
  (sel.anchorNode.nodeType === 1 ? sel.anchorNode : sel.anchorNode.parentNode).dispatchEvent(ev);
  return ev;
}

test('deleting across a bold boundary keeps each survivor its own style', async () => {
  const t = await setup('**AAAAAAAAAA**BBBBBBBBBB\n');
  rangeSelect(t, 'AAAAAAAAAA', 5, 'BBBBBBBBBB', 5);
  const ev = dispatchInput(t, 'deleteContentBackward');
  assert.ok(ev.defaultPrevented, 'selection delete must not be left to WebKit');
  t.win.saveNow();
  assert.equal(t.md(), '**AAAAA**BBBBB\n');
});

test('typing over a selection spanning a bold boundary inserts at the seam', async () => {
  const t = await setup('**AAAAAAAAAA**BBBBBBBBBB\n');
  rangeSelect(t, 'AAAAAAAAAA', 5, 'BBBBBBBBBB', 5);
  const ev = dispatchInput(t, 'insertText', 'x');
  assert.ok(ev.defaultPrevented);
  t.win.saveNow();
  assert.equal(t.md(), '**AAAAA**xBBBBB\n');
});

test('typing over a selection inside a bold run stays bold', async () => {
  const t = await setup('**alpha beta**\n');
  rangeSelect(t, 'beta', 0, 'beta', 4);
  dispatchInput(t, 'insertText', 'x');
  t.win.saveNow();
  assert.equal(t.md(), '**alpha x**\n');
});

test('a delete spanning two list items merges them, formatting intact', async () => {
  const t = await setup('- aaa **bbb**\n- ccc ddd\n');
  rangeSelect(t, 'bbb', 1, 'ccc', 2);
  const ev = dispatchInput(t, 'deleteContentBackward');
  assert.ok(ev.defaultPrevented);
  t.win.saveNow();
  assert.equal(t.md(), '- aaa **b**c ddd\n');
});

test('keydown forward Delete at the end of a paragraph merges the next one up', async () => {
  const t = await setup('alpha one\n\nbeta two\n');
  caret(t.win, { text: 'alpha one', at: 9 });
  const ev = pressKey(t.win, 'Delete');
  assert.ok(ev.defaultPrevented, 'must be handled at keydown — no beforeinput will come');
  assert.equal(t.md(), 'alpha onebeta two\n');
});

// Shift+Cmd+H / Shift+Cmd+G: heading level up/down the ladder
// paragraph ↔ H6 ↔ … ↔ H1 (the only arrangement where the keys are exact
// inverses at every step). Block-level: caret or any selection identifies
// the block; a cross-block (or Cmd+A) selection shifts every block it
// touches.
test('Shift+Cmd+H walks a paragraph up the ladder; Shift+Cmd+G back down', async () => {
  const t = await setup('alpha beta\n');
  caret(t.win, { text: 'alpha', at: 2 });
  pressKey(t.win, 'H', { metaKey: true, shiftKey: true });
  assert.equal(t.md(), '###### alpha beta\n');
  pressKey(t.win, 'H', { metaKey: true, shiftKey: true });
  assert.equal(t.md(), '##### alpha beta\n');
  pressKey(t.win, 'G', { metaKey: true, shiftKey: true });
  pressKey(t.win, 'G', { metaKey: true, shiftKey: true });
  assert.equal(t.md(), 'alpha beta\n');
});

test('Shift+Cmd+H at H1 is a no-op', async () => {
  const t = await setup('# top\n');
  caret(t.win, { text: 'top', at: 1 });
  pressKey(t.win, 'H', { metaKey: true, shiftKey: true });
  assert.equal(t.md(), '# top\n');
});

test('demoting a heading whose text lexes as structure escapes the lead', async () => {
  const t = await setup('###### 1. Data residency\n');
  caret(t.win, { text: 'Data', at: 0 });
  pressKey(t.win, 'G', { metaKey: true, shiftKey: true });
  assert.equal(t.md(), '1\\. Data residency\n');
  // and back up: the escape comes off again
  pressKey(t.win, 'H', { metaKey: true, shiftKey: true });
  assert.equal(t.md(), '###### 1. Data residency\n');
});

test('promoting a soft-wrapped paragraph joins its lines', async () => {
  const t = await setup('alpha beta\ngamma delta\n');
  caret(t.win, { text: 'gamma', at: 0 });
  pressKey(t.win, 'H', { metaKey: true, shiftKey: true });
  assert.equal(t.md(), '###### alpha beta gamma delta\n');
});

test('the selection survives a heading shift for key-repeat', async () => {
  const t = await setup('alpha beta\n');
  rangeSelect(t, 'beta', 0, 'beta', 4);
  pressKey(t.win, 'H', { metaKey: true, shiftKey: true });
  assert.equal(t.md(), '###### alpha beta\n');
  assert.equal(t.win.getSelection().toString(), 'beta', 'selection must survive the re-render');
});

test('Shift+Cmd+H over a select-all shifts every block it touches', async () => {
  const t = await setup('# top\n\npara one\n');
  caret(t.win, { text: 'para', at: 0 });
  pressDocKey(t, 'a', { metaKey: true });   // select-all parks the blocks
  const ev = pressDocKey(t, 'H', { metaKey: true, shiftKey: true });
  assert.ok(ev.defaultPrevented, 'must be handled, not refused');
  assert.equal(t.md(), '# top\n\n###### para one\n');
});

// Deleting a whole bold run must not park the caret in the deletion husk —
// WebKit normalizes a husk-caret to the nearest previous position (in a
// table, the previous cell's tail) and the post-flush refresh then restores
// the drifted caret there. The caret anchors at the husk's slot instead.
test('deleting a whole bold run in a cell keeps the caret in that cell', async () => {
  const t = await setup('| a | b |\n|---|---|\n| left cell | **X** — tail |\n');
  const strong = t.doc.querySelector('strong');
  const sel = t.win.getSelection(), r = t.doc.createRange();
  r.selectNodeContents(strong.firstChild);
  sel.removeAllRanges(); sel.addRange(r);
  const ev = dispatchInput(t, 'deleteContentBackward');
  assert.ok(ev.defaultPrevented);
  const anchor = t.win.getSelection().anchorNode;
  assert.ok(!(anchor.nodeType === 3 && anchor.textContent === ''), 'caret must not sit in the husk');
  const cell = anchor.nodeType === 1 ? anchor.closest('td') : anchor.parentElement.closest('td');
  assert.ok(cell && /tail/.test(cell.textContent), 'caret stays in the edited cell');
  t.win.saveNow();
  assert.ok(t.md().includes('| — tail |'), t.md());
  const a2 = t.win.getSelection().anchorNode;
  const cell2 = a2.nodeType === 1 ? a2.closest && a2.closest('td') : a2.parentElement.closest('td');
  assert.ok(cell2 && /tail/.test(cell2.textContent), 'caret survives the refresh in the edited cell');
});

// The save race: our debounced write can fire after another writer changed
// the file but before the watcher delivered it. Swift declines such writes
// and calls saveDeclined(disk); the editor must restore the honest pre-save
// baseline (saveNow advances it optimistically) and 3-way merge, so both
// writers' changes survive.
test('a declined save merges the unseen disk change with the local edit', async () => {
  const t = await setup('alpha one\n\nbeta two\n');
  const node = [...t.doc.querySelectorAll('#content p')].map(p => p.firstChild)
    .find(n => n && /beta two/.test(n.textContent));
  node.textContent = 'beta twoX';                   // local edit
  t.win.saveNow();                                  // posts, base optimistically advances
  assert.equal(t.saved(), 'alpha one\n\nbeta twoX\n');
  // Meanwhile the other writer changed the FIRST paragraph on disk.
  t.win.saveDeclined('alpha oneY\n\nbeta two\n');
  const merged = t.win.currentMarkdown();
  assert.ok(merged.includes('alpha oneY'), 'disk change survives: ' + merged);
  assert.ok(merged.includes('beta twoX'), 'local edit survives: ' + merged);
  t.win.saveNow(); // flush the debounced persist of the merge
  assert.equal(t.saved(), merged, 'merged result posted as a fresh save');
});

test('saveLanded retires the provisional baseline', async () => {
  const t = await setup('alpha one\n');
  t.doc.querySelector('#content p').firstChild.textContent = 'alpha oneZ';
  t.win.saveNow();
  t.win.saveLanded();
  // A later external change on an idle editor takes disk verbatim — the
  // retired baseline must not resurrect the old save as a "local edit".
  t.win.applyDiskChange('fresh disk\n');
  assert.equal(t.win.currentMarkdown(), 'fresh disk\n');
});

// Double-Enter mid-list exits into a paragraph between the halves. The
// transient paragraph holds no bytes, so the split needs an explicit
// blank-line separator seg — without it the intermediate save glued the
// halves ("- two- three") onto disk if the user left before typing.
test('double-Enter mid-list exits cleanly; the intermediate save is unmangled', async () => {
  const t = await setup('- one\n- two\n- three\n');
  caret(t.win, { text: 'two', at: 3 });
  beforeInput(t.win, 'insertParagraph');   // new empty item after "two"
  beforeInput(t.win, 'insertParagraph');   // exit the list
  assert.equal(t.md(), '- one\n- two\n\n- three\n', 'halves separated, never glued');
  beforeInput(t.win, 'insertText', 'P');
  assert.equal(t.md(), '- one\n- two\n\nP\n\n- three\n');
});

// Left at a block's start / Right at its end: native caret movement dies at
// the contenteditable island boundary — hop to the adjacent block's edge.
test('ArrowLeft at a heading start hops to the end of the previous paragraph', async () => {
  const t = await setup('alpha one\n\n## Heading\n');
  caret(t.win, { text: 'Heading', at: 0 });
  const ev = pressKey(t.win, 'ArrowLeft');
  assert.ok(ev.defaultPrevented, 'must hop, not die');
  const sel = t.win.getSelection();
  assert.ok(/alpha one/.test(sel.anchorNode.textContent), 'caret in previous block');
  assert.equal(sel.anchorOffset, 'alpha one'.length, 'at its end');
});

test('ArrowRight at a paragraph end hops to the start of the next block', async () => {
  const t = await setup('alpha one\n\n## Heading\n');
  caret(t.win, { text: 'alpha one', at: 9 });
  const ev = pressKey(t.win, 'ArrowRight');
  assert.ok(ev.defaultPrevented, 'must hop, not die');
  const sel = t.win.getSelection();
  assert.ok(/Heading/.test(sel.anchorNode.textContent), 'caret in next block');
  assert.equal(sel.anchorOffset, 0, 'at its start');
});

test('ArrowLeft mid-block stays native', async () => {
  const t = await setup('alpha one\n\n## Heading\n');
  caret(t.win, { text: 'Heading', at: 3 });
  const ev = pressKey(t.win, 'ArrowLeft');
  assert.ok(!ev.defaultPrevented, 'mid-block movement is WebKit business');
});

// atBlockStart's "=== 0" never held for prefixed blocks — a heading's first
// display char sits at source offset 3 — so Backspace at a heading start was
// still a dead key while paragraphs merged fine.
test('keydown Backspace at the start of a heading merges it into the previous', async () => {
  const t = await setup('alpha one\n\n## Heading\n');
  caret(t.win, { text: 'Heading', at: 0 });
  const ev = pressKey(t.win, 'Backspace');
  assert.ok(ev.defaultPrevented, 'must be handled at keydown');
  assert.ok(/alpha one.*Heading/s.test(t.md()) && !/##/.test(t.md()), t.md());
});

// HR lifecycle: a paragraph typed down to "---" becomes a rule; Backspace
// just past a rule (or Delete just before) eats one of its source chars, so
// "---" thins to editable "--" text while a longer rule stays a rule; a
// cross-block delete spanning a rule removes it outright.
test('a paragraph edited to --- becomes an hr with the caret below', async () => {
  const t = await setup('alpha one\n\nbeta two\n');
  const node = [...t.doc.querySelectorAll('#content p')].map(p => p.firstChild)
    .find(n => n && /alpha one/.test(n.textContent));
  node.textContent = '--';
  const r0 = t.doc.createRange(); r0.setStart(node, 2); r0.collapse(true);
  t.win.getSelection().removeAllRanges(); t.win.getSelection().addRange(r0);
  beforeInput(t.win, 'insertText', '-');  // the completing dash converts
  assert.equal(t.md(), '---\n\nbeta two\n');
  assert.ok(t.doc.querySelector('#content hr'), 'renders as a rule');
  assert.ok(t.win._segments.some(s => s.transient), 'caret host below the rule');
});

test('Backspace just past an hr thins it to editable text', async () => {
  const t = await setup('para one\n\n---\n\npara two\n');
  caret(t.win, { text: 'para two', at: 0 });
  const ev = pressKey(t.win, 'Backspace');
  assert.ok(ev.defaultPrevented);
  assert.equal(t.md(), 'para one\n\n--\n\npara two\n');
  const dashes = [...t.doc.querySelectorAll('#content [data-seg]')]
    .find(d => d.textContent.trim() === '--');
  assert.equal(dashes.getAttribute('contenteditable'), 'true', '"--" is editable text again');
});

test('Backspace past a five-dash hr leaves a four-dash hr', async () => {
  const t = await setup('para one\n\n-----\n\npara two\n');
  caret(t.win, { text: 'para two', at: 0 });
  pressKey(t.win, 'Backspace');
  assert.equal(t.md(), 'para one\n\n----\n\npara two\n');
  assert.ok(t.doc.querySelector('#content hr'), 'still a rule');
});

test('forward Delete just before an hr thins it from the front', async () => {
  const t = await setup('para one\n\n---\n\npara two\n');
  caret(t.win, { text: 'para one', at: 8 });
  const ev = pressKey(t.win, 'Delete');
  assert.ok(ev.defaultPrevented);
  assert.equal(t.md(), 'para one\n\n--\n\npara two\n');
});

test('a cross-block delete spanning an hr removes it', async () => {
  const t = await setup('para one\n\n---\n\npara two\n');
  rangeSelect(t, 'para one', 5, 'para two', 5);
  dispatchInput(t, 'deleteContentBackward');
  assert.ok(!/---/.test(t.md()), t.md());
  assert.ok(/para two/.test(t.md()) && /para /.test(t.md()), t.md());
});

test('typing dashes on a fresh line reaches an hr; dash-space still bullets', async () => {
  const t = await setup('alpha one\n');
  caret(t.win, { text: 'alpha one', at: 9 });
  beforeInput(t.win, 'insertParagraph');            // transient below
  beforeInput(t.win, 'insertText', '-');            // escaped literal dash
  assert.ok(t.md().includes('\\-'), 'lone dash stays literal: ' + JSON.stringify(t.md()));
  assert.ok(!t.doc.querySelector('#content li'), 'no premature bullet');
  // continue to "---": simulate the remaining native keystrokes in the DOM
  const dashNode = [...t.doc.querySelectorAll('#content [data-seg]')]
    .flatMap(d => [...d.querySelectorAll('p')]).map(p => p.firstChild)
    .find(n => n && n.textContent === '-');
  dashNode.textContent = '--';
  const r1 = t.doc.createRange(); r1.setStart(dashNode, 2); r1.collapse(true);
  t.win.getSelection().removeAllRanges(); t.win.getSelection().addRange(r1);
  beforeInput(t.win, 'insertText', '-');
  assert.ok(t.doc.querySelector('#content hr'), 'three dashes became a rule');
  assert.equal(t.md(), 'alpha one\n\n---\n');
  // and the bullet path: fresh line, dash, space
  const t2 = await setup('alpha one\n');
  caret(t2.win, { text: 'alpha one', at: 9 });
  beforeInput(t2.win, 'insertParagraph');
  beforeInput(t2.win, 'insertText', '-');
  beforeInput(t2.win, 'insertText', ' ');
  assert.ok(t2.doc.querySelector('#content li'), 'dash-space starts a list');
  assert.ok(!t2.md().includes('\\-'), 'escape gone: ' + JSON.stringify(t2.md()));
});

// A transient holds no bytes: once the caret settles in a different block it
// is a ghost — a cut paragraph left a visible empty line behind that
// silently evaporated on the next full re-render. Abandonment cleans it up.
test('an abandoned transient (cut-out paragraph) is removed when the caret moves on', async () => {
  const t = await setup('para one\n\npara two\n\npara three\n');
  // cut para two: select its whole text, deleteByCut
  rangeSelect(t, 'para two', 0, 'para two', 8);
  dispatchInput(t, 'deleteByCut');
  t.win.saveNow();
  assert.ok(t.win._segments.some(s => s.transient), 'emptied block held as transient');
  // caret moves to para three and an edit happens there — the save sweeps
  caret(t.win, { text: 'para three', at: 3 });
  t.doc.querySelector('#content [data-seg="4"], #content [data-seg]:last-child');
  const n3 = [...t.doc.querySelectorAll('#content p')].map(p => p.firstChild)
    .find(n => n && /para three/.test(n.textContent));
  n3.textContent = 'para threeX';
  t.win.saveNow();
  assert.ok(!t.win._segments.some(s => s.transient), 'ghost removed');
  assert.equal(t.md(), 'para one\n\npara threeX\n');
  const sel = t.win.getSelection();
  assert.ok(/para three/.test(sel.anchorNode.textContent), 'caret survives the cleanup');
});

test('the transient under the caret is never cleaned up', async () => {
  const t = await setup('alpha one\n');
  caret(t.win, { text: 'alpha one', at: 9 });
  beforeInput(t.win, 'insertParagraph'); // transient below, caret in it
  t.win.saveNow();
  assert.ok(t.win._segments.some(s => s.transient), 'caret-holding transient survives');
});

test('navigating away from a fresh empty line and back keeps it', async () => {
  const t = await setup('alpha one\n\nbeta two\n');
  caret(t.win, { text: 'alpha one', at: 9 });
  beforeInput(t.win, 'insertParagraph');   // open a line below alpha
  assert.ok(t.win._segments.some(s => s.transient));
  caret(t.win, { text: 'beta two', at: 0 }); // arrow away (no edit)
  t.doc.dispatchEvent(new t.win.Event('selectionchange'));
  assert.ok(t.win._segments.some(s => s.transient), 'no edit — the line waits');
});

// An item opening with emphasis maps display offset 0 INSIDE the delimiters
// ("- **C…" → source offset 4); the item-start check compared raw offsets
// against the marker width, so Backspace at such an item's start was a
// silent no-op — repeatedly, as the editor.log showed (2026-08-19 01:31).
test('Backspace at the start of a bold-leading first item outdents it', async () => {
  const t = await setup('- **Credibility:** your customers\n- plain item\n');
  caret(t.win, { text: 'Credibility', at: 0 });
  const ev = pressKey(t.win, 'Backspace');
  assert.ok(ev.defaultPrevented);
  assert.equal(t.md(), '**Credibility:** your customers\n\n- plain item\n');
  const sel = t.win.getSelection();
  assert.ok(/Credibility/.test(sel.anchorNode.textContent), 'caret in the new paragraph');
  assert.equal(sel.anchorOffset, 0, 'at its START, not its end');
});

test('Backspace at the start of a bold-leading later item merges it up', async () => {
  const t = await setup('- plain\n- **bold** second\n');
  caret(t.win, { text: 'bold', at: 0 });
  pressKey(t.win, 'Backspace');
  assert.equal(t.md(), '- plain**bold** second\n');
});

// "1. " on a fresh line starts an ordered list (the numbered sibling of
// dash-space). The lone "1." exists only as literal text — the reconciler
// escapes it — so marker-space realizes the bare ordered item, and Enter
// then continues the numbering.
test('typing "1. " on a fresh line starts a numbered list', async () => {
  const t = await setup('alpha one\n');
  caret(t.win, { text: 'alpha one', at: 9 });
  beforeInput(t.win, 'insertParagraph');       // transient below
  beforeInput(t.win, 'insertText', '1');       // materializes paragraph "1"
  // the "." keystroke is native; emulate its DOM effect
  const n = [...t.doc.querySelectorAll('#content p')].map(p => p.firstChild)
    .find(x => x && x.textContent === '1');
  n.textContent = '1.';
  const sr = t.doc.createRange(); sr.setStart(n, 2); sr.collapse(true);
  t.win.getSelection().removeAllRanges(); t.win.getSelection().addRange(sr);
  beforeInput(t.win, 'insertText', ' ');       // marker-space converts
  assert.ok(t.doc.querySelector('#content ol'), 'ordered list started');
  beforeInput(t.win, 'insertText', 'x');
  assert.equal(t.md().replace(/\n+$/, ''), 'alpha one\n\n1. x');
  beforeInput(t.win, 'insertParagraph');       // next item
  beforeInput(t.win, 'insertText', 'y');
  assert.equal(t.md().replace(/\n+$/, ''), 'alpha one\n\n1. x\n2. y');
});

test('a "2." start keeps its own numbering', async () => {
  const t = await setup('alpha one\n');
  caret(t.win, { text: 'alpha one', at: 9 });
  beforeInput(t.win, 'insertParagraph');
  beforeInput(t.win, 'insertText', '2');
  const n = [...t.doc.querySelectorAll('#content p')].map(p => p.firstChild)
    .find(x => x && x.textContent === '2');
  n.textContent = '2.';
  const sr = t.doc.createRange(); sr.setStart(n, 2); sr.collapse(true);
  t.win.getSelection().removeAllRanges(); t.win.getSelection().addRange(sr);
  beforeInput(t.win, 'insertText', ' ');
  beforeInput(t.win, 'insertText', 'x');
  assert.equal(t.md().replace(/\n+$/, ''), 'alpha one\n\n2. x');
});

// The word-processor gesture from the 01:42 log: typing "1. " at the HEAD of
// an existing paragraph converts that paragraph into the numbered item —
// no empty-item-and-merge dance.
test('typing "1. " at the head of a paragraph converts it to a numbered item', async () => {
  const t = await setup('**Credibility:** your customers\n');
  // native "1." typed at the head; emulate the DOM state, caret after the "."
  const p = t.doc.querySelector('#content p');
  const lead = t.doc.createTextNode('1.');
  p.insertBefore(lead, p.firstChild);
  const sel = t.win.getSelection(), r = t.doc.createRange();
  r.setStart(lead, 2); r.collapse(true);
  sel.removeAllRanges(); sel.addRange(r);
  beforeInput(t.win, 'insertText', ' ');
  assert.equal(t.md().replace(/\n+$/, ''), '1. **Credibility:** your customers');
  assert.ok(t.doc.querySelector('#content ol'), 'renders as an ordered list');
  const s2 = t.win.getSelection();
  assert.ok(/Credibility/.test(s2.anchorNode.textContent), 'caret at the text it prefixed');
  assert.equal(s2.anchorOffset, 0);
});

test('typing "- " at the head of a paragraph converts it to a bullet', async () => {
  const t = await setup('plain words here\n');
  const p = t.doc.querySelector('#content p');
  const lead = t.doc.createTextNode('-');
  p.insertBefore(lead, p.firstChild);
  const sel = t.win.getSelection(), r = t.doc.createRange();
  r.setStart(lead, 1); r.collapse(true);
  sel.removeAllRanges(); sel.addRange(r);
  beforeInput(t.win, 'insertText', ' ');
  assert.equal(t.md().replace(/\n+$/, ''), '- plain words here');
});

test('a space typed mid-paragraph after a coincidental "1." does not convert', async () => {
  const t = await setup('1\\. is a rating, not a list\n');
  caret(t.win, { text: 'rating', at: 6 });
  const ev = beforeInput(t.win, 'insertText', ' ');
  assert.ok(!t.doc.querySelector('#content ol'), 'no conversion away from the marker');
});

// The 2026-08-19 corruption: an hr conversion inside flushSegment re-rendered
// mid-flushActive, and the loop kept folding DETACHED divs whose data-seg
// indices pointed into the shifted segment list — one block's content wrote
// over another segment's source, deleting five headings. Stale divs are
// inert, always.
test('a stale (detached) div never folds into the segments', async () => {
  const t = await setup('alpha one\n\nbeta two\n');
  const stale = t.doc.querySelector('[data-seg="0"]');
  stale.querySelector('p').firstChild.textContent = 'MUTATED';
  await t.win.renderReading();          // rebuild — `stale` is now detached
  assert.ok(!stale.isConnected, 'div must be detached after the re-render');
  assert.equal(t.win.flushSegment(stale), true, 'stale flush is a no-op, not a refusal');
  assert.equal(t.md(), 'alpha one\n\nbeta two\n', 'no stale content folded');
});

// Enter at the START of a heading: "at the start" must be judged in display
// space — the caret maps past "## ", and the old whitespace-only-prefix test
// split the heading into an empty "##" husk plus a bare paragraph, stranding
// an unmappable caret (and the viewport at the top of the document).
test('Enter at the start of a heading opens a paragraph above, intact heading', async () => {
  const t = await setup('para before\n\n## The vendor landscape\n');
  caret(t.win, { text: 'The vendor', at: 0 });
  beforeInput(t.win, 'insertParagraph');
  assert.ok(t.md().includes('## The vendor landscape'), 'heading intact: ' + JSON.stringify(t.md()));
  assert.ok(!/^##\s*$/m.test(t.md()), 'no empty-heading husk');
  assert.ok(t.win._segments.some(s => s.transient), 'transient paragraph above');
  beforeInput(t.win, 'insertText', 'x');
  assert.equal(t.md().replace(/\n+$/, ''), 'para before\n\nx\n\n## The vendor landscape');
});

// Multi-paragraph paste: the old path flattened every newline to a space, so
// pasted paragraphs could never arrive as paragraphs. A paragraph-bearing
// paste now splices into the source (same machinery as cross-block edits);
// single-line pastes stay native, and table cells keep the flattening.
function pasteText(t, text) {
  const sel = t.win.getSelection();
  const ev = new t.win.Event('paste', { bubbles: true, cancelable: true });
  ev.clipboardData = { getData: () => text };
  const a = sel.anchorNode;
  (a.nodeType === 1 ? a : a.parentNode).dispatchEvent(ev);
}

test('pasting two paragraphs lands two paragraphs', async () => {
  const t = await setup('alpha one\n\nomega end\n');
  caret(t.win, { text: 'alpha one', at: 9 });
  pasteText(t, '\n\nfirst para\n\nsecond para');
  assert.equal(t.md().replace(/\n+$/, ''), 'alpha one\n\nfirst para\n\nsecond para\n\nomega end');
});

test('pasting paragraphs over an in-block selection replaces it', async () => {
  const t = await setup('alpha WORD omega\n');
  rangeSelect(t, 'WORD', 0, 'WORD', 4);
  pasteText(t, 'one\n\ntwo');
  assert.equal(t.md().replace(/\n+$/, ''), 'alpha one\n\ntwo omega');
});

test('markdown in a paste arrives as markdown', async () => {
  const t = await setup('alpha one\n\nomega end\n');
  caret(t.win, { text: 'alpha one', at: 9 });
  pasteText(t, '\n\n- bullet a\n- bullet b');
  assert.ok(t.doc.querySelectorAll('#content li').length >= 2, 'bullets render');
  assert.ok(t.md().includes('- bullet a\n- bullet b'), t.md());
});

test('a multi-line paste into a table cell stays flattened', async () => {
  const t = await setup('| a | b |\n|---|---|\n| left | right |\n');
  caret(t.win, { text: 'left', at: 4 });
  pasteText(t, 'x\n\ny');
  t.win.saveNow();
  const md = t.md();
  assert.ok(md.split('\n').length <= 4, 'table stays a table: ' + JSON.stringify(md));
});

// Frontmatter editing: the panel's YAML body is opaque plain text mapping
// byte-for-byte to the content between the fences. The flush is a text
// read; a lone "---" line inside would end the block early and is refused.
test('editing the frontmatter body folds into the fences', async () => {
  const t = await setup('---\nname: doc\n---\n\n# Title\n');
  const pre = t.doc.querySelector('.frontmatter pre');
  pre.textContent = 'name: doc\nauthor: toby';
  const sel = t.win.getSelection(), r = t.doc.createRange();
  r.selectNodeContents(pre); r.collapse(false);
  sel.removeAllRanges(); sel.addRange(r);
  t.win.saveNow();
  assert.equal(t.md(), '---\nname: doc\nauthor: toby\n---\n\n# Title\n');
  assert.equal(t.doc.querySelector('h1').textContent, 'Title', 'document below unharmed');
});

test('Enter in the frontmatter inserts a literal newline', async () => {
  const t = await setup('---\nname: doc\n---\n\n# Title\n');
  const pre = t.doc.querySelector('.frontmatter pre');
  const node = pre.querySelector('code').firstChild;
  const sel = t.win.getSelection(), r = t.doc.createRange();
  r.setStart(node, node.textContent.length); r.collapse(true);
  sel.removeAllRanges(); sel.addRange(r);
  const ev = new t.win.InputEvent('beforeinput', { inputType: 'insertParagraph', bubbles: true, cancelable: true });
  node.parentNode.dispatchEvent(ev);
  assert.ok(ev.defaultPrevented, 'paragraphing intercepted');
  t.win.saveNow();
  assert.equal(t.md(), '---\nname: doc\n\n---\n\n# Title\n');
});

test('frontmatter content that would break the fences is refused', async () => {
  const t = await setup('---\nname: doc\n---\n\n# Title\n');
  const pre = t.doc.querySelector('.frontmatter pre');
  pre.textContent = 'name: doc\n---\nsneaky: line';
  t.win.saveNow();
  assert.equal(t.md(), '---\nname: doc\n---\n\n# Title\n', 'reverted, not corrupted');
});
