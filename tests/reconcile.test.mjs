import { test } from 'node:test';
import assert from 'node:assert/strict';
import { core, marked } from './_setup.mjs';

// Step 5: reconcile(base, view, disk, marked) does a per-block 3-way merge.
// base = last common version; view = in-view edits; disk = external change.
// Returns { merged, conflicts:[{segIndex, base, view, disk}] }.

test('disk change to an untouched block hot-swaps with no conflict', () => {
  const base = 'A\n\nB\n\nC';
  const view = base; // user touched nothing
  const disk = 'A\n\nB2\n\nC';
  const r = core.reconcile(base, view, disk, marked);
  assert.equal(r.merged, disk);
  assert.deepEqual(r.conflicts, []);
});

test('edits to different blocks both apply with no conflict', () => {
  const base = 'A\n\nB\n\nC';
  const view = 'A2\n\nB\n\nC'; // user edited first block
  const disk = 'A\n\nB\n\nC2'; // disk edited last block
  const r = core.reconcile(base, view, disk, marked);
  assert.equal(r.merged, 'A2\n\nB\n\nC2');
  assert.deepEqual(r.conflicts, []);
});

test('a disk frontmatter change merges with a local body edit', () => {
  const base = '---\nname: old\n---\n\nBody\n';
  const view = '---\nname: old\n---\n\nBody locally edited\n';
  const disk = '---\nname: new\n---\n\nBody\n';
  const r = core.reconcile(base, view, disk, marked);
  assert.equal(r.merged, '---\nname: new\n---\n\nBody locally edited\n');
  assert.deepEqual(r.conflicts, []);
});

test('edits to the same block raise one conflict, view pre-selected', () => {
  const base = 'A\n\nB';
  const view = 'Av\n\nB';
  const disk = 'Ad\n\nB';
  const r = core.reconcile(base, view, disk, marked);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].segIndex, 0);
  assert.equal(r.conflicts[0].base, 'A');
  assert.equal(r.conflicts[0].view, 'Av');
  assert.equal(r.conflicts[0].disk, 'Ad');
  // view wins by default in the merged output
  assert.ok(r.merged.startsWith('Av'));
});

test('identical edits on both sides are not a conflict', () => {
  const base = 'A\n\nB';
  const same = 'A!\n\nB';
  const r = core.reconcile(base, same, same, marked);
  assert.equal(r.merged, same);
  assert.deepEqual(r.conflicts, []);
});

test('a block-count change falls back to a single document-level conflict', () => {
  const base = 'A\n\nB';
  const view = 'A\n\nB\n\nC'; // user added a block
  const disk = 'Ad\n\nB'; // disk edited a block
  const r = core.reconcile(base, view, disk, marked);
  assert.equal(r.conflicts.length, 1);
  assert.equal(r.conflicts[0].segIndex, -1);
  assert.equal(r.merged, view);
});
