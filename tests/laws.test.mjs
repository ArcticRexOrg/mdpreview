import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { core, marked, corpus } from './_setup.mjs';
import { app } from './_app.mjs';

// ===========================================================================
// The law suite.
//
// The example-based suites next door test edits we thought of, on documents we
// wrote. They were all green while task lists, hard line breaks and
// multi-paragraph blockquotes reverted on every keystroke in production. So
// this file is built to fail differently:
//
//   1. The corpus is external (every markdown input in the CommonMark spec).
//      We did not choose it, so it contains the constructs we forgot.
//   2. The assertions are laws over every block and every caret position in
//      that corpus, not hand-picked cases.
//   3. The ratchet below makes retreat detectable. Every law here could be
//      satisfied tomorrow by marking the whole document read-only, so passing
//      the laws is not, by itself, evidence of anything.
//
// THE RATCHET. Two numbers, moving in opposite directions:
//
//   lawfulEditable    blocks we let you edit that obey every law.
//                     CAPABILITY. May only go up.
//   editableUnlawful  blocks we let you edit that break a law — the ones that
//                     eat keystrokes or misplace the caret.
//                     LIES. May only go down. Target: zero.
//
// Making a broken block read-only leaves capability flat and reduces lies:
// allowed, and honest — the block stops pretending. Making a *working* block
// read-only drops capability: blocked. Fixing the adapter raises capability and
// drops lies together. There is no way to satisfy both by giving up.
//
// When either number improves, the run rewrites laws-baseline.json and fails
// once, so the gain is recorded in the diff and can never silently erode.
// ===========================================================================

const here = dirname(fileURLToPath(import.meta.url));
const baselinePath = join(here, 'laws-baseline.json');
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));

const scratchDoc = new JSDOM('<body></body>').window.document;
function render(raw) {
  const el = scratchDoc.createElement('div');
  el.innerHTML = marked.parse(raw);
  core.stripStructuralWhitespace(el);
  return el;
}
function displayText(el) {
  return (el.textContent || '').replace(/\n+$/, '');
}
// Every caret position in a block, keyed by display offset — the canonical
// measure. Equivalent DOM positions either side of a text-node seam share one
// display offset, so this keying carries no false distinctions.
function positions(el) {
  const w = scratchDoc.createTreeWalker(el, 4 /* SHOW_TEXT */);
  const out = [];
  let acc = 0, n;
  while ((n = w.nextNode())) {
    for (let i = 0; i <= n.textContent.length; i++) out.push({ disp: acc + i, node: n, offset: i });
    acc += n.textContent.length;
  }
  return out;
}
function displayOffsetOf(el, node, offset) {
  const r = scratchDoc.createRange();
  r.setStart(el, 0);
  r.setEnd(node, offset);
  return r.toString().length;
}

// --- L2: caret round-trip ---------------------------------------------------
// A caret at display offset d maps to a source offset that maps back to d.
// Anchored on DOM positions rather than source offsets on purpose: source
// offsets inside markup (the "- " of a bullet, the "](" of a link) have no
// caret position and must legitimately clamp, so the reverse direction is not
// an identity and cannot be asserted as one.
function checkCaretRoundTrip(el, token) {
  const bad = [];
  for (const p of positions(el)) {
    const src = core.domOffsetToSourceOffset(el, p.node, p.offset, token);
    const back = core.sourceOffsetToDom(el, src, token);
    if (!back.node) { bad.push({ at: p.disp, got: 'unmapped' }); continue; }
    const d2 = displayOffsetOf(el, back.node, back.offset);
    if (d2 !== p.disp) bad.push({ at: p.disp, got: d2 });
  }
  return bad;
}

// --- L3: edit fidelity ------------------------------------------------------
// Typing a character at display offset d must fold into source such that the
// source re-renders with that character at display offset d. This is the whole
// contract of the editor stated once: what you typed, where you put it.
// Is there a markdown source at all that yields this edit? An oracle that
// owes nothing to our printer: take the user's own bytes and splice the
// character in at the mapped source offset — the naive thing a person would
// do — and see whether that renders what the edit asked for.
//
// Why this matters. Some (text, position) pairs have no markdown encoding:
// typing into "foo-_(bar)_" just after the "-" needs emphasis opening between
// a word character and a "(", and neither * nor _ can flank there. Only raw
// HTML expresses it, which we will not write into someone's file. So the law
// "every position accepts a character" is not achievable, and refusing is
// sometimes correct.
//
// The danger is that "the format can't do it" becomes where bugs go to hide.
// This oracle closes that: it never proves a position impossible, it proves
// positions *possible*. Where a witness exists and we refused, we are worse
// than the most naive strategy imaginable, and that is a defect with no
// argument available. Where none exists, the position is recorded as
// unwitnessed — not excused, just separated, and the count is reported so it
// has to be argued for rather than assumed.
function spliceWitness(raw, token, el, dispPos, wantDisp) {
  let src;
  try {
    const q = positions(el).find((x) => x.disp === dispPos) || { node: el, offset: 0 };
    src = core.domOffsetToSourceOffset(render(raw), q.node, q.offset, token);
  } catch (_) { return false; }
  if (typeof src !== 'number' || src < 0 || src > raw.length) return false;
  const cand = raw.slice(0, src) + 'X' + raw.slice(src);
  const candEl = render(cand);
  return displayText(candEl) === wantDisp &&
         core.canonicalOfEl(candEl) === core.canonicalOfEl(el);
}

function checkEditFidelity(raw, token) {
  const bad = [], unwitnessed = [];
  const want0 = displayText(render(raw));
  for (const p of positions(render(raw))) {
    const el = render(raw);
    const q = positions(el).find((x) => x.disp === p.disp);
    if (!q) { bad.push({ at: p.disp, got: 'no position' }); continue; }
    const t = q.node.textContent;
    q.node.textContent = t.slice(0, q.offset) + 'X' + t.slice(q.offset);
    const want = want0.slice(0, p.disp) + 'X' + want0.slice(p.disp);
    let rec;
    try { rec = core.reconcileDomEdit(el, token, marked); } catch (e) { rec = null; }
    let fail = null;
    if (rec == null) fail = 'refused';
    else if (!rec.changed) fail = 'edit lost';
    else if (displayText(render(rec.raw)) !== want) fail = JSON.stringify(displayText(render(rec.raw))).slice(0, 60);
    if (!fail) continue;
    // A wrong result is a defect whatever the format can express: we wrote
    // bytes that render something the user did not type. Only refusals get to
    // ask whether a source existed at all.
    if (fail !== 'refused' || spliceWitness(raw, token, el, p.disp, want)) bad.push({ at: p.disp, got: fail });
    else unwitnessed.push({ at: p.disp });
  }
  return { bad, unwitnessed };
}

// --- the census -------------------------------------------------------------
// One pass over the corpus, collecting per-block verdicts. Runs once; the
// tests below assert on the result.
const census = await (async function run() {
  const docs = corpus();
  const out = {
    docs: docs.length, blocks: 0, editable: 0,
    lawfulEditable: 0, editableUnlawful: 0, formatLimited: 0,
    idleUnstableDocs: [], byLaw: { L1: 0, L2: 0, L3: 0 }, worst: [],
  };
  for (const { section, md } of docs) {
    // L1 — idle stability, at the app level: rendering a document and flushing
    // it without touching anything must not revert a block, must not alter the
    // text, and must not post a save. This is the exact production symptom.
    let a, idleOk = true;
    try {
      a = await app(md);
      const before = a.md();
      a.win.flushActive();
      const reverted = a.log.filter((l) => l.startsWith('REVERT'));
      if (reverted.length || a.md() !== before || a.saved() !== null) {
        idleOk = false;
        out.idleUnstableDocs.push({ section, md, reverted: reverted.length });
      }
    } catch (e) {
      idleOk = false;
      out.idleUnstableDocs.push({ section, md, reverted: 'threw: ' + e.message });
    }
    if (!idleOk) out.byLaw.L1++;

    let segs;
    try { segs = core.segment(md, marked, scratchDoc); } catch (_) { continue; }
    for (const seg of segs) {
      out.blocks++;
      if (!seg.editable || !seg.token) continue;   // read-only: makes no promise, tells no lie
      out.editable++;
      const el = render(seg.raw);
      const l2 = checkCaretRoundTrip(el, seg.token);
      const l3 = checkEditFidelity(seg.raw, seg.token);
      if (l2.length) out.byLaw.L2++;
      if (l3.bad.length) out.byLaw.L3++;
      if (l3.unwitnessed.length) out.formatLimited++;
      if (idleOk && !l2.length && !l3.bad.length) out.lawfulEditable++;
      else {
        out.editableUnlawful++;
        out.worst.push({ section, raw: seg.raw, l2: l2.length, l3: l3.bad.length });
      }
    }
  }
  out.worst.sort((x, y) => (y.l2 + y.l3) - (x.l2 + x.l3));
  return out;
})();

function report() {
  const lines = [
    `corpus: ${census.docs} documents, ${census.blocks} blocks (${census.editable} presented as editable)`,
    `  lawfulEditable   ${census.lawfulEditable}  (baseline ${baseline.lawfulEditable})`,
    `  editableUnlawful ${census.editableUnlawful}  (baseline ${baseline.editableUnlawful})`,
    `  blocks/docs failing each law: L1 ${census.byLaw.L1}  L2 ${census.byLaw.L2}  L3 ${census.byLaw.L3}`,
    `  formatLimited    ${census.formatLimited}  (blocks with refusals no markdown source could satisfy — see spliceWitness)`,
    'worst offenders:',
    ...census.worst.slice(0, 8).map((w) => `  L2:${String(w.l2).padStart(3)} L3:${String(w.l3).padStart(3)}  ${JSON.stringify(w.raw).slice(0, 64)}`),
  ];
  return lines.join('\n');
}

test('law census (informational)', () => {
  console.log('\n' + report() + '\n');
});

test('RATCHET: capability may not shrink — lawfulEditable never goes down', () => {
  assert.ok(census.lawfulEditable >= baseline.lawfulEditable,
    `lawfulEditable fell from ${baseline.lawfulEditable} to ${census.lawfulEditable}. ` +
    'A block that used to be fully editable no longer is. Marking blocks read-only to ' +
    'quiet the other laws is exactly what this assertion exists to catch.\n' + report());
});

test('RATCHET: lies may not grow — editableUnlawful never goes up', () => {
  assert.ok(census.editableUnlawful <= baseline.editableUnlawful,
    `editableUnlawful rose from ${baseline.editableUnlawful} to ${census.editableUnlawful}. ` +
    'More blocks now accept a caret or a keystroke and handle it wrongly.\n' + report());
});

// Blocks counted lawful despite refusing some keystrokes, on the grounds that
// no markdown source exists for them. That is a real answer, but it is also the
// one place a defect could be filed away and forgotten, so it gets a ratchet of
// its own: the population may shrink, never grow. A change that pushes blocks
// into this bucket has to face the same test as any other regression.
test('RATCHET: format-limited blocks may not grow', () => {
  assert.ok(census.formatLimited <= baseline.formatLimited,
    `formatLimited rose from ${baseline.formatLimited} to ${census.formatLimited}. ` +
    'More blocks now refuse keystrokes and claim the format is at fault. Each ' +
    'needs a witness search that genuinely finds nothing.\n' + report());
});

test('RATCHET: improvements must be recorded in laws-baseline.json', () => {
  // Only ever record from a run that regressed on neither axis. Retreating —
  // marking blocks read-only — drops editableUnlawful and so reads as an
  // improvement on that axis alone; without this guard it would write itself
  // into the baseline on the way past, and the capability it destroyed could
  // never be detected again. (Found by running that exact cheat against this
  // file: it corrupted the baseline before the guard existed.)
  const regressed = census.lawfulEditable < baseline.lawfulEditable ||
                    census.editableUnlawful > baseline.editableUnlawful ||
                    census.formatLimited > baseline.formatLimited;
  if (regressed) return;
  const better = census.lawfulEditable > baseline.lawfulEditable ||
                 census.editableUnlawful < baseline.editableUnlawful ||
                 census.formatLimited < baseline.formatLimited;
  if (!better) return;
  writeFileSync(baselinePath, JSON.stringify({
    note: 'Written by tests/laws.test.mjs. lawfulEditable may only rise; editableUnlawful may only fall. Commit changes to this file with the change that earned them.',
    lawfulEditable: census.lawfulEditable,
    editableUnlawful: census.editableUnlawful,
    formatLimited: census.formatLimited,
    byLaw: census.byLaw,
  }, null, 2) + '\n');
  assert.fail(`Laws improved — baseline rewritten, commit it alongside the change.\n${report()}`);
});

// The standing target, reported as TODO rather than a failure: the ratchets
// above are the hard gates that must stay green on every commit, and a suite
// that is permanently red teaches everyone to ignore it. This line is the
// scoreboard — it turns into a passing test the day the number reaches zero.
test('GOAL: no block is presented as editable while breaking a law', { todo: true }, () => {
  if (census.editableUnlawful === 0) return;
  assert.fail(`${census.editableUnlawful} blocks accept editing they cannot honour. ` +
    'Each must be either fixed or made read-only.\n' + report());
});
