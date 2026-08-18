# Editing model — target architecture

> **Status (2026-06-11): landed.** All four migration steps below are in.
> The model lives in editor-core.js (`Model` namespace); its laws are pinned
> by tests/model-{inline,blocks,dom,ops}.test.mjs. The known frontiers at the
> bottom remain open.

## Why

Every editing bug shipped so far (resurrected deletions, zombie formatting,
Cmd+I nesting instead of splitting, boundary-biased folds) had one root: the
spec of an editing gesture lives in display space ("flip the italic state of
the selected characters") while the implementation manipulated markdown bytes
— delimiter pairing, star-run parity, marker surgery — and approximated the
spec through case analysis. Each unenumerated case was a bug.

## Target

One parser, one printer, a document model in between. Operations are
functions on the model and therefore *are* their specs.

    markdown --parse--> StyledDoc --op--> StyledDoc' --print--> markdown'

- **StyledDoc**: list of blocks.
  - styled block: { kind: paragraph | heading(n) | listItem(depth, marker) |
    quote, text: [ { ch, attrs: {bold, italic, code, link(href), image(src,alt)} } ] }
  - opaque block (code fence, table, hr, html): { raw } — bytes pass through.
- **Operations**: insertText (attrs inherited from caret context), deleteRange,
  toggleAttr(range, attr), splitBlock, mergeBlocks, indent/outdent,
  setBlockKind. No delimiters exist in this space.
- **DOM readback**: rendered DOM ≈ model. Reconciliation = DOM→model, diff,
  print. (editor-core's canonicalOfEl already judges in this space; promote
  it from verifier to the write path and delete source-splicing candidates.)
- **Byte fidelity**: printer reuses original raws for blocks/runs whose model
  is unchanged (_em_ stays _em_, escapes stay as written). Only touched runs
  get freshly printed markdown.

## Laws (the test suite's spine)

1. Round-trip: parse(print(doc)) ≡ doc (model space).
2. Fidelity: print(parse(md)) === md when no op ran.
3. Convergence: render(print(doc)) canonical-equals the live DOM after every
   event (tests/convergence.test.mjs, already enforced).
4. Op semantics: ops are definitionally correct in model space; what needs
   testing shrinks to parse and print.

## Migration order (each step lands behind the existing fuzzer + 167 tests)

1. Inline layer: parse/print of styled text within a block; rebuild
   toggleEmphasis as parse→flip→print with raw-reuse. Deletes star-run
   parity, run-splitting, stripSameKind, absorbed-run validation.
2. DOM reconciliation: replace reconcileDomEdit's byte-splice candidates with
   DOM→model diffing. Deletes srcCandidatesAt boundary enumeration.
3. Block ops: doSplit/doMerge/doIndent/doMergeListItem as model ops. Deletes
   splitBlock/mergeBlock/indentItem/outdentItem byte surgery.
4. Remove the then-dead splicing helpers from editor-core.

## Known frontiers not addressed by this model

- disk↔source 3-way merge (applyDiskChange) — separate convergence boundary,
  still untested by the fuzzer.
- WebKit-vs-jsdom fidelity of emulated default editing — backstopped by the
  editor.log transcript (~/Library/Logs/MarkdownPreview/editor.log).
  Bitten 2026-06-11: whole-list select-delete reverted. Readback modeled only
  the shapes marked renders, but the DOM it reads has been chewed on by
  WebKit's editing engine, which strews artifacts — caret-placeholder `<br>`,
  emptied `<li>`s, stray wrappers — that no rendered markdown contains.
  Resolution: don't catalogue artifacts; judge nodes by what they render.
  A shared visibility predicate (`subtreeVisible`/`brIsContent` in
  editor-core.js) makes readback and canonicalOfEl skip any subtree that
  shows nothing, whatever its tags; only visible out-of-model content
  refuses. Safe because the acceptance check compares display text and
  canonical structure, so skipping can never drop anything visible. Still
  test with remnants real WebKit gestures leave behind (hard-coded in
  dom-reconcile.test.mjs) — jsdom has no editing engine, so hand-built
  mutations are cleaner than reality.
  Bitten again 2026-08-18: a selection delete that empties an inline element
  leaves an *empty text node* inside it, and two pieces of edge logic that
  indexed nodes positionally (edgeItems' items[0], the emphasis-edge hoist's
  firstChild/lastChild) let that husk shield real edge whitespace — every
  candidate failed the display or canon check and the edit reverted. The
  corollary to "judge nodes by what they render" is **judge edges by
  content, never by node position**: any walk that takes a first/last/nth
  node must skip nodes that show nothing. Debugging trap that made this one
  cost three rounds: empty text nodes are invisible to innerHTML
  serialization, so the logged DOM fixture reconciled while the live DOM
  refused. If a FAILED line ever reconciles cleanly from its own logged
  fixture, suspect husks first — and the refusal trace (`why=[…]` on the
  FAILED line, EditorCore.reconcileTrace) now names the stage that refused.
