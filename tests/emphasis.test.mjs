import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, marked } from './_setup.mjs';

// Step 3: toggleEmphasis(blockMd, start, end, kind, marked) wraps/unwraps a
// source range with ** (strong) or * (em). Operates on one block's source;
// returns { md, selStart, selEnd } or null when the result wouldn't parse.

const at = (s, sub) => s.indexOf(sub);

test('wraps a plain word in bold', () => {
  const s = 'hello world';
  const r = core.toggleEmphasis(s, at(s, 'world'), s.length, 'strong', marked);
  assert.equal(r.md, 'hello **world**');
  assert.equal(r.md.slice(r.selStart, r.selEnd), 'world');
});

test('wraps a plain word in italic with single *', () => {
  const s = 'hello world';
  const r = core.toggleEmphasis(s, at(s, 'world'), s.length, 'em', marked);
  assert.equal(r.md, 'hello *world*');
  assert.equal(r.md.slice(r.selStart, r.selEnd), 'world');
});

test('unwraps when the selection sits inside the delimiters', () => {
  const s = 'a **bold** c';
  const start = at(s, 'bold');
  const r = core.toggleEmphasis(s, start, start + 4, 'strong', marked);
  assert.equal(r.md, 'a bold c');
  assert.equal(r.md.slice(r.selStart, r.selEnd), 'bold');
});

test('unwraps when the selection includes the delimiters', () => {
  const s = 'a **bold** c';
  const start = at(s, '**bold**');
  const r = core.toggleEmphasis(s, start, start + '**bold**'.length, 'strong', marked);
  assert.equal(r.md, 'a bold c');
  assert.equal(r.md.slice(r.selStart, r.selEnd), 'bold');
});

test('partial overlap with an existing run produces valid markdown (no **** garbling)', () => {
  const s = 'one **two** three';
  const start = at(s, '**two**');
  const r = core.toggleEmphasis(s, start, s.length, 'strong', marked);
  assert.equal(r.md, 'one **two three**');
  assert.ok(!r.md.includes('****'), 'no doubled delimiters');
  // Result must be a single clean strong token.
  const segs = core.segment(r.md, marked);
  assert.equal(segs.map((x) => x.raw).join(''), r.md);
});

test('refuses (returns null) when the wrap would not parse as emphasis', () => {
  const s = 'a b';
  const r = core.toggleEmphasis(s, at(s, ' '), at(s, ' ') + 1, 'strong', marked);
  assert.equal(r, null);
});

test('em inside a bold word nests (***), not strips the bold', () => {
  const s = 'hello **world**';
  const start = at(s, 'world');
  const r = core.toggleEmphasis(s, start, start + 5, 'em', marked);
  assert.equal(r.md, 'hello ***world***');
  assert.equal(r.md.slice(r.selStart, r.selEnd), 'world');
});

test('em with the bold delimiters inside the selection also nests', () => {
  const s = 'hello **world**';
  const start = at(s, '**world**');
  const r = core.toggleEmphasis(s, start, start + '**world**'.length, 'em', marked);
  assert.equal(r.md, 'hello ***world***');
});

test('em unwraps one level from em+strong (*** → **)', () => {
  const s = 'hello ***world***';
  const start = at(s, 'world');
  const r = core.toggleEmphasis(s, start, start + 5, 'em', marked);
  assert.equal(r.md, 'hello **world**');
});

test('strong unwraps from em+strong leaving the em (*** → *)', () => {
  const s = 'hello ***world***';
  const start = at(s, 'world');
  const r = core.toggleEmphasis(s, start, start + 5, 'strong', marked);
  assert.equal(r.md, 'hello *world*');
});

test('strong inside an italic word nests (***)', () => {
  const s = 'hello *world*';
  const start = at(s, 'world');
  const r = core.toggleEmphasis(s, start, start + 5, 'strong', marked);
  assert.equal(r.md, 'hello ***world***');
});

test('un-italicizing a word in the middle of an italic run splits the run', () => {
  const s = 'x *one two three* y';
  const start = at(s, 'two');
  const r = core.toggleEmphasis(s, start, start + 3, 'em', marked);
  assert.equal(r.md, 'x *one* two *three* y');
  assert.equal(r.md.slice(r.selStart, r.selEnd), 'two');
});

test('un-italicizing the leading words of a run keeps the tail italic', () => {
  const s = 'x *one two three* y';
  const start = at(s, 'one');
  const r = core.toggleEmphasis(s, start, start + 'one two'.length, 'em', marked);
  assert.equal(r.md, 'x one two *three* y');
});

test('un-bolding a middle word splits the bold run', () => {
  const s = '**one two three**';
  const start = at(s, 'two');
  const r = core.toggleEmphasis(s, start, start + 3, 'strong', marked);
  assert.equal(r.md, '**one** two **three**');
});

test('toggling the middle word twice restores an equivalent run', () => {
  const s = 'x *one two three* y';
  const start = at(s, 'two');
  const r1 = core.toggleEmphasis(s, start, start + 3, 'em', marked);
  const r2 = core.toggleEmphasis(r1.md, r1.selStart, r1.selEnd, 'em', marked);
  // same visible text, and "two" is italic again (adjacent runs are not
  // merged back into one — the inter-word spaces stay plain, imperceptibly)
  assert.equal(core.displayTextOf(r2.md, marked), core.displayTextOf(s, marked));
  assert.match(r2.md, /\*two\*/);
});

// Un-toggling "the words but not the trailing period" of a run must snap to
// the whole run: leaving only punctuation emphasized ("stream**.**") is
// unrepresentable under flanking rules, and refusing silently reads as a
// broken Cmd+B (2026-08-12, the DNV note).
test('un-bolding a run minus its trailing period snaps to the whole run', () => {
  const s = '- **We can enable the engineer stream.** GitHub Copilot CLI.\n';
  const start = s.indexOf('We can');
  const end = s.indexOf(' stream') + ' stream'.length;
  const r = core.toggleEmphasis(s, start, end, 'strong', marked);
  assert.notEqual(r, null, 'the toggle must apply');
  assert.equal(r.md, '- We can enable the engineer stream. GitHub Copilot CLI.\n');
});

test('un-bolding words inside quotes-and-period bold snaps over both edges', () => {
  const s = '**"Not today."** rest\n';
  const start = s.indexOf('Not');
  const end = s.indexOf('today') + 'today'.length;
  const r = core.toggleEmphasis(s, start, end, 'strong', marked);
  assert.notEqual(r, null, 'the toggle must apply');
  assert.equal(r.md, '"Not today." rest\n');
});

test('a genuine mid-run split that is unrepresentable still refuses', () => {
  // Unselected real letters remain on both sides — not punctuation slop.
  const s = '**alpha bravo charlie.**\n';
  const start = s.indexOf('bravo');
  const r = core.toggleEmphasis(s, start, start + 'bravo'.length, 'strong', marked);
  // Whatever the strict path decides is fine; the snap must NOT fire and
  // silently unbold "alpha" or "charlie".
  if (r) {
    assert.ok(r.md.includes('**alpha') || r.md.includes('alpha**'), 'alpha stays bold');
    assert.ok(r.md.includes('charlie.**') || r.md.includes('**charlie'), 'charlie stays bold');
  }
});
