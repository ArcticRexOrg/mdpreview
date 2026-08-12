import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { core, marked, fixtures } from './_setup.mjs';
import { mulberry32, genDoc } from './_prop.mjs';

// DOM readback for the StyledDoc model (docs/editing-model.md, migration
// step 2): readBlocksFromDom is the promoted canonicalOfEl — the same walk
// and the same allowlist, but producing model blocks instead of a fingerprint
// string. diffBlocks adopts raw bytes / markers / provenance from the old
// parse for everything the edit didn't touch.
//
// The law that makes `changed:false` and byte fidelity work end to end:
// for an UNTOUCHED rendered block,
//   printBlocks(diffBlocks(parseBlocks(raw), readBlocksFromDom(el))) === raw.

const M = core.Model;

function renderSeg(md) {
  const dom = new JSDOM('<body><div id="b"></div></body>');
  const el = dom.window.document.getElementById('b');
  el.innerHTML = marked.parse(md);
  core.stripStructuralWhitespace(el);
  return { el, doc: dom.window.document };
}

const plain = (b) => (b.text ? b.text.map((c) => (c.obj ? `[${c.obj}]` : c.ch)).join('') : '<raw>');

// --- reader/parser agreement --------------------------------------------------

function assertReadbackFidelity(md, label) {
  for (const seg of core.segment(md, marked)) {
    if (!seg.editable) continue;
    const old = M.parseBlocks(seg.raw, marked);
    if (!old) continue; // out-of-model segment — reconcile refuses it anyway
    const { el } = renderSeg(seg.raw);
    const read = M.readBlocksFromDom(el);
    assert.ok(read, `readback refused a rendered editable block: ${JSON.stringify(seg.raw)} (${label})`);
    const adopted = M.diffBlocks(old, read);
    assert.equal(M.printBlocks(adopted, marked), seg.raw,
      `readback fidelity broken (${label}) for ${JSON.stringify(seg.raw)}\n` +
      `parsed: ${old.map(plain).join('|')}\nread:   ${read.map(plain).join('|')}`);
  }
}

test('untouched readback prints the original bytes, for every fixture block', () => {
  for (const { name, md } of fixtures()) assertReadbackFidelity(md, name);
});

test('untouched readback prints the original bytes over 100 generated docs', () => {
  const rnd = mulberry32(0xD0D0);
  for (let i = 0; i < 100; i++) assertReadbackFidelity(genDoc(rnd, true), `iteration ${i}`);
});

// --- diff adoption -------------------------------------------------------------

test('diffBlocks adopts untouched item raws around a deleted item', () => {
  const raw = '- one\n- two\n- three\n';
  const old = M.parseBlocks(raw, marked);
  const { el } = renderSeg(raw);
  const li = el.querySelectorAll('li')[1];
  li.parentNode.removeChild(li);
  const adopted = M.diffBlocks(old, M.readBlocksFromDom(el));
  assert.equal(M.printBlocks(adopted, marked), '- one\n- three\n');
});

test('diffBlocks adopts inline provenance inside the one changed block', () => {
  const raw = 'keep _em_ here **gone** end\n';
  const old = M.parseBlocks(raw, marked);
  const { el } = renderSeg(raw);
  const strong = el.querySelector('strong');
  strong.parentNode.removeChild(strong);
  const adopted = M.diffBlocks(old, M.readBlocksFromDom(el));
  const out = M.printBlocks(adopted, marked);
  assert.ok(out.includes('_em_'), `untouched underscore emphasis must survive: ${out}`);
  assert.ok(!out.includes('gone'));
});

// --- attribute stack -----------------------------------------------------------

test('ancestor attrs read back: link > strong > em nesting', () => {
  const { el } = renderSeg('a [**b *c*** d](https://x.test/h) e\n');
  const read = M.readBlocksFromDom(el);
  assert.ok(read && read.length === 1);
  const t = read[0].text;
  const at = (s) => t.findIndex((c) => c.ch === s);
  assert.ok(!t[at('a')].attrs.link);
  assert.ok(t[at('b')].attrs.link && t[at('b')].attrs.b && !t[at('b')].attrs.i);
  assert.ok(t[at('c')].attrs.link && t[at('c')].attrs.b && t[at('c')].attrs.i);
  assert.ok(t[at('d')].attrs.link && !t[at('d')].attrs.b);
  assert.ok(!t[at('e')].attrs.link);
  assert.equal(t[at('b')].attrs.link.href, 'https://x.test/h');
});

test('images read back as object chars; hrefs/srcs are de-based', () => {
  const { el } = renderSeg('see ![pic](shot.png) and [d](https://x.test/d)\n');
  el.querySelector('img').setAttribute('src', 'https://base.test/shot.png');
  el.querySelector('a').setAttribute('href', 'https://base.test/d');
  const read = M.readBlocksFromDom(el, 'https://base.test/');
  const obj = read[0].text.find((c) => c.obj);
  assert.equal(obj.src, 'shot.png');
  const linked = read[0].text.find((c) => c.attrs.link);
  assert.equal(linked.attrs.link.href, 'd');
});

// --- allowlist: zombies skipped, structure refused ------------------------------

test('zombie empty inline elements and empty <p> are ignored', () => {
  const { el, doc } = renderSeg('plain text\n');
  const em = doc.createElement('em');
  el.querySelector('p').appendChild(em); // zombie left by a deletion
  el.appendChild(doc.createElement('p')); // browser leftover
  const read = M.readBlocksFromDom(el);
  assert.equal(read.length, 1);
  assert.equal(plain(read[0]), 'plain text');
});

test('readback refuses out-of-model structure with null', () => {
  const { el } = renderSeg('<div><span>x</span></div>\n');
  assert.equal(M.readBlocksFromDom(el), null);
});

// Tables read back as one block per cell, in document order. Only the text is
// taken: pipes, padding and the alignment row are not in the DOM to be read,
// and stay whatever the source said.
test('readback reads a table as its cells', () => {
  const { el } = renderSeg('| a | b |\n|---|---|\n| 1 | 2 |\n');
  const blocks = M.readBlocksFromDom(el);
  assert.equal(blocks.length, 4);
  assert.ok(blocks.every((b) => b.kind === 'cell'));
  assert.deepEqual(blocks.map((b) => b.text.map((c) => c.ch).join('')), ['a', 'b', '1', '2']);
});
