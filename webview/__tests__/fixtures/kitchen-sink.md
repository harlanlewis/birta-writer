---
title: Everything at once
tags: [combined, regression]
---

Combined regression
===================

This fixture exercises every serialization feature that landed together in the
Phase 0-2 batch, in a single document, so the corpus guards their *composition*
(not just each in isolation).

A paragraph with _underscore emphasis_, __underscore strong__, *star emphasis*,
and **star strong** on shared lines, plus `inline code`.

Subsection with a formatted link
--------------------------------

A link whose text has formatting: [**bold** and `code` tail](http://example.com)
should stay one link. A reference link [see the spec][spec] keeps its form.

[spec]: http://example.com/spec

***

Inline math like $E = mc^2$ renders in place, and prices like $5 and $10 stay
text. A footnote reference[^note] points at a definition below.

$$
\int_0^1 x^2 \, dx = \frac{1}{3}
$$

___

| Feature | Notes |
|---|---|
| line breaks | first line<br>second line |
| emphasis | _kept_ in a cell |

- A bullet list item
- With `code` and a [link](http://example.com)

[^note]: The footnote definition, with a second sentence for good measure.
