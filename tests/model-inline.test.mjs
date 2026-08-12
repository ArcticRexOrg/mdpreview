import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, marked, fixtures } from './_setup.mjs';
import { mulberry32, pick, irange, genInline } from './_prop.mjs';

// The inline layer of the StyledDoc model (docs/editing-model.md, migration
// step 1). Styled text is an array of chars — { ch, attrs } or
// { obj:'image', src, alt, attrs } — with attrs { b, i, code, del,
// link:{href,title} }. parseInline lifts an inline markdown fragment into
// that space (null = refused, unsupported construct); printInline lowers it
// back, reusing original bytes for untouched provenance spans; toggleAttr is
// the model op Cmd+B/Cmd+I reduce to.
//
// The laws here are the spine the rest of the migration hangs from:
//   fidelity:   printInline(parseInline(frag)) === frag   (no op ran)
//   round-trip: parseInline(printInline(t)) ≡ canonText(t)

const M = core.Model;

// --- model-space helpers ----------------------------------------------------

const C = (ch, attrs) => ({ ch, attrs: attrs || {} });
const chars = (s, attrs) => s.split('').map((ch) => C(ch, attrs && { ...attrs }));

function attrsEqual(a, b) {
  a = a || {}; b = b || {};
  if (!!a.b !== !!b.b || !!a.i !== !!b.i || !!a.code !== !!b.code || !!a.del !== !!b.del) return false;
  const la = a.link || null, lb = b.link || null;
  if (!la !== !lb) return false;
  if (la && (la.href !== lb.href || (la.title || '') !== (lb.title || ''))) return false;
  return true;
}

function textEq(x, y) {
  if (x.length !== y.length) return false;
  for (let i = 0; i < x.length; i++) {
    const a = x[i], b = y[i];
    if (!!a.obj !== !!b.obj) return false;
    if (a.obj) { if (a.obj !== b.obj || a.src !== b.src || a.alt !== b.alt) return false; }
    else if (a.ch !== b.ch) return false;
    if (!attrsEqual(a.attrs, b.attrs)) return false;
  }
  return true;
}

const show = (t) => JSON.stringify(t.map((c) => (c.obj ? `[${c.obj}]` : c.ch) + ':' + Object.keys(c.attrs || {}).join('')));

function parseOrThrow(frag) {
  const r = M.parseInline(frag, marked);
  assert.ok(r, `parseInline refused ${JSON.stringify(frag)}`);
  return r;
}

// Inline fragments of the editable blocks of a markdown document.
function fragmentsOf(md) {
  const frags = [];
  for (const seg of core.segment(md, marked)) {
    if (seg.type === 'paragraph') frags.push(seg.raw.replace(/\n+$/, ''));
    else if (seg.type === 'heading') {
      const m = seg.raw.match(/^#{1,6} (.*?)\n*$/s);
      if (m) frags.push(m[1]);
    }
  }
  return frags;
}

// --- law 2: fidelity (no op ran → original bytes) ----------------------------

test('inline fidelity: print(parse(frag)) === frag for every fixture fragment', () => {
  for (const { name, md } of fixtures()) {
    for (const frag of fragmentsOf(md)) {
      const r = M.parseInline(frag, marked);
      if (r === null) continue; // refused constructs are out of model scope
      assert.equal(M.printInline(r.text, r.prov, marked), frag,
        `fidelity broken for ${JSON.stringify(frag)} (${name})`);
    }
  }
});

test('inline fidelity: print(parse(frag)) === frag for 200 generated rich fragments', () => {
  const rnd = mulberry32(0xF1DE);
  let parsed = 0;
  for (let i = 0; i < 200; i++) {
    const frag = genInline(rnd, true);
    const r = M.parseInline(frag, marked);
    if (r === null) continue;
    parsed++;
    assert.equal(M.printInline(r.text, r.prov, marked), frag,
      `fidelity broken for ${JSON.stringify(frag)} (seed iteration ${i})`);
  }
  assert.ok(parsed >= 150, `parser refused too much: only ${parsed}/200 fragments parsed`);
});

test('parse produces the display chars the renderer shows (escapes, entities decode)', () => {
  const r = parseOrThrow('a \\*lit\\* &amp; b');
  assert.equal(r.text.map((c) => c.ch).join(''), 'a *lit* & b');
  const e = parseOrThrow('**bold** plain');
  assert.equal(e.text.map((c) => c.ch).join(''), 'bold plain');
  assert.ok(e.text[0].attrs.b && !e.text[5].attrs.b, 'bold attr covers exactly the run');
});

// --- law 1: round-trip (model survives print → parse, modulo canon) ----------

// Random styled text built directly in model space — including states only an
// op could create (attrs on boundary whitespace), which canonText normalizes.
function genStyled(rnd) {
  const words = ['alpha', 'bravo', 'code', 'x*y', 'a`b', 'd_e'];
  const out = [];
  for (let i = 0, n = irange(rnd, 1, 4); i < n; i++) {
    if (i) out.push(C(' '));
    if (rnd() < 0.08) { out.push({ obj: 'image', src: 'pic.png', alt: 'pic', attrs: {} }); continue; }
    const attrs = {};
    if (rnd() < 0.3) attrs.b = true;
    if (rnd() < 0.3) attrs.i = true;
    if (rnd() < 0.15) attrs.del = true;
    if (rnd() < 0.15) { attrs.code = true; }
    if (rnd() < 0.12) attrs.link = { href: 'https://x.test/' + i };
    const w = pick(rnd, words);
    for (const ch of w) out.push(C(ch, { ...attrs }));
    // occasionally smear the attrs onto the following space (op-created state)
    if (rnd() < 0.2 && i + 1 < n) out.push(C(' ', { ...attrs }));
  }
  return out;
}

test('inline round-trip: parse(print(t)) ≡ canonText(t) over 200 generated styled texts', () => {
  const rnd = mulberry32(0xCAFE);
  for (let i = 0; i < 200; i++) {
    const t = genStyled(rnd);
    const want = M.canonText(t);
    const md = M.printInline(want, null, marked);
    const r = M.parseInline(md, marked);
    assert.ok(r, `printed markdown did not reparse: ${JSON.stringify(md)} from ${show(t)}`);
    assert.ok(textEq(r.text, want),
      `round-trip diverged (iteration ${i})\nprinted: ${JSON.stringify(md)}\nwant: ${show(want)}\ngot:  ${show(r.text)}`);
  }
});

// --- canonText: defines away the unprintable ---------------------------------

test('canonText hoists emphasis attrs off run-boundary whitespace', () => {
  const t = [C(' ', { b: true }), ...chars('ab', { b: true }), C(' ', { b: true }), C('c')];
  const c = M.canonText(t);
  assert.ok(!c[0].attrs.b, 'leading boundary space loses b');
  assert.ok(!c[3].attrs.b, 'trailing boundary space loses b');
  assert.ok(c[1].attrs.b && c[2].attrs.b, 'run core keeps b');
});

test('canonText keeps interior whitespace inside a run', () => {
  const t = [...chars('a', { b: true }), C(' ', { b: true }), ...chars('b', { b: true })];
  const c = M.canonText(t);
  assert.ok(c[1].attrs.b, 'interior space keeps b — the run must not split');
});

// Stricter than markdown requires — `*foo `x`*` is representable — but lifting
// it lets the printer emit bold ending directly before another codespan, whose
// delimiters do not reliably pair. See the note in canonText; this is the
// known cause of the remaining refusals inside emphasised codespans.
test('canonText strips emphasis under code', () => {
  const t = chars('x', { code: true, b: true, i: true });
  const c = M.canonText(t);
  assert.ok(c[0].attrs.code && !c[0].attrs.b && !c[0].attrs.i);
});

// --- the printer's canonical rules (what makes existing byte expectations hold)

test('printer: boundary whitespace prints outside the delimiters', () => {
  const t = M.canonText([...chars('a b', { b: true }), C(' ', { b: true }), C('c')]);
  assert.equal(M.printInline(t, null, marked), '**a b** c');
});

test('printer: b+i nests as *** (strong outside em)', () => {
  assert.equal(M.printInline(chars('w', { b: true, i: true }), null, marked), '***w***');
});

test('printer: literal specials in plain text are escaped', () => {
  const md = M.printInline(chars('*x*'), null, marked);
  const r = M.parseInline(md, marked);
  assert.equal(r.text.map((c) => c.ch).join(''), '*x*');
  assert.ok(!r.text.some((c) => c.attrs.i || c.attrs.b), 'stays literal, not emphasis');
});

test('printer: code content with backticks gets a wider fence', () => {
  const md = M.printInline(chars('a`b', { code: true }), null, marked);
  const r = M.parseInline(md, marked);
  assert.equal(r.text.map((c) => c.ch).join(''), 'a`b');
  assert.ok(r.text.every((c) => c.attrs.code));
});

test('printer: links and images', () => {
  const link = { href: 'https://x.test/d' };
  const t = [...chars('see '), ...chars('doc', { link }), ...chars(' now')];
  assert.equal(M.printInline(t, null, marked), 'see [doc](https://x.test/d) now');
  const img = [{ obj: 'image', src: 'shot.png', alt: 'pic', attrs: {} }];
  assert.equal(M.printInline(img, null, marked), '![pic](shot.png)');
});

test('printer: raw-reuse keeps untouched spans byte-identical around an edit', () => {
  const frag = 'keep _em_ and \\*esc\\* here';
  const { text, prov } = parseOrThrow(frag);
  // edit only the trailing word: 'here' → 'there'
  const edited = text.slice(0, text.length - 4).concat(chars('there'));
  const out = M.printInline(edited, prov, marked);
  assert.ok(out.includes('_em_'), `underscore emphasis must survive untouched: ${out}`);
  assert.ok(out.includes('\\*esc\\*'), `escapes must survive untouched: ${out}`);
  assert.ok(out.endsWith('there'));
});

test('parseInline refuses unsupported constructs with null', () => {
  assert.equal(M.parseInline('a <span>x</span> b', marked), null);
});

// --- toggleAttr: the op that replaces emphasis case analysis -----------------

test('toggleAttr sets the attr on the range (non-whitespace chars, post-canon)', () => {
  const t = chars('one two three');
  const r = M.canonText(M.toggleAttr(t, 4, 7, 'b'));
  for (let i = 0; i < r.length; i++) {
    const inRange = i >= 4 && i < 7;
    assert.equal(!!r[i].attrs.b, inRange, `char ${i} (${r[i].ch})`);
  }
});

test('toggleAttr on a uniformly-set range removes the attr', () => {
  const t = chars('abc', { i: true });
  const r = M.toggleAttr(t, 0, 3, 'i');
  assert.ok(r.every((c) => !c.attrs.i));
});

test('toggleAttr on a mixed range sets everywhere (then a second toggle clears)', () => {
  const t = [...chars('ab', { b: true }), ...chars('cd')];
  const once = M.toggleAttr(t, 0, 4, 'b');
  assert.ok(once.every((c) => c.attrs.b), 'mixed → all set');
  const twice = M.toggleAttr(once, 0, 4, 'b');
  assert.ok(twice.every((c) => !c.attrs.b), 'uniform → cleared');
});

test('toggleAttr involution on uniform ranges, modulo canonText (property)', () => {
  const rnd = mulberry32(0xB0B);
  for (let i = 0; i < 200; i++) {
    const t = M.canonText(genStyled(rnd));
    if (!t.length) continue;
    const a = irange(rnd, 0, t.length - 1);
    const b = irange(rnd, a + 1, t.length);
    const attr = pick(rnd, ['b', 'i', 'del']);
    // toggle³ ≡ toggle¹: the first toggle makes the range uniform, after which
    // toggling is a true involution.
    const t1 = M.canonText(M.toggleAttr(t, a, b, attr));
    const t3 = M.canonText(M.toggleAttr(M.canonText(M.toggleAttr(t1, a, b, attr)), a, b, attr));
    assert.ok(textEq(t1, t3),
      `toggle³ ≠ toggle¹ (iteration ${i}, attr ${attr}, range ${a}..${b})\nt1: ${show(t1)}\nt3: ${show(t3)}`);
  }
});
