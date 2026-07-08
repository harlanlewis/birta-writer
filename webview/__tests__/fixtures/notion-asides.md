# Notion aside callouts

<aside>
💡 The canonical Notion shape: emoji, one space, text with **bold** inside.

</aside>

<aside>
⚠️ Warning emoji with a variation selector.

</aside>

<aside>
🐛 Self-contained single block, no blank line before the closer.
</aside>

<aside>
📝 Multi-paragraph aside: this raw first segment,

then a separately parsed paragraph with a [link](https://example.com),

- and a list item
- and another

</aside>

<aside>
No emoji at all — still a callout, neutral accent.

</aside>

<aside>
💡 Multi-line raw first segment
continues on a second line before any blank.

</aside>

Degradations stay inert sanitized HTML, byte-preserved:

<aside>
<img src="https://www.notion.so/icons/token_blue.svg" alt="icon" width="40px" />

**Bold title** with the Notion-icon variant.

</aside>

<aside>
💡 An unclosed aside never converts.

Ordinary prose continues here after the unclosed aside above.
