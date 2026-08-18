# TODO

## Escaping is an unsolved problem in the WYSIWYG editing

The display shows no escape characters, but the source needs them whenever
visible text would otherwise lex as markdown structure. The editor has no
systematic policy for this — individual paths each do something local:

- Typing structure-shaped text into a block (e.g. making a paragraph's first
  characters `1. ` or `- `) produces a candidate source that re-lexes as a
  different block type; the acceptance check refuses it and the edit reverts.
  Nothing escapes the typed characters to keep them as plain text.
- The planned heading demote (Shift+Cmd+G on `### 1. Data residency`) will
  escape on its own (`1\. Data residency`) — a per-feature fix, not a policy.
- Escapes already in the source are invisible in the display and carried
  through the display↔source maps (`unitStarts`), but nothing ever *creates*
  or *removes* them in response to ordinary typing.

A real solution would decide, in one place, when a reconciled source gets an
escape added (display text that would change meaning) or removed (an escape
whose reason has gone), so every path — typing, deleting, block conversions —
agrees. Decided 2026-08-18: fine to leave unsolved for now; individual
features escape locally where they must.
