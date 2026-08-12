// Shared loader for the test suite.
// package.json has no "type":"module", so the bundled UMD marked.min.js and our
// editor-core.js are CommonJS to Node; we load them via createRequire from ESM tests.
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync, readdirSync } from 'node:fs';

const require = createRequire(import.meta.url);
const here = dirname(fileURLToPath(import.meta.url));

export const marked = require(join(here, '../MarkdownPreview/Resources/marked.min.js'));
export const core = require(join(here, '../MarkdownPreview/Resources/editor-core.js'));

const fixturesDir = join(here, 'fixtures');

/** Load all fixture markdown files as { name, md }. */
export function fixtures() {
  return readdirSync(fixturesDir)
    .filter((f) => f.endsWith('.md'))
    .sort()
    .map((f) => ({ name: f, md: readFileSync(join(fixturesDir, f), 'utf8') }));
}

export function fixture(name) {
  return readFileSync(join(fixturesDir, name), 'utf8');
}

/**
 * The external corpus the law suite runs on: every markdown input in the
 * CommonMark spec, plus our own fixtures.
 *
 * Deliberately not curated by us. The hand-written suites and the `genBlock`
 * fuzzer were both written against the shapes the model already handled, which
 * is why 245 green tests coexisted with task lists and hard line breaks
 * reverting on every save. A corpus we did not choose is the only kind that
 * can surface the constructs we forgot.
 */
export function corpus() {
  const spec = JSON.parse(readFileSync(join(fixturesDir, 'commonmark-corpus.json'), 'utf8'));
  return spec.examples
    .map((e) => ({ section: e.section, md: e.markdown }))
    .concat(fixtures().map((f) => ({ section: 'fixture:' + f.name, md: f.md })));
}
