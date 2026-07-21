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
  win.webkit = { messageHandlers: { documentEdited: { postMessage(m) { saved = m; } }, paginationDone: { postMessage() {} } } };
  win.eval(scriptSrc);
  win._rawMarkdown = md;
  win._baseMarkdown = md;
  await win.renderReading(); // await so editing listeners (bound after the await) are live
  return {
    win, doc: win.document,
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
  win.getSelection().anchorNode.parentNode.dispatchEvent(ev);
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
