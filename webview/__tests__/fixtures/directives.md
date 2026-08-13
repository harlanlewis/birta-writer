# Container directives

:::note
A single-paragraph directive.
:::

:::tip Pro tip title
Attached content under a titled fence.
:::

:::warning

Blank-line separated body.

:::

:::info{title="Attrs preserved"}
Attribute syntax stays raw.
:::

::::danger Outer
Outer body.

:::note Inner
Inner body.
:::

::::

:::note
First paragraph.

Second paragraph with **bold** text.

- a list item
- another

:::

:::caution
Unclosed at the end of a section stays a directive only when closed — this one is closed.
:::

:::note
A footnote reference lives inside a directive[^dnote] while its definition sits outside.
:::

[^dnote]: The definition for the footnote referenced above.

:::note
A footnote reference[^dnote2] and its own definition both live inside the same directive, separated from the closing fence by a blank line. That blank line is what MAR-362's shape omits, and the broken shape is deliberately not in this file: it drifts bytes on a zero-edit save, which every corpus sweep reading this fixture would report as a round-trip failure rather than as the parse bug it is.

[^dnote2]: The definition, also inside the directive.

:::

:::unclosed
This fence never closes, so everything stays ordinary paragraphs.

Still ordinary prose here.

::: spaced-name is not a directive either.

Prose with ::: in the middle stays prose.
