# Formatted links

Formatted link: [**bold** and `code` tail](https://example.com/a).

Emphasis inside: [*em* inside](https://example.com/b) and strike inside: [~~gone~~ tail](https://example.com/c).

Inline code only: [`code`](https://example.com/d).

Titled: [**bold** titled](https://example.com/e "The Title").

CJK link text: [**加粗**链接](https://example.com/f)。

Strong around a link: **before [link](https://example.com/g) after**.

Whole-link emphasis: **[wrapped](https://example.com/h)** and *[also](https://example.com/h)*.

Adjacent same-URL links: [a](https://example.com/i) [b](https://example.com/i) must stay separate.

Balanced parens in a bare destination (Wikipedia-style disambiguation link): [French Revolution](https://en.wikipedia.org/wiki/French_Revolution_(1789)).

Escaped parens in a bare destination: [escaped example](https://example.com/foo\(bar\)).

A quoted title containing parens: [quoted title](https://example.com/j "Title (with parens)").

A parenthesized-style title, the third CommonMark title delimiter alongside quotes: [paren title](https://example.com/k (A title)).

A parenthesized-style title with escaped nested parens: [nested paren title](https://example.com/l (A title \(nested\))).

Reference form: [**bold** text][ref] closes it out.

[ref]: https://example.com/ref
