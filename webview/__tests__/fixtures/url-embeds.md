# Watching notes

A bare provider link on its own line renders as an inline card, but the source
stays a plain link and must round-trip byte-identically. One line per shape the
provider table (webview/utils/embedProviders.ts) recognizes — a new provider
belongs here as well as in its own unit test:

https://www.youtube.com/watch?v=dQw4w9WgXcQ

https://youtu.be/dQw4w9WgXcQ

https://www.loom.com/share/0123456789abcdef0123456789abcdef

https://www.figma.com/design/BAZsTPbh6W1r66Bdo9xkQp/Design-System

https://www.figma.com/board/BAZsTPbh6W1r66Bdo9xkQp/FigJam-Board

https://www.figma.com/slides/BAZsTPbh6W1r66Bdo9xkQp/Slides

https://www.figma.com/deck/BAZsTPbh6W1r66Bdo9xkQp/Deck

https://www.figma.com/proto/BAZsTPbh6W1r66Bdo9xkQp/Prototype

https://www.figma.com/file/BAZsTPbh6W1r66Bdo9xkQp/Legacy-File-URL

https://github.com/harlanlewis/birta-writer

https://github.com/microsoft/vscode/pull/12345

https://github.com/microsoft/vscode/issues/12345

https://github.com/microsoft/vscode/blob/main/README.md

Shapes that are deliberately NOT carded must survive just as exactly — a known
host in an unrecognized shape, and an unknown host:

https://github.com/microsoft/vscode/tree/main/src

https://gist.github.com/harlanlewis/0123456789abcdef0123456789abcdef

https://vimeo.com/76979871

A titled link is deliberately NOT an embed and stays exactly as written:
[Rick Astley - Never Gonna Give You Up](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

And a link mid-sentence like https://youtu.be/dQw4w9WgXcQ is left inline too.
