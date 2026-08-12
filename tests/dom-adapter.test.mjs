import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { core, marked } from './_setup.mjs';

// The DOM caret adapter maps between a rendered block element and source
// offsets — selection plumbing for the structural ops. (Edit readback lives
// in the model: readBlocksFromDom / reconcileDomEdit.)

// Render one block's markdown into a detached <div data-seg> like the app does.
// The app strips structural whitespace at render time (so textContent matches
// the token display model); mirror that here via core.stripStructuralWhitespace.
// The document is created first and handed to segment(), as the app does:
// that is what builds the block's coordinate map and decides editability.
// Segmenting without one leaves the token unmapped and exercises nothing.
function renderBlock(md) {
  const dom = new JSDOM('<!DOCTYPE html><div id="seg"></div>');
  const doc = dom.window.document;
  const seg = core.segment(md, marked, doc)[0];
  const el = doc.getElementById('seg');
  el.innerHTML = marked.parser([seg.token]);
  core.stripStructuralWhitespace(el);
  return { seg, el, win: dom.window };
}

// Find the text node + local offset for a given linear display offset.
function locate(el, dispOffset) {
  const w = el.ownerDocument.createTreeWalker(el, el.ownerDocument.defaultView.NodeFilter.SHOW_TEXT);
  let acc = 0, node;
  while ((node = w.nextNode())) {
    if (dispOffset <= acc + node.textContent.length) return { node, offset: dispOffset - acc };
    acc += node.textContent.length;
  }
  return { node, offset: node ? node.textContent.length : 0 };
}

test('source offset round-trips through the DOM for plain text', () => {
  const md = 'hello world';
  const { seg, el } = renderBlock(md);
  for (const src of [0, 5, 6, 11]) {
    const { node, offset } = core.sourceOffsetToDom(el, src, seg.token);
    assert.equal(core.domOffsetToSourceOffset(el, node, offset, seg.token), src, `offset ${src}`);
  }
});

test('a caret inside bold maps to the right source offset (past the **)', () => {
  const md = 'a **bold** c';
  const { seg, el } = renderBlock(md);
  // A caret at the start of the bold text node is source offset 4 (past "a **").
  const node = el.querySelector('strong').firstChild;
  assert.equal(core.domOffsetToSourceOffset(el, node, 0, seg.token), 4);
});

test('selecting an emphasized word maps its end inside the closing delimiter', () => {
  // Selecting the visible text "bold" of **bold**: the start biases into the
  // run (past the opening **), and the end must bias to the run's inner end
  // (before the closing **), not jump past it — otherwise unwrap can't see the
  // delimiters. md "a **bold** c": inner "bold" is source [4,8).
  const md = 'a **bold** c';
  const { seg, el } = renderBlock(md);
  const start = locate(el, 2); // display start of "bold"
  const end = locate(el, 6);   // display end of "bold"
  assert.equal(core.domOffsetToSourceOffset(el, start.node, start.offset, seg.token, 'start'), 4);
  assert.equal(core.domOffsetToSourceOffset(el, end.node, end.offset, seg.token, 'end'), 8);
});

test('offsets inside an escape clamp to the leaf boundary', () => {
  const md = 'x \\* y';
  const { seg, el } = renderBlock(md);
  // Display "x * y": offset 2 is the "*" (one display char ↔ two source bytes "\\*").
  const before = locate(el, 2);
  const after = locate(el, 3);
  assert.equal(core.domOffsetToSourceOffset(el, before.node, before.offset, seg.token), 2);
  assert.equal(core.domOffsetToSourceOffset(el, after.node, after.offset, seg.token), 4);
});

test('editing a plain word folds back through the reconciler', () => {
  const md = 'the quick fox';
  const { seg, el } = renderBlock(md);
  el.querySelector('p').textContent = 'the slow fox';
  const r = core.reconcileDomEdit(el, seg.token, marked);
  assert.equal(r.raw, 'the slow fox');
});

test('editing text inside bold preserves the ** delimiters', () => {
  const md = 'a **bold** c';
  const { seg, el } = renderBlock(md);
  el.querySelector('strong').firstChild.textContent = 'BOLD';
  const r = core.reconcileDomEdit(el, seg.token, marked);
  assert.equal(r.raw, 'a **BOLD** c');
});

test('editing text inside a nested list item folds back (does not drop the edit)', () => {
  const md = '- one\n  * x';
  const { seg, el } = renderBlock(md);
  const lis = el.querySelectorAll('li');
  lis[lis.length - 1].firstChild.textContent = 'xyz'; // type "yz" after "x"
  const r = core.reconcileDomEdit(el, seg.token, marked);
  assert.equal(r.raw, '- one\n  * xyz');
});

// --- Lists ---------------------------------------------------------------
//
// Lists render as multiple sibling <li> elements. The naive linear
// display-offset model breaks here: marked emits structural "\n" between <li>
// tags, and adjacent items are display-adjacent ("one"+"two") while their
// source spans are far apart. Mapping must be anchored to each leaf's own text
// node so end-of-item-1 and start-of-item-2 resolve to distinct source offsets.

// Every content source offset of a block must survive sourceOffsetToDom →
// domOffsetToSourceOffset unchanged.
function assertRoundTrips(md, offsets) {
  const { seg, el } = renderBlock(md);
  for (const src of offsets) {
    const { node, offset } = core.sourceOffsetToDom(el, src, seg.token);
    assert.ok(node, `no node for src ${src} in ${JSON.stringify(md)}`);
    assert.equal(
      core.domOffsetToSourceOffset(el, node, offset, seg.token), src,
      `src ${src} in ${JSON.stringify(md)}`);
  }
}

test('caret round-trips across every content offset of a two-item list', () => {
  // "- one\n- two\n": "one" is src [2,5], "two" is src [8,11].
  assertRoundTrips('- one\n- two\n', [2, 3, 4, 5, 8, 9, 10, 11]);
});

test('end of item 1 and start of item 2 map to distinct source offsets', () => {
  const md = '- one\n- two\n';
  const { seg, el } = renderBlock(md);
  const endOne = core.sourceOffsetToDom(el, 5, seg.token);   // after "one"
  const startTwo = core.sourceOffsetToDom(el, 8, seg.token); // before "two"
  assert.equal(core.domOffsetToSourceOffset(el, endOne.node, endOne.offset, seg.token), 5);
  assert.equal(core.domOffsetToSourceOffset(el, startTwo.node, startTwo.offset, seg.token), 8);
});

test('caret round-trips in a loose list (items wrapped in <p>)', () => {
  // "- one\n\n- two\n": loose; "one" src [2,5], "two" src [9,12].
  assertRoundTrips('- one\n\n- two\n', [2, 5, 9, 12]);
});

test('caret round-trips in an ordered list (multi-char markers)', () => {
  // "1. one\n2. two\n": "one" src [3,6], "two" src [10,13].
  assertRoundTrips('1. one\n2. two\n', [3, 6, 10, 13]);
});

test('caret round-trips into a nested list item and back out', () => {
  // "- one\n  - nested\n- three\n":
  //   "one" src [2,5], "nested" src [10,16], "three" src [19,24].
  assertRoundTrips('- one\n  - nested\n- three\n', [2, 5, 10, 16, 19, 24]);
});

test('a caret inside bold within a list item maps past the **', () => {
  // "- a **bold** x\n": display "a bold x"; "bold" content starts at display 2,
  // source 6 (past "- a **").
  const md = '- a **bold** x\n';
  const { seg, el } = renderBlock(md);
  const start = locate(el, 2); // display start of "bold"
  assert.equal(core.domOffsetToSourceOffset(el, start.node, start.offset, seg.token, 'start'), 6);
});

// --- Cross-block arrow navigation helpers --------------------------------

test('atBlockEdge detects the first/last visual line of a block', () => {
  const block = { top: 100, bottom: 300, height: 200 };
  const firstLine = { top: 102, bottom: 118, height: 16 };
  const middle = { top: 200, bottom: 216, height: 16 };
  const lastLine = { top: 284, bottom: 300, height: 16 };
  assert.equal(core.atBlockEdge(firstLine, block, -1), true);  // Up from first line
  assert.equal(core.atBlockEdge(firstLine, block, 1), false);  // Down from first line: stay
  assert.equal(core.atBlockEdge(middle, block, -1), false);
  assert.equal(core.atBlockEdge(middle, block, 1), false);
  assert.equal(core.atBlockEdge(lastLine, block, 1), true);    // Down from last line
  assert.equal(core.atBlockEdge(lastLine, block, -1), false);
});

test('adjacentEditableSeg finds the next/prev editable block, skipping read-only ones', () => {
  const dom = new JSDOM('<!DOCTYPE html><div id="c">' +
    '<div class="seg" data-seg="0" contenteditable="true">A</div>' +
    '<div class="seg" data-seg="1" contenteditable="false">B</div>' +
    '<div class="seg" data-seg="2" contenteditable="true">C</div></div>');
  const segs = dom.window.document.querySelectorAll('[data-seg]');
  const [a, b, c] = segs;
  assert.equal(core.adjacentEditableSeg(a, 1), c);   // skip the read-only B
  assert.equal(core.adjacentEditableSeg(c, -1), a);
  assert.equal(core.adjacentEditableSeg(a, -1), null);
  assert.equal(core.adjacentEditableSeg(c, 1), null);
  assert.equal(core.adjacentEditableSeg(b, 1), c);
});

test('a caret in a new empty list item resolves to that empty <li>', () => {
  // splitList produces this when Return is pressed at the end of a list.
  const md = '- one\n- two\n- \n';
  const { seg, el } = renderBlock(md);
  const emptyLi = el.querySelectorAll('li')[2];
  assert.equal(emptyLi.textContent, '');
  const { node } = core.sourceOffsetToDom(el, 14, seg.token); // content of the empty item
  assert.equal(node, emptyLi);
  // and reading a caret parked in the empty <li> maps back inside its source span
  const back = core.domOffsetToSourceOffset(el, emptyLi, 0, seg.token);
  assert.ok(back >= 12 && back <= 15, `got ${back}`);
});

test('an interior list edit folds back, untouched items byte-identical', () => {
  const md = '- one\n- two\n';
  const { seg, el } = renderBlock(md);
  // Edit the first item's text node "one" -> "ONE".
  const li = el.querySelectorAll('li')[0];
  li.firstChild.textContent = 'ONE';
  const r = core.reconcileDomEdit(el, seg.token, marked);
  assert.equal(r.raw, '- ONE\n- two\n');
});
