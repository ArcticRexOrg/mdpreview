import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { core, marked } from './_setup.mjs';
import { mulberry32, irange, genInline } from './_prop.mjs';

// The reconciler has two paths into the model: parseBlocks (source -> model)
// and readBlocksFromDom (rendered DOM -> model). Correctness depends on them
// agreeing on what is in-model: if the source side refuses a block the DOM
// side accepts, every edit to that block reverts and it becomes uneditable
// (list bug #1 and its blockquote twin were both exactly this asymmetry).
//
// This is the invariant that pins the two — generated from marked's own
// grammar, including the wrapped/lazy shapes the convergence generator never
// produced, which is why those bugs slipped through.

const EDITABLE = new Set(['paragraph', 'heading', 'blockquote', 'list']);

function renderToDiv(md) {
  const dom = new JSDOM('<body><div id="b"></div></body>');
  const el = dom.window.document.getElementById('b');
  el.innerHTML = marked.parse(md);
  core.stripStructuralWhitespace(el);
  return el;
}

// A source that marked lexes as exactly one editable block (the unit the
// reconciler reasons about). Returns the token, or null if it isn't one.
function singleEditableSeg(md) {
  let toks;
  try { toks = marked.lexer(md); } catch (_) { return null; }
  const real = toks.filter((t) => t.type !== 'space');
  if (real.length !== 1 || !EDITABLE.has(real[0].type)) return null;
  return real[0];
}

// The symmetry check: for a single editable block, the source parser and the
// DOM readback must agree on whether it is in-model.
function symmetric(md) {
  const parsed = core.Model.parseBlocks(md, marked);
  const read = core.Model.readBlocksFromDom(renderToDiv(md));
  return (parsed === null) === (read === null);
}
function assertSymmetric(md) {
  assert.ok(
    symmetric(md),
    `asymmetry — parseBlocks=${core.Model.parseBlocks(md, marked) === null ? 'REFUSED' : 'ok'} ` +
    `readback=${core.Model.readBlocksFromDom(renderToDiv(md)) === null ? 'REFUSED' : 'ok'} ` +
    `for ${JSON.stringify(md)}`
  );
}

// --- the exact bugs, as named regression guards ---------------------------

test('wrapped list item is in-model both ways (bug #1)', () => {
  const md = '- **I6** title here,\n  *every* `code.md` end.\n- next item\n';
  assert.notEqual(core.Model.parseBlocks(md, marked), null, 'source side must accept the wrapped item');
  assertSymmetric(md);
});

test('lazy-continued blockquote is in-model both ways (the twin)', () => {
  const md = '> a point that wraps\nonto a lazy second line\n';
  assert.notEqual(core.Model.parseBlocks(md, marked), null, 'source side must accept the lazy quote');
  assertSymmetric(md);
});

test('explicitly-continued blockquote stays in-model', () => {
  assertSymmetric('> first `code`\n> second *line*\n');
});

test('multi-paragraph quote is out-of-model on BOTH sides (symmetric refusal)', () => {
  const md = '> one\n>\n> two\n';
  assert.equal(core.Model.parseBlocks(md, marked), null, 'two paragraphs: not in the single-paragraph model');
  assertSymmetric(md);
});

// --- generator-driven property: one editable block, possibly wrapped/nested

function genEditableBlock(rnd) {
  switch (irange(rnd, 1, 4)) {
    case 1:
      return '#'.repeat(irange(rnd, 1, 3)) + ' ' + genInline(rnd);
    case 2: { // paragraph, sometimes soft-wrapped
      let p = genInline(rnd);
      if (rnd() < 0.4) p += '\n' + genInline(rnd);
      return p;
    }
    case 3: { // blockquote, sometimes lazy- or explicitly-continued
      let q = '> ' + genInline(rnd);
      if (rnd() < 0.5) q += (rnd() < 0.5 ? '\n' : '\n> ') + genInline(rnd);
      return q;
    }
    default: { // list, items sometimes wrapped, sometimes nested
      const ordered = rnd() < 0.3;
      const items = [];
      for (let i = 0, n = irange(rnd, 1, 4); i < n; i++) {
        const nest = rnd() < 0.25 && i > 0 ? '  ' : '';
        const mk = nest ? (ordered ? '1. ' : '- ') : (ordered ? `${i + 1}. ` : '- ');
        let it = nest + mk + genInline(rnd);
        if (rnd() < 0.4) it += '\n' + nest + '  ' + genInline(rnd); // soft-wrapped item
        items.push(it);
      }
      return items.join('\n');
    }
  }
}

const RUNS = parseInt(process.env.FUZZ_RUNS || '300', 10);

test('parseBlocks and readBlocksFromDom agree on every generated block', () => {
  let checked = 0, wrapped = 0;
  for (let seed = 1; seed <= RUNS; seed++) {
    const rnd = mulberry32(seed * 2654435761);
    const md = genEditableBlock(rnd) + '\n';
    // Only meaningful when marked sees one editable block; mixed markers and
    // the like legitimately split into several segments.
    if (!singleEditableSeg(md)) continue;
    checked++;
    if (/\n\S/.test(md) || /\n {2,}\S/.test(md)) wrapped++;
    assertSymmetric(md);
  }
  assert.ok(checked > RUNS / 2, `expected most blocks to be single-segment, checked ${checked}/${RUNS}`);
  assert.ok(wrapped > 20, `corpus should exercise wrapped/continued blocks, saw ${wrapped}`);
});
