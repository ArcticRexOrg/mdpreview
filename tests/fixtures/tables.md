# Tables

A plain table with padded columns.

| Col A | Col B |
|-------|-------|
| one   | two   |
| three | four  |

Alignment markers, and no padding at all.

|Left|Centre|Right|
|:---|:----:|----:|
|a|b|c|
|d|e|f|

Inline formatting inside cells, including a link and a code span.

| Item | Notes |
| --- | --- |
| **bold** | *emphasis* and `code` |
| [a link](https://example.test/x) | plain |
| ![pic](pic.png) | an image |

Cells that are empty, and a row shorter than its header.

| A | B | C |
| - | - | - |
|   | y |   |
| z | | |

No outer pipes, uneven spacing.

Name | Value
---- | -----
alpha    | 1
beta | 22

A pipe escaped inside a cell, which does not divide it.

| Expression | Meaning |
| --- | --- |
| `a \| b` | alternation |
| x \| y | also alternation |

Wide content that stretches one column well past its header.

| k | v |
|---|---|
| a | a much longer value than the header suggests |
