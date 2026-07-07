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

:::unclosed
This fence never closes, so everything stays ordinary paragraphs.

Still ordinary prose here.

::: spaced-name is not a directive either.

Prose with ::: in the middle stays prose.
