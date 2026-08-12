import { test } from 'node:test';
import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { core, marked } from './_setup.mjs';
import { mulberry32, pick, irange, genDoc } from './_prop.mjs';

// THE editor invariant, fuzzed.
//
// The editor keeps two representations of the document: the rendered DOM the
// user edits, and the markdown source that saves, undo, and re-renders are
// built from. Every bug of the "deleted text comes back" family is the same
// defect: a DOM state the fold-back machinery couldn't represent, kept
// silently, then clobbered by the next render-from-source.
//
// So the property under test is convergence itself, not any specific key
// sequence: after ANY sequence of editing events, flushing the DOM into the
// source and re-reading the source must reproduce exactly the text the DOM
// shows. We drive randomized action sequences (seeded, reproducible) through
// the same beforeinput/keydown entry points WKWebView uses, emulate the
// browser's default mutations for whatever the handlers don't intercept, and
// assert convergence after every single step.

const here = dirname(fileURLToPath(import.meta.url));
const templateHtml = readFileSync(join(here, '../MarkdownPreview/Resources/template.html'), 'utf8');
const scriptSrc = (templateHtml.match(/<script>([\s\S]*?)<\/script>/g) || [])
  .map((b) => b.replace(/^<script>/, '').replace(/<\/script>$/, ''))
  .find((s) => s.includes('marked.use'));

// Random documents and the seeded RNG live in _prop.mjs (shared with the
// model-law suites); the default generator paths there are byte-identical to
// what this file used to define, so seeds reproduce the same documents.

// --- page under test --------------------------------------------------------
async function setup(md) {
  const dom = new JSDOM('<!DOCTYPE html><body><div id="content" class="markdown-body"></div></body>',
    { runScripts: 'outside-only', pretendToBeVisual: true });
  const win = dom.window;
  win.EditorCore = core; win.marked = marked;
  win.hljs = { highlightElement() {} };
  win.mermaid = { initialize() {}, parse() { return Promise.resolve(true); }, render() { return Promise.resolve({ svg: '' }); } };
  win.Paged = { Previewer: function () { this.preview = () => Promise.resolve({}); } };
  win.matchMedia = win.matchMedia || (() => ({ matches: false, addListener() {}, removeListener() {} }));
  win.scrollTo = () => {};
  win.webkit = { messageHandlers: { documentEdited: { postMessage() {} }, paginationDone: { postMessage() {} } } };
  win.eval(scriptSrc);
  win._rawMarkdown = md; win._baseMarkdown = md;
  await win.renderReading();
  return { win, doc: win.document };
}

const editableTextNodes = (t) => {
  const out = [];
  for (const div of t.doc.querySelectorAll('[data-seg][contenteditable="true"]')) {
    const w = t.doc.createTreeWalker(div, t.win.NodeFilter.SHOW_TEXT);
    let n; while ((n = w.nextNode())) { if (n.textContent.length) out.push(n); }
  }
  return out;
};

function setCaret(t, node, offset) {
  const sel = t.win.getSelection(), r = t.doc.createRange();
  r.setStart(node, offset); r.collapse(true);
  sel.removeAllRanges(); sel.addRange(r);
}
function setRange(t, n1, o1, n2, o2) {
  const r = t.doc.createRange();
  try { r.setStart(n1, o1); r.setEnd(n2, o2); } catch { return null; }
  if (r.collapsed) return null;
  const sel = t.win.getSelection();
  sel.removeAllRanges(); sel.addRange(r);
  return r;
}
function fire(t, type, init) {
  const sel = t.win.getSelection();
  if (!sel.rangeCount) return true;
  const anchor = sel.anchorNode;
  const el = anchor.nodeType === 1 ? anchor : anchor.parentNode;
  const Ev = type === 'keydown' ? t.win.KeyboardEvent : t.win.InputEvent;
  const ev = new Ev(type, { ...init, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev.defaultPrevented;
}

// --- the random actions -----------------------------------------------------
// Each returns a short transcript string (for failure reports) or null if it
// couldn't apply (no-op this round).
const ACTIONS = [
  function typeChar(t, rnd) {
    const nodes = editableTextNodes(t);
    if (!nodes.length) return null;
    const n = pick(rnd, nodes), off = irange(rnd, 0, n.textContent.length);
    const ch = pick(rnd, ['x', 'q', ' ', '9']);
    setCaret(t, n, off);
    if (!fire(t, 'beforeinput', { inputType: 'insertText', data: ch })) n.insertData(off, ch);
    return `type ${JSON.stringify(ch)} @ ${JSON.stringify(n.textContent.slice(0, 12))}+${off}`;
  },
  function backspace(t, rnd) {
    const nodes = editableTextNodes(t);
    if (!nodes.length) return null;
    const n = pick(rnd, nodes), off = irange(rnd, 0, n.textContent.length);
    setCaret(t, n, off);
    if (!fire(t, 'beforeinput', { inputType: 'deleteContentBackward' })) {
      if (off > 0) n.deleteData(off - 1, 1);
      // at a text-node boundary inside a block the browser eats the previous
      // node's last char; emulating exactly is fiddly — skip, handlers own it
    }
    return `backspace @ ${JSON.stringify(n.textContent.slice(0, 12))}+${off}`;
  },
  function selectDelete(t, rnd) {
    const nodes = editableTextNodes(t);
    if (nodes.length < 1) return null;
    const a = pick(rnd, nodes), b = pick(rnd, nodes);
    const [n1, n2] = a === b || a.compareDocumentPosition(b) & 4 ? [a, b] : [b, a];
    const o1 = irange(rnd, 0, n1.textContent.length);
    const o2 = n1 === n2 ? irange(rnd, o1, n2.textContent.length) : irange(rnd, 0, n2.textContent.length);
    const r = setRange(t, n1, o1, n2, o2);
    if (!r) return null;
    const desc = `selectDelete ${JSON.stringify(r.toString().slice(0, 24))}`;
    if (!fire(t, 'beforeinput', { inputType: 'deleteContentBackward' })) r.deleteContents();
    return desc;
  },
  function selectType(t, rnd) {
    const nodes = editableTextNodes(t);
    if (nodes.length < 1) return null;
    const a = pick(rnd, nodes), b = pick(rnd, nodes);
    const [n1, n2] = a === b || a.compareDocumentPosition(b) & 4 ? [a, b] : [b, a];
    const o1 = irange(rnd, 0, n1.textContent.length);
    const o2 = n1 === n2 ? irange(rnd, o1, n2.textContent.length) : irange(rnd, 0, n2.textContent.length);
    const r = setRange(t, n1, o1, n2, o2);
    if (!r) return null;
    const desc = `selectType over ${JSON.stringify(r.toString().slice(0, 24))}`;
    if (!fire(t, 'beforeinput', { inputType: 'insertText', data: 'Z' })) {
      r.deleteContents();
      const sel = t.win.getSelection();
      if (sel.rangeCount && sel.anchorNode.nodeType === 3) sel.anchorNode.insertData(sel.anchorOffset, 'Z');
    }
    return desc;
  },
  function pressReturn(t, rnd) {
    const nodes = editableTextNodes(t);
    if (!nodes.length) return null;
    const n = pick(rnd, nodes), off = irange(rnd, 0, n.textContent.length);
    setCaret(t, n, off);
    fire(t, 'beforeinput', { inputType: 'insertParagraph' }); // always handled
    return `return @ ${JSON.stringify(n.textContent.slice(0, 12))}+${off}`;
  },
  function emphasis(t, rnd) {
    const nodes = editableTextNodes(t);
    if (!nodes.length) return null;
    const n = pick(rnd, nodes);
    if (n.textContent.length < 2) return null;
    const o1 = irange(rnd, 0, n.textContent.length - 1);
    const o2 = irange(rnd, o1 + 1, n.textContent.length);
    if (!setRange(t, n, o1, n, o2)) return null;
    const key = pick(rnd, ['b', 'i']);
    fire(t, 'keydown', { key, metaKey: true });
    return `cmd+${key} on ${JSON.stringify(n.textContent.slice(o1, o2))}`;
  },
  function tabIndent(t, rnd) {
    const nodes = editableTextNodes(t);
    if (!nodes.length) return null;
    const n = pick(rnd, nodes);
    setCaret(t, n, 0);
    fire(t, 'keydown', { key: 'Tab', shiftKey: rnd() < 0.4 });
    return `tab @ ${JSON.stringify(n.textContent.slice(0, 12))}`;
  },
  function undoRedo(t, rnd) {
    const shift = rnd() < 0.3;
    fire(t, 'keydown', { key: 'z', metaKey: true, shiftKey: shift });
    return shift ? 'redo' : 'undo';
  },
  function diskEcho(t, rnd) {
    // An external writer touches the file with content matching the last-known
    // source — the constant multi-window case: every save in one window echoes
    // into every other window showing the same file. applyDiskChange rebuilds
    // the whole document; the selection and any pending DOM edit must survive.
    t.win.applyDiskChange(t.win.currentMarkdown());
    return 'diskEcho';
  },
  function strandEdgeWs(t, rnd) {
    // Emulate WebKit stranding whitespace at a block's edge after a delete (the
    // &nbsp; it injects, or a space typed against a boundary) — content no
    // markdown source can hold. The editor must shed it on flush, not strand it
    // and diverge. jsdom never produces the artifact on its own, so probe it.
    const divs = [...t.doc.querySelectorAll('[data-seg][contenteditable="true"]')];
    if (!divs.length) return null;
    const div = pick(rnd, divs);
    const w = t.doc.createTreeWalker(div, t.win.NodeFilter.SHOW_TEXT);
    const tn = []; let x; while ((x = w.nextNode())) if (x.textContent.length) tn.push(x);
    if (!tn.length) return null;
    const ws = rnd() < 0.5 ? String.fromCharCode(0xa0) /* nbsp */ : " ";
    const atEnd = rnd() < 0.5;
    const node = atEnd ? tn[tn.length - 1] : tn[0];
    const off = atEnd ? node.textContent.length : 0;
    setCaret(t, node, off);
    if (!fire(t, 'beforeinput', { inputType: 'insertText', data: ws })) node.insertData(off, ws);
    return `strand ${ws === " " ? "space" : "nbsp"} @ ${atEnd ? "end" : "start"}`;
  },
];

// Display text the source should produce — rendered exactly the way the
// editor renders blocks.
function sourceDisplay(t) {
  let out = '';
  const live = liveSegIndex(t);
  t.win._segments.forEach((seg, i) => {
    if (seg.type === 'space' || seg.transient) return;
    let scratch = t.doc.createElement('div');
    scratch.innerHTML = marked.parse(seg.raw);
    core.stripStructuralWhitespace(scratch);
    if (i === live) scratch = core.normalizeBoundaryWs(scratch);
    out += scratch.textContent.replace(/\n+$/, '');
  });
  return out;
}
// Engine whitespace under the live selection is DOM-only state the source
// legitimately cannot hold — the editor defers that block's re-render rather
// than eat a just-typed space (see refreshSeg) — so the selection's block is
// judged modulo edge whitespace, on BOTH sides: the DOM may hold an artifact
// the source correctly shed, and the source may hold edge whitespace of its
// own that the DOM legitimately renders. Every other block stays strict, and
// strictness returns to this one the moment the selection leaves it.
function liveSegIndex(t) {
  const sel = t.win.getSelection();
  if (!sel.rangeCount) return -1;
  for (const div of t.doc.querySelectorAll('#content [data-seg]'))
    if (div.contains(sel.anchorNode)) return +div.getAttribute('data-seg');
  return -1;
}
function judged(t, div) {
  const sel = t.win.getSelection();
  return sel.rangeCount && div.contains(sel.anchorNode) ? core.normalizeBoundaryWs(div) : div;
}
function domDisplay(t) {
  let out = '';
  for (const div of t.doc.querySelectorAll('#content [data-seg]')) {
    out += judged(t, div).textContent.replace(/\n+$/, '');
  }
  return out;
}

// Formatting must converge too, not just text: a deletion can leave a zombie
// <em>/<strong> in the DOM that the source no longer has, silently formatting
// whatever is typed into it (and making Cmd+I act on the wrong model).
// The structural fingerprint is the core's own — the fuzzer must judge with
// the same eyes the editor verifies with, or the two drift apart.
function skeleton(root) { return core.canonicalOfEl(root); }
function sourceSkeleton(t) {
  const parts = [];
  const live = liveSegIndex(t);
  t.win._segments.forEach((seg, i) => {
    if (seg.type === 'space' || seg.transient) return;
    let scratch = t.doc.createElement('div');
    scratch.innerHTML = marked.parse(seg.raw);
    core.stripStructuralWhitespace(scratch);
    if (i === live) scratch = core.normalizeBoundaryWs(scratch);
    parts.push(skeleton(scratch));
  });
  return parts.filter(Boolean).join('|');
}
function domSkeleton(t) {
  const parts = [];
  for (const div of t.doc.querySelectorAll('#content [data-seg]')) parts.push(skeleton(judged(t, div)));
  return parts.filter(Boolean).join('|');
}

const RUNS = parseInt(process.env.FUZZ_RUNS || '40', 10);
const STEPS = 25;

for (let seed = 1; seed <= RUNS; seed++) {
  test(`editing convergence, seed ${seed}`, async () => {
    const rnd = mulberry32(seed * 2654435761);
    const docMd = genDoc(rnd);
    const t = await setup(docMd);
    const transcript = [`doc: ${JSON.stringify(docMd)}`];
    for (let step = 0; step < STEPS; step++) {
      const desc = pick(rnd, ACTIONS)(t, rnd);
      if (!desc) continue;
      transcript.push(`${step}: ${desc}`);
      // Source must capture the DOM at save time, byte-for-byte in display text.
      t.win.saveNow();
      const fromSource = sourceDisplay(t) + ' ## ' + sourceSkeleton(t);
      const fromDom = domDisplay(t) + ' ## ' + domSkeleton(t);
      if (fromSource !== fromDom) {
        assert.fail(
          `DIVERGED after step ${step} (seed ${seed})\n` +
          transcript.join('\n') +
          `\nsource shows: ${JSON.stringify(fromSource)}` +
          `\nDOM shows:    ${JSON.stringify(fromDom)}` +
          `\nmarkdown:     ${JSON.stringify(t.win.currentMarkdown())}` +
          `\neditor log:\n${t.win.dumpEditorLog().split('\n').slice(-15).join('\n')}`
        );
      }
    }
  });
}
