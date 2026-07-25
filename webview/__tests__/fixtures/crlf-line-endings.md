# CRLF line endings

This file uses Windows line endings (CRLF) throughout. VS Code hands the
webview the document text verbatim, so the editor really does see the `\r`
bytes -- nothing in the extension normalizes them first.

- a bullet item
- another bullet item

1. an ordered item
2. a second ordered item

> a blockquote line

```js
const x = 1;
```

A closing paragraph.
