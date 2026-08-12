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

## Provider-side failure states

Cards whose URL shape is valid but whose asset is missing, walled, or refuses a
title. Each must card normally — the failure belongs to the provider and is
shown inside the frame, never as a blank box or a silent drop. samples/content-
inventory.md keeps two of these for a human to look at; this is the full set.

What runs against these automatically is the corpus suite: the file renders and
its bytes round-trip. Whether each card handles its provider's failure well is
NOT asserted anywhere — that needs the provider's real answer, so it is checked
by opening the file. Adding a line here is therefore a claim about round-trip
and a note for a human, not a regression test.

A well-formed YouTube id with no video behind it. The thumbnail request 404s, so
the facade degrades to the branded fallback rather than a blank frame:

https://www.youtube.com/watch?v=aaaaaaaaaaa

A Vimeo video that plays but whose oEmbed answers 404, so the identity strip has
a URL and no title above it:

https://vimeo.com/76979871

A Loom id that resolves to nothing: the player loads and Loom serves its own
"Video not found" page inside the frame:

https://www.loom.com/share/0123456789abcdef0123456789abcdef

Figma keys that are not publicly accessible — a FigJam board and a prototype.
Figma answers with its own notice that only publicly accessible files embed:

https://www.figma.com/board/BAZsTPbh6W1r66Bdo9xkQp/FigJam-Board

https://www.figma.com/proto/BAZsTPbh6W1r66Bdo9xkQp/Prototype

A Google Drive id that resolves to no file, and a published Sheets token whose
publication has been withdrawn (the sign-in wall, which in-frame login cannot
clear — the card's open-externally notice is the way out):

https://drive.google.com/file/d/1AbCdEfGhIjKlMnOpQrStUvWxYz01234/view

https://docs.google.com/spreadsheets/d/e/2PACX-1vSTWLlj1luPBQBGNpzs_npdN7oM-0OFwmfdduufbXSOjxQDD3bkPdeo23xE0r6rHFwX1SWmYM0j9xJW/pubhtml

A Miro board id that resolves to nothing, and synthetic playground ids on all
three providers:

https://miro.com/app/board/uXjVO5X2CWo=/

https://codepen.io/birta/pen/AbCdEf

https://codesandbox.io/s/new-react-sandbox-abc123

https://stackblitz.com/edit/vitejs-vite-abc123

A titled link is deliberately NOT an embed and stays exactly as written:
[Rick Astley - Never Gonna Give You Up](https://www.youtube.com/watch?v=dQw4w9WgXcQ)

And a link mid-sentence like https://youtu.be/dQw4w9WgXcQ is left inline too.
