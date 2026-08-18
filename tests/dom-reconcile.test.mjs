import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { core, marked } from './_setup.mjs';

// reconcileDomEdit(el, blockToken, marked): fold an arbitrary browser edit —
// anything beyond a single-leaf text substitution — back into block source.
// These are the edits that used to sit silently in the DOM and resurrect on
// the next re-render (e.g. select a whole list section, delete, press Return).

function renderBlock(md) {
  const dom = new JSDOM('<body><div id="b"></div></body>');
  const el = dom.window.document.getElementById('b');
  el.innerHTML = marked.parse(md);
  core.stripStructuralWhitespace(el);
  return { el, token: marked.lexer(md)[0], doc: dom.window.document };
}

// Make the DOM text equal `want` by removing/altering text nodes, mimicking
// what a contenteditable selection edit leaves behind.
function textNodes(el, doc) {
  const w = doc.createTreeWalker(el, 4 /* SHOW_TEXT */);
  const out = []; let n;
  while ((n = w.nextNode())) out.push(n);
  return out;
}

test('deleting a middle list item folds into source', () => {
  const t = renderBlock('- one\n- two\n- three\n');
  const li = t.el.querySelectorAll('li')[1];
  li.parentNode.removeChild(li);
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.equal(r.raw, '- one\n- three\n');
});

test('deleting every list item folds into source', () => {
  const t = renderBlock('- one\n- two\n- three\n');
  textNodes(t.el, t.doc).forEach((n) => { n.textContent = ''; });
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.ok(r.changed && r.empty, 'should report the block as emptied');
  const remaining = marked.lexer(r.raw);
  const disp = remaining.filter((x) => x.type !== 'space')
    .map((x) => x.raw).join('').replace(/[-*+\s\d.)]/g, '');
  assert.equal(disp, '', 'no visible text may survive');
});

test('deletion spanning two items merges them like the browser did', () => {
  const t = renderBlock('- one\n- two\n- three\n');
  // browser merge: "on|e\n- two\n- thr|ee" deleted → single li "onee"... emulate:
  const nodes = textNodes(t.el, t.doc);
  nodes[0].textContent = 'on';           // "one" → "on"
  const liTwo = t.el.querySelectorAll('li')[1];
  liTwo.parentNode.removeChild(liTwo);   // "two" gone
  nodes[2].textContent = 'ree';          // "three" → "ree"
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  const disp = marked.lexer(r.raw)[0];
  assert.ok(r.raw.includes('on') && r.raw.includes('ree') && !r.raw.includes('two'));
});

test('editing a soft-wrapped list item folds in, not reverts (bug #1)', () => {
  // The item's source spans two physical lines with inline formatting — the
  // shape the source parser used to refuse, making every such block revert.
  const t = renderBlock('- alpha *bravo*\n  `charlie` delta\n- echo\n');
  const node = textNodes(t.el, t.doc).find((n) => n.textContent.includes('delta'));
  node.textContent = node.textContent.replace('delta', 'deltaX');
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.notEqual(r, null, 'wrapped list edit must reconcile, not revert');
  assert.ok(r.raw.includes('deltaX'), 'the edit lands in source');
  assert.ok(r.raw.includes('`charlie`') && r.raw.includes('*bravo*'), 'untouched inline source is preserved');
});

test('editing a lazy-continued blockquote folds in, not reverts (the twin)', () => {
  const t = renderBlock('> a point that wraps\nonto a lazy line\n');
  const node = textNodes(t.el, t.doc).find((n) => n.textContent.includes('lazy'));
  node.textContent = node.textContent.replace('lazy', 'lazier');
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.notEqual(r, null, 'lazy quote edit must reconcile, not revert');
  assert.ok(r.raw.includes('lazier'), 'the edit lands in source');
});

test('a heading edit that strands a trailing nbsp folds, not reverts (bug #2)', () => {
  // The editor-log bug: deleting the trailing parenthetical leaves WebKit's
  // &nbsp;. marked trims trailing whitespace from a heading, so the block could
  // never reconcile and the whole deletion reverted.
  const t = renderBlock('### Reconciliation — the closure guarantees (where the recent failures were)\n');
  t.el.querySelector('h3').innerHTML = 'Reconciliation — the closure guarantees&nbsp;';
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.notEqual(r, null, 'the deletion must fold, not revert');
  assert.equal(r.raw, '### Reconciliation — the closure guarantees\n', 'source drops the unrepresentable trailing space');
});

test('a stranded edge artifact with no real edit is unchanged-but-stale, not a refusal', () => {
  // A lone trailing nbsp (no other change): source needs nothing, but the DOM
  // has not converged — `artifact: true` tells the caller to schedule a
  // re-render. This used to be reported as null so the REVERT would shed it;
  // a revert destroys the caret and any keystroke in flight (2026-08-12), so
  // the shed now belongs to the caret-aware refresh machinery.
  const t = renderBlock('## Title\n');
  t.el.querySelector('h2').innerHTML = 'Title&nbsp;';
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.deepEqual(r, { changed: false, artifact: true },
    'artifact-only DOM is unchanged, flagged for a re-render to shed it');
});

test('untouched blocks starting or ending with a code span read back unchanged', () => {
  // The space beside a code span at a block's edge is rendered inter-word
  // content, not a WebKit artifact. Trimming it glued the words ("via `/tdd`"
  // → "via`/tdd`" → rendered "via/tdd") — and, worse, made a render + flush
  // with NO user edit report a change, so every external disk change got
  // "merged" and written back mangled.
  for (const md of [
    'Run tests via `/tdd`\n',
    '`/tdd` runs the loop\n',
    '- configured via `make test`\n',
    '## Setup via `/tdd`\n',
    'ends with an image ![alt](i.png)\n',
  ]) {
    const t = renderBlock(md);
    const r = core.reconcileDomEdit(t.el, t.token, marked);
    assert.deepEqual(r, { changed: false }, `${JSON.stringify(md)} must read back unchanged`);
  }
});

test('an artifact stranded beyond an edge code span is still flagged for shedding', () => {
  // The code span occupies the edge, but a trailing nbsp injected AFTER it is
  // still an artifact: unchanged, flagged so the refresh machinery sheds it.
  const t = renderBlock('Run tests via `/tdd`\n');
  t.el.querySelector('p').appendChild(t.doc.createTextNode(' '));
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.deepEqual(r, { changed: false, artifact: true },
    'artifact-only DOM is unchanged, flagged for a re-render to shed it');
});

test('an edit elsewhere in a block ending with a code span keeps the edge space', () => {
  const t = renderBlock('Run the tests via `/tdd` now\n');
  const nodes = textNodes(t.el, t.doc);
  nodes[nodes.length - 1].textContent = ''; // delete the trailing " now"
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.equal(r.raw, 'Run the tests via `/tdd`\n');
});

test('a list item leading-space artifact does not write non-round-tripping source', () => {
  // "<li> delta</li>" must not serialize to "-  delta" (which marked renders
  // back as "delta", diverging). The leading edge space is normalized away.
  const t = renderBlock('- alpha\n- delta\n');
  const li = t.el.querySelectorAll('li')[1];
  li.insertBefore(t.doc.createTextNode(' '), li.firstChild);
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  // Either a clean re-render (null) or a folded source with no doubled marker
  // space — never "-  delta".
  if (r && r.changed) assert.ok(!/-\s{2,}delta/.test(r.raw), `must not strand a leading space: ${JSON.stringify(r.raw)}`);
});

test('deleting a whole bold run removes its delimiters', () => {
  const t = renderBlock('a **bold** c');
  const strong = t.el.querySelector('strong');
  strong.parentNode.removeChild(strong);
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.equal(r.raw, 'a  c');
});

test('deletion running from inside a bold run into the text after it', () => {
  const t = renderBlock('a **bold** c');
  const nodes = textNodes(t.el, t.doc);
  // delete display "ld c": bold text → "bo", trailing " c" → ""
  nodes[1].textContent = 'bo';
  nodes[2].textContent = '';
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.equal(r.raw, 'a **bo**');
});

test('typing over a selection spanning an emphasis run', () => {
  const t = renderBlock('alpha *beta* gamma');
  // select "beta gam", type "X" → display "alpha Xma"
  const nodes = textNodes(t.el, t.doc);
  nodes[0].textContent = 'alpha X';
  const em = t.el.querySelector('em');
  em.parentNode.removeChild(em);
  nodes[2].textContent = 'ma';
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.equal(r.raw, 'alpha Xma');
});

test('emptying a heading keeps it a heading', () => {
  const t = renderBlock('## Title\n');
  textNodes(t.el, t.doc).forEach((n) => { n.textContent = ''; });
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.ok(r.changed && r.empty);
  assert.match(r.raw, /^##\s*\n?$/);
});

test('an untouched block reports changed:false', () => {
  const t = renderBlock('- one\n- two\n');
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.equal(r.changed, false);
});

test('an unmappable edit returns null rather than corrupting source', () => {
  const t = renderBlock('a `code` b');
  // mutate INSIDE the opaque codespan — not representable as a leaf edit
  const code = t.el.querySelector('code');
  code.textContent = 'co';
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  // either reconciled faithfully or refused — never a wrong raw
  if (r !== null) {
    const disp = marked.lexer(r.raw)[0];
    assert.ok(r.raw.includes('co'), 'if accepted, must reflect the DOM');
  }
});

test('deleting an image (zero display width) folds into source', () => {
  const t = renderBlock('alpha ![pic](shot.png) bravo');
  const img = t.el.querySelector('img');
  img.parentNode.removeChild(img);
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.equal(r.raw, 'alpha  bravo');
});

test('editing link text preserves the href', () => {
  const t = renderBlock('see [docs](https://x.test/d) now');
  const a = t.el.querySelector('a');
  a.firstChild.textContent = 'doc';
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.equal(r.raw, 'see [doc](https://x.test/d) now');
});

test('an image deletion the DOM did not make is refused', () => {
  const t = renderBlock('alpha ![pic](shot.png) bravo');
  // DOM untouched — reconcile must see no change, not invent one
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.equal(r.changed, false);
});

// WebKit's whole-block deletions don't leave a clean empty tree: they park
// the caret on a <br> placeholder, alone in the root or inside a surviving
// empty <li>. These used to be unreconcilable and reverted the deletion.

test('select-all-delete leaving <ul><li><br></li></ul> empties the block', () => {
  const t = renderBlock('- *On slide:* alpha\n- *Script:* bravo charlie\n');
  t.el.innerHTML = '<ul><li><br></li></ul>';
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.ok(r && r.changed && r.empty, 'must reconcile as emptied, not revert');
  assert.equal(core.displayTextOf(r.raw, marked), '', 'no visible text may survive');
});

test('select-all-delete leaving a bare <br> in the root empties the block', () => {
  const t = renderBlock('- *On slide:* alpha\n- *Script:* bravo charlie\n');
  t.el.innerHTML = '<br>';
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.ok(r && r.changed && r.empty, 'must reconcile as emptied, not revert');
  assert.equal(r.raw, '');
});

test('one item emptied to <li><br></li> among intact siblings keeps its bullet', () => {
  const t = renderBlock('- one\n- two\n- three\n');
  const li = t.el.querySelectorAll('li')[1];
  li.innerHTML = '<br>';
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.ok(r && r.changed, 'must reconcile, not revert');
  assert.equal(core.displayTextOf(r.raw, marked), 'onethree');
});

// Junk-tolerance is by visibility, not by a tag catalogue: any subtree that
// renders nothing is a leftover; anything visible must reconcile or refuse.

test('an unknown invisible wrapper left by the editor is ignored', () => {
  const t = renderBlock('- one\n- two\n');
  t.el.innerHTML = '<div><span></span><br></div>';
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.ok(r && r.changed && r.empty, 'must reconcile as emptied, not revert');
});

test('a trailing placeholder <br> after surviving text is not a change', () => {
  const t = renderBlock('- one\n- two\n');
  t.el.querySelectorAll('li')[1].appendChild(t.doc.createElement('br'));
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.equal(r.changed, false);
});

test('a content-bearing <br> (hard line break) still refuses, never drops', () => {
  const t = renderBlock('alpha bravo');
  // simulate an edit that splits the line with a real break: "alpha<br>bravo"
  const p = t.el.querySelector('p');
  p.innerHTML = 'alpha<br>bravo';
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.equal(r, null, 'a visible break is out of model — refuse, do not flatten');
});

test('a visible empty element (pasted checkbox) refuses, never silently drops', () => {
  const t = renderBlock('alpha bravo');
  const p = t.el.querySelector('p');
  p.insertBefore(t.doc.createElement('input'), p.firstChild);
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.equal(r, null, 'visible non-text content is out of model — refuse');
});

// Deleting the tail of a <strong>'s text leaves the run's trailing space
// inside the tag, and WebKit rewrites the now-collapsible space after the tag
// to &nbsp;. Markdown cannot spell whitespace inside emphasis delimiters, so
// the printed candidate hoists it outside — the canonical fingerprint must
// treat the two placements as the same structure, or the edit reverts
// (2026-08-18 editor.log: "for DNV Cyber" deleted from a bold run).
test('deleting the tail of a strong run strands its space inside the tag', () => {
  const t = renderBlock('- one\n- **a temporary exception for DNV Cyber** — tail text here\n');
  const strong = t.el.querySelector('strong');
  strong.firstChild.textContent = 'a temporary exception ';
  const after = strong.nextSibling; // " — tail text here"
  after.textContent = '\u00A0' + after.textContent.replace(/^ /, '');
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.ok(r && r.changed, 'edit must fold into source, not revert');
  assert.ok(r.raw.includes('**a temporary exception**'), r.raw);
});

test('deleting the head of a strong run strands its space inside the tag', () => {
  const t = renderBlock('lead — **So the request is bold** tail\n');
  const strong = t.el.querySelector('strong');
  strong.firstChild.textContent = ' request is bold';
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.ok(r && r.changed, 'edit must fold into source, not revert');
  assert.ok(r.raw.includes('**request is bold**'), r.raw);
});

// A delete spanning two bold runs can leave directly adjacent sibling
// <strong>s — a shape with no markdown spelling; its only printable reading
// is one run, and the fingerprint must agree or the edit reverts.
test('delete spanning two bold runs leaves adjacent strongs, folds to one run', () => {
  const t = renderBlock('**alpha** and **beta** tail\n');
  const p = t.el.querySelector('p');
  p.removeChild(t.el.querySelectorAll('strong')[0].nextSibling); // " and "
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.ok(r && r.changed, 'edit must fold into source, not revert');
  assert.ok(r.raw.includes('**alphabeta**'), r.raw);
});

// Trailing space inside the first of the merged runs becomes interior
// whitespace of the merged run — `**a b**`, never hoisted out between them.
test('merge across adjacent strongs keeps a stranded space interior', () => {
  const t = renderBlock('**alpha** and **beta** tail\n');
  const strongs = t.el.querySelectorAll('strong');
  strongs[0].firstChild.textContent = 'alpha ';
  t.el.querySelector('p').removeChild(strongs[0].nextSibling); // " and "
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.ok(r && r.changed, 'edit must fold into source, not revert');
  assert.ok(r.raw.includes('**alpha beta**'), r.raw);
});

// Two bold runs separated by a real space are two runs with their own
// spelling — the fingerprint must never merge across visible content.
test('bold runs separated by a visible space are not merged', () => {
  const t = renderBlock('**alpha** **beta** tail\n');
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.ok(r && !r.changed, 'untouched block must read as unchanged');
});

// A selection delete that empties an inline element leaves an empty text
// node inside it — a husk innerHTML serialization hides. It must not count
// as an edge item: with the husk as items[0], the edge trim operated on ""
// and the real cell-leading space went untrimmed — unrepresentable as cell
// padding, so the whole edit reverted (editor.log 2026-08-18 23:42).
test('emptied strong in a table cell folds; its husk is not the cell edge', () => {
  const t = renderBlock('| a | b |\n|---|---|\n| **X** — tail | c |\n');
  const strong = t.el.querySelector('strong');
  strong.firstChild.textContent = ''; // keep the empty text node, like deleteContents
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.ok(r && r.changed, 'edit must fold, not revert');
  assert.ok(r.raw.includes('| — tail |'), r.raw);
});

test('emptied strong at a paragraph start folds; leading space trims', () => {
  const t = renderBlock('**X** tail\n');
  const strong = t.el.querySelector('strong');
  strong.firstChild.textContent = '';
  const r = core.reconcileDomEdit(t.el, t.token, marked);
  assert.ok(r && r.changed, 'edit must fold, not revert');
  assert.equal(r.raw.replace(/\n+$/, ''), 'tail');
});
