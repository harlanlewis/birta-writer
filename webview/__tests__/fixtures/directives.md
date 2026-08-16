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
A footnote reference[^dnote2] and its own definition both live inside the same directive, separated from the closing fence by a blank line.

[^dnote2]: The definition, also inside the directive.

:::

:::note
The same shape with no blank line before the closing fence[^dnote3]. Lazy continuation absorbs that fence into the definition above it, so parsing has to split it back off (MAR-362).

[^dnote3]: The definition the closing fence sits directly under.
:::

:::note
- A list item the closing fence sits directly under.
- Lazy continuation absorbs the fence into this item.
:::

:::note
> A blockquote the closing fence sits directly under.
:::

:::note

| A table the closing fence sits directly under |
|---|
| GFM absorbs that fence as a row, so the repair drops the row (MAR-365). |
:::

:::note

<div>
A raw HTML block the closing fence sits directly under, absorbed into its bytes.
</div>
:::

:::unclosed
This fence never closes, so everything stays ordinary paragraphs.

Still ordinary prose here.

::: spaced-name is not a directive either.

Prose with ::: in the middle stays prose.
