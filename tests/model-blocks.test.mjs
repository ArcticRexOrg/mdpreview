import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, marked, fixtures } from './_setup.mjs';
import { mulberry32, genDoc } from './_prop.mjs';

// The block layer of the StyledDoc model (docs/editing-model.md, migration
// step 2). A document is a list of blocks — styled (paragraph, heading,
// listItem, quote) carrying styled text, or opaque (code, tables, hr, html,
// separators, refused constructs) carrying raw bytes. A marked list segment
// parses to a flat run of listItem blocks with explicit depth, mirroring how
// the DOM presents <li>s.
//
// The spine law is doc fidelity: printDoc(parseDoc(md)) === md, byte for
// byte, for ANY markdown — styled blocks reuse their raw, opaque blocks are
// inert, so an un-operated document always survives the model unchanged.

const M = core.Model;

const showB = (bs) => JSON.stringify(bs.map((b) => b.kind + (b.level || '') +
  (b.kind === 'listItem' ? `@${b.depth}` : '') + ':' +
  (b.text ? b.text.map((c) => (c.obj ? `[${c.obj}]` : c.ch)).join('') : '<raw>')));

function blocksEq(a, b) {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    const x = a[i], y = b[i];
    if (x.kind !== y.kind) return false;
    if (x.kind === 'opaque') { if (x.raw !== y.raw) return false; continue; }
    if (x.kind === 'heading' && x.level !== y.level) return false;
    if (x.kind === 'listItem') {
      if (x.depth !== y.depth) return false;
      if (x.marker && y.marker && JSON.stringify(x.marker) !== JSON.stringify(y.marker)) return false;
    }
    if (!M.textEq(M.canonText(x.text), M.canonText(y.text))) return false;
  }
  return true;
}

// --- law 2: doc fidelity ------------------------------------------------------

test('doc fidelity: printDoc(parseDoc(md)) === md for every fixture', () => {
  for (const { name, md } of fixtures()) {
    const doc = M.parseDoc(md, marked);
    assert.equal(M.printDoc(doc, marked), md, `fidelity broken for fixture ${name}`);
  }
});

test('doc fidelity over 200 generated rich documents', () => {
  const rnd = mulberry32(0xB10C);
  for (let i = 0; i < 200; i++) {
    const md = genDoc(rnd, true);
    const doc = M.parseDoc(md, marked);
    assert.equal(M.printDoc(doc, marked), md, `fidelity broken (iteration ${i}) for ${JSON.stringify(md)}`);
  }
});

test('doc fidelity for empty-trailing-item quirks', () => {
  for (const md of ['- one\n-', '- one\n  *', '- one\n- \n', '1. a\n2.', '- a\n\n- b\n']) {
    const doc = M.parseDoc(md, marked);
    assert.equal(M.printDoc(doc, marked), md, `fidelity broken for ${JSON.stringify(md)}`);
  }
});

// --- structure ----------------------------------------------------------------

test('nested list parses to a flat listItem run with depths and markers', () => {
  const doc = M.parseDoc('- a\n  * b\n    - c\n', marked);
  const items = doc.blocks.filter((b) => b.kind === 'listItem');
  assert.equal(items.length, 3);
  assert.deepEqual(items.map((b) => b.depth), [0, 1, 2]);
  assert.deepEqual(items.map((b) => b.marker.bullet), ['-', '*', '-']);
  assert.equal(items[1].text.map((c) => c.ch).join(''), 'b');
});

test('ordered list markers carry number and delimiter', () => {
  const doc = M.parseDoc('3. x\n4. y\n', marked);
  const items = doc.blocks.filter((b) => b.kind === 'listItem');
  assert.deepEqual(items.map((b) => b.marker.num), [3, 4]);
  assert.ok(items.every((b) => b.marker.ordered && b.marker.delim === '.'));
  const par = M.parseDoc('1) z\n', marked).blocks[0];
  assert.equal(par.marker.delim, ')');
});

test('heading, quote and table cells parse styled; code/hr stay opaque', () => {
  const md = '## Ti **tle**\n\n> quo *te*\n\n```js\nx\n```\n\n| a |\n|---|\n\n---\n';
  const doc = M.parseDoc(md, marked);
  const kinds = doc.blocks.filter((b) => b.kind !== 'opaque' || b.raw.trim() !== '').map((b) => b.kind);
  assert.deepEqual(kinds, ['heading', 'quote', 'opaque', 'cell', 'opaque']);
  const h = doc.blocks[0];
  assert.equal(h.level, 2);
  assert.equal(h.text.map((c) => c.ch).join(''), 'Ti tle');
  assert.ok(h.text[3].attrs.b && !h.text[0].attrs.b);
});

test('opaque blocks are byte-inert under parse/print', () => {
  const md = '```js\nconst a = 1;\n```\n';
  const doc = M.parseDoc(md, marked);
  assert.ok(doc.blocks.every((b) => b.kind === 'opaque'));
  assert.equal(M.printDoc(doc, marked), md);
});

// --- law 1: round-trip through the canonical printer ---------------------------

// Strip provenance so printDoc must print canonically, then the reparse must
// reproduce the same model: parse(printCanonical(d)) ≡ canon(d).
const stripProv = (doc) => ({
  blocks: doc.blocks.map((b) => (b.kind === 'opaque' ? b : { ...b, raw: null, prov: null })),
});

test('doc round-trip: parseDoc(printDoc(canonical d)) ≡ d over fixtures', () => {
  for (const { name, md } of fixtures()) {
    const doc = M.parseDoc(md, marked);
    const printed = M.printDoc(stripProv(doc), marked);
    const again = M.parseDoc(printed, marked);
    assert.ok(blocksEq(again.blocks, doc.blocks),
      `round-trip diverged for ${name}\nprinted: ${JSON.stringify(printed)}\nwant ${showB(doc.blocks)}\ngot  ${showB(again.blocks)}`);
  }
});

test('doc round-trip over 100 generated rich documents', () => {
  const rnd = mulberry32(0x0D0C);
  for (let i = 0; i < 100; i++) {
    const md = genDoc(rnd, true);
    const doc = M.parseDoc(md, marked);
    const printed = M.printDoc(stripProv(doc), marked);
    const again = M.parseDoc(printed, marked);
    assert.ok(blocksEq(again.blocks, doc.blocks),
      `round-trip diverged (iteration ${i})\nsource:  ${JSON.stringify(md)}\nprinted: ${JSON.stringify(printed)}\nwant ${showB(doc.blocks)}\ngot  ${showB(again.blocks)}`);
  }
});
