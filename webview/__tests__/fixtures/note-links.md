# Project notes

A note that links to other notes in every way a vault does, and in the places a link cannot live, so a scanner reading the source has to tell them apart. See [the plan](plan.md) and [[Roadmap]] before starting. The [[Meeting notes#Decisions|decisions]] are binding, and [the retro](../archive/retro.md#what-went-wrong) is worth a read.

A path with spaces: [spec](<specs/api spec.md>), one with parens: [v2](design\(v2\).md), one with a title: [glossary](glossary.md "Terms"), one rooted at the vault: [index](/index.md), one encoded: [draft](drafts/first%20draft.md), and one with an entity: [R&D](r&amp;d.md).

A reference link [to the handbook][handbook], a collapsed one [handbook][], a shortcut [handbook], and one whose label differs only in case and spacing [the  HANDBOOK][Handbook].

An escaped bracket \[not a link](nope.md) and inline code `[also not](code.md)` stay text, and so does ``a [double](tick.md) span``.

- A list item linking [first](lists/first.md)
- Another with a wikilink [[Second Note]]
  - Nested [deep](lists/deep.md)

        [indented code in a list](not-a-link.md)

1. An ordered item linking [ordered](lists/ordered.md)
2. And a wikilink with an alias [[Ordered Two|the second]]

> A quote linking [quoted](quoted.md) and [[Quoted Wiki]].
>
> > A nested quote linking [nested](nested-quote.md).

| Page | Link |
| --- | --- |
| One | [one](table/one.md) |
| Two | [[Table Two]] |

```js
// [inside a fence](fence.md) and [[Fence Wiki]]
```

~~~
[inside a tilde fence](tilde.md)
~~~

    [indented code](indented.md)

<!-- [commented out](comment.md) and [[Commented Wiki]] -->

<div>
[inside html](html-block.md)
</div>

$$
[inside math](math.md)
$$

An image is not a link: ![diagram](images/diagram.png), and neither is an embed: ![[Embedded]].

A wikilink right before a parenthesis is a link with brackets in its label: [[Cited]](https://example.com/cite).

External links are not notes: [site](https://example.com), <https://example.com/auto>, [mail](mailto:someone@example.com), [top](#project-notes).

A link can run over a line break: [a long
label](wrapped.md) still counts.

A footnote with links in it.[^1]

[^1]: The source is [[Footnote Source]] and [the appendix](appendix.md).

[handbook]: handbook/index.md "The handbook"
