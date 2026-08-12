# Changelog

---

## [Unreleased]

### Added

- Birta Writer is now published to Open VSX as well as the VS Code Marketplace, so it appears in the built-in extension search of VSCodium, Cursor, Windsurf, Gitpod and the other editors that read that registry, instead of needing a `.vsix` downloaded and installed by hand. It is the same file in both registries and on the GitHub release, covered by the same build-provenance signature, so an install from any of them can be checked against this repository and the exact commit that built it.

- CodePen, CodeSandbox and StackBlitz links now render as embed cards. A pen, sandbox or project link on its own line becomes a quiet card naming its provider, and clicking it loads that provider's own embedded playground, with CodePen opening on the rendered result. A CodePen card asks CodePen's own oEmbed endpoint, and nothing else, for the pen's title to show on the card. As with every provider, the resting card fetches nothing, a frame exists only after you click, each provider's exact hosts are pinned in the shared table that also generates the content-security policy, and a private pen, sandbox or project says it needs you signed in instead of sitting blank.

- Table editing from the keyboard: Cmd+. (Ctrl+. on Windows and Linux) with the caret inside a table now opens the block menu with a Table section acting on the caret's cell. Insert rows above or below, insert columns left or right, set the column's alignment, or delete the row or column. These are the same actions the right-click menu offers, run through the same commands against the same cell, so the two menus cannot drift apart. The menu used to refuse to open inside a table at all.

- Open a link from the keyboard: with the caret on a link, the block menu offers Open Link, which routes exactly like Cmd+Click. In-document anchors scroll to their heading, wiki links resolve through the workspace, web URLs open in your browser, and relative paths open as files.

- View an image full screen from the keyboard: an image block's menu offers View Fullscreen, the same lightbox the image's own zoom button opens, and Escape closes it.

- Google Docs, Sheets, Slides and Drive files, Miro boards, and Linear issues now render as embed cards on a bare link. A published Google document plays in place: a publish-to-web link loads Google's own embed view when you click it, and a Drive file link plays its preview the same way. An ordinary Google editing link becomes a card that names its product with a button to open it in your browser, never a frame, because Google refuses to be framed on those pages. A Miro board opens its login-free live view, which pans and zooms for public boards. A Linear issue renders as a card with the issue key and a title read from the link itself, no network involved, so it joins the GitHub card in working with the network switch off. As with every provider, the resting state is a quiet card, a player exists only after you click, each provider's exact hosts are pinned in the shared table that also generates the content-security policy, and a frame that needs you signed in says so instead of sitting blank.

### Fixed

- A playing embed no longer stops and resets to its thumbnail because you scrolled. In a document taller than the screen, scrolling past a playing video, or editing anywhere above it, could rebuild the card at its resting state and end the playback mid-watch. The card now keeps its place through those redraws for every provider, players and playgrounds alike.

- Searching the block menu with more than one word now matches the words separately, so a phrase like delete table finds the Delete row in a table's menu, where it used to answer that nothing matches unless a row's label carried the exact phrase.

---

## [2026.811.0] - 2026, August 11

### Changed

- Moving a heading in the text now moves the heading line alone; the paragraphs under it stay where they are. Alt+Up on a heading with a paragraph above and below it used to bring everything down to the next heading of the same rank along with it, so reordering a heading against its neighbouring line silently rearranged the whole document below. Section moves have not gone anywhere, they have moved to where they read as intentional: drag a row in the table of contents and the whole section travels, whether you picked the drag up in the outline or on the page, and a drop back on the page is a plain block move again. The drag's dimming and its cursor label follow the pointer across that boundary, so what will move is always what is shown. This covers the gutter drag, the block menu's Move rows (labelled "Move Up" and "Move Down" on a heading now, rather than "Move Section Up" and "Move Section Down"), and Alt+Up / Alt+Down. One exception, unchanged: a collapsed heading still carries the content it is hiding, because leaving it behind would strand blocks you cannot see.

- A drop line is now drawn only where a release will actually land. Dragging a block asks the editor whether this run can go here before it offers the spot, so a line you can see is a drop that will happen, and a spot the move would refuse shows no line and swallows the release instead of appearing to accept it. Nothing about where blocks may go has changed, and no such spot was reachable before this: the rule was upheld by the list of offered positions being written conservatively, which is a different thing from being checked. It is now checked, in the text and in the table of contents alike. One case still shows a line and then declines it, with the notice explaining why: a move whose result would not survive being saved and reopened, which can only be known by trying it.

- A top-level heading no longer carries a horizontal rule under it. Its size and weight already mark the level, and the rule was the one heading that had to be spaced differently in order to carry it: a full paragraph gap below, to keep the line clear of the text it introduces. Every heading level now spaces the same way, which sits a top-level heading a little closer to the section it opens.

### Added

- MDX files open in the visual editor. An `.mdx` file now opens in Birta as an alternative editor (right-click the file, Open With, or set an editor association), in a mode that parses real MDX rather than pretending it is plain Markdown. Prose is edited exactly as in a Markdown document. Everything that makes MDX a program stays inert and untouched: `import` and `export` lines, JSX components and `{expressions}` render as clearly labeled read-only blocks, are never executed, and reach the file byte-for-byte as they arrived, however you edit around them. Markdown nested inside a JSX component is shown but not yet editable. A file that is not valid MDX cannot open visually, because an MDX parse error is fatal where Markdown has none: you get the parser's message and the plain text editor instead, with nothing written. None of this costs a Markdown document anything; the MDX engine loads only when an `.mdx` file actually opens.

### Fixed

- Edits made in the last moments before a save can no longer be lost to a save that misses them. A save asks the editor for its freshest content and waits about a second for the answer; when the answer came too late, the save wrote what it already had, which is right, but the editor still recorded its newer content as saved. Nothing then knew to write those last edits: the file was missing them, the tab showed no unsaved changes, and closing the window discarded them. The editor now waits for the save to confirm what actually reached the document before it records anything as saved, and when a save went ahead without its answer, the missed edits immediately mark the document unsaved again, so the next save or autosave writes them. Reaching this took a document large enough, or a machine busy enough, for serializing to outrun the save's wait.

- Quoting a list, a table, or a code block now works. The Blockquote row of the toolbar's Quote menu, the slash menu's Blockquote, and the palette command all put the whole block inside the quote; pressing the control again takes it back out, and a callout wraps the same way. Any of those on a list or a table did nothing at all before, with no sign the click had been received: the caret sat in a list item or a table cell, where a quote cannot go, and the gesture gave up there instead of quoting the list or the table around it. Quoting a block that CAN hold a quote where it stands is unchanged, so a second paragraph inside a list item is still quoted in place rather than dragging its list in with it. Unquoting from inside a quoted list used to leave the list broken open around that one line; it now lifts the list back out whole.

- Choosing a list for a heading line now turns it into a list item. Bullet, Numbered and Task List, from the toolbar or the slash menu, left the heading exactly as it was, so the line kept its heading rank and never joined a list. The heading becomes an ordinary item, which is the mirror of choosing a heading on a list line and having it leave the list.

- A callout whose first line of body stops being a paragraph now saves in one pass. Quoting or itemizing the block directly under a `[!NOTE]` marker left the callout written as though its body still shared the marker's line, which reads back as a body separated from it, so the blank `>` line the file was going to gain arrived on the save after the one you made. It is written straight away, and the file settles after one save.

- The block handle's Turn into now lands on the type you picked when the block is a quote wrapped around something else. On a quoted list, Paragraph handed back the bullet list and every heading level handed back that same list: one wrapper came off and the conversion stopped there, so the row that lit up afterwards was not the row that was clicked. Each of those picks now goes all the way to the type it names, and a nested quote sheds both layers. A quote holding a table still unquotes and stops, because a table has no prose form to convert into.

- Splitting a list that numbers every item `1.` no longer renumbers the items below the split. Writing `1.` on every line is a common way to let the numbering take care of itself; typing `- ` or `1) ` at the head of such an item splits the list there, and the items after the split kept their meaning but changed their spelling, so a line you never touched showed up in the file's diff as `3.`. The split now leaves the remainder spelled the way the file spells it. Lists numbered the ordinary way were never affected, and lettered and roman numbering are untouched.

- The palette for a selected table column opens where you clicked, instead of near the bottom of the window. Selecting a column put the palette against the far end of the selection, which for anything but a short table meant the opposite end of the screen from the column header you just clicked, and for a column taller than the window meant pinned to the bottom edge with no relationship to the table at all. It now opens just above the column's grab handle, drops below the header row when there is no room above it, follows the handle to the top of the window as you scroll down through a long column, and disappears once the table itself is off screen rather than floating over whatever came next. Scrolling back brings it straight back, and the selection is untouched throughout, so every keyboard action stays available whether the palette is showing or not. Selected rows, cell ranges and whole-block selections follow the same rules.

- A block taller than the window keeps its controls reachable. A table's column handles sit on its top edge, and the buttons for a picture, a table or a code block sit just outside its top right corner, so scrolling down into a long table or a full-page image carried every one of them off the top of the window: the column you were looking at could not be selected, and the picture filling your screen could not be resized, zoomed or opened full screen. Those controls now travel with the block, staying just below the toolbar and clear of the floating section title, for as long as any of the block is on screen, and leaving with it once it has scrolled past rather than lingering over whatever follows. A code block dragged taller than the window keeps its language pill the same way.

- Nested list items are spaced like every other list item. A sub-item sat about twice as far below its parent line as a sibling item did, because the space under the parent's line and the space above the nested list were both being applied where only one was wanted. A single step now separates every line in a list at any depth, and the same step separates a second paragraph, a quote, a callout or a code block written inside an item, which used to take the wider spacing meant for blocks between paragraphs. A quote or callout keeps its own inner padding, so it still reads as a box rather than as another line.

---

## [2026.810.0] - 2026, August 10

### Changed

- The extension icon is the current Birta Writer wordmark. The Extensions view and the Marketplace listing were showing an earlier drawing of it, set lighter and smaller in the tile; the mark is heavier and fills more of the square, so it stays legible at the size the tile is actually drawn.

### Fixed

- A save now checks that the bytes it is about to write reopen as the document on your screen, and writes the editor's own canonical formatting for that one save when they would not. Editing a file that indents its outline more widely than the editor does could damage it silently: the editor writes two spaces per list level and plenty of files use four, so saving one restores your spelling over the editor's, and where a line that arrived in an item kept the editor's narrower indent while the item's own marker line was restored to your wider one, the item's content ended up further left than its marker allows. The lines under it were then far enough past that point to reopen as a code block, or to run together into a single paragraph. An outline three levels deep was enough, which is what a Notion or Obsidian export of an ordinary nested list looks like, and nothing on screen showed it: the file looked right until it was closed and opened again. Dragging a block reached it, and so did pasting one. The check covers what a save writes, not what the editor can express: a document the editor could not have written out faithfully in the first place is left alone rather than reformatted, because reformatting would not fix it. Where the check does fire, that one save reformats more of the file than usual, which you can see in a diff and undo; losing the structure could not be undone, which is the trade.

- A save that reformats your file now settles there, instead of partly reversing itself on the next save. When a save cannot write your own spelling of a construct safely, it writes the editor's own formatting for the file instead. What it knew about your spelling was recorded when the file was opened and nothing refreshed it, so the following save applied that record again over the formatting that had just replaced it: the file came back part of the way toward its old spelling, and only a third save left it alone. Your content was never at risk in the swing, and the file read correctly at every step; what changes is that one edit now produces one diff to review rather than two opposing ones.

- Moving a nested list inside a file that indents its outline more widely than the editor writes it no longer pushes the moved lines far deeper than the level they belong to. Your own indentation was being applied twice: once when your original bytes were restored, and again when the save spelled out the depth those lines had landed at. The lines came back indented past the point where Markdown still reads them as list items, so the sublist stopped being a list and reopened as one run-together paragraph.

- The bullet character you type is now honored wherever you type it. Typing `* ` on the line below a `-` list used to continue that list and silently drop the character, even though those same two lines read from a file are two separate lists; it now starts a second list spelled `*`. The ordered delimiter follows the same rule, so `2) ` below a `1.` list keeps its `)`. Typing the character the list above already uses still continues that list, as it did before. Two related cases come with it, because the rule is about the character rather than about typing: deleting the paragraph between a `-` list and a `*` list used to merge them and drop the `*`, and pasting a `*` list directly below a `-` list did the same. Both now keep the two lists. Merging two differently spelled lists is still offered, in the block menu and as a quiet prompt at the cursor, so what changed is that it is no longer done for you unasked.

- The same rule now reaches the head of a list item, which is where the change above left off and the place you are most likely to reach by accident. Typing `* ` at the head of an item in a `-` list used to be written to your file as escaped text, and now splits that item out as a `*` list; `2) ` at the head of an item in a `1.` list keeps its `)` the same way. To type those characters literally there, type them and then press Backspace, which puts them back as text just as it does after a numbered-list shortcut. One case comes with it: typing the character that a neighbouring list already uses now merges into that list, where it used to leave a pair Markdown has no way to spell and rewrite the untouched neighbour's own marker line to keep the two apart.

---

## [2026.809.0] - 2026, August 9

### Added

- The `=` calculator takes functions and constants, so `3+log10(2²+3²*2.3303)/π^2=` answers where it used to stay prose. The call surface is `sqrt`, `abs`, `ln`, `log10`, `log2`, `exp`, `sin`, `cos`, `tan`, `asin`, `acos`, `atan`, `round`, `floor` and `ceil`, plus the constants `pi`, `π`, `tau` and `τ`; case does not matter, and the result-first form takes them too (`=sqrt(16)`). What decides whether `=` may read a name is what that name means to a reader: those mean one thing in any document, so `=` can answer without knowing what is defined above it, while a variable means whatever a definition says and stays with `=>`. Everything that makes `=` safe to type inside prose is unchanged, because a name outside that list stops the scan instead of being swallowed by it: `total + 2 =` and `mylog10(4)=` still offer nothing, `log(100)=` still refuses to guess a base rather than picking one, and `2 x 3=` is still multiplication. An accepted answer with a function in it stays live, too, and updates when you edit one of its numbers.

- PlantUML diagrams render. A ` ```plantuml ` (or ` ```puml `) block now shows the diagram instead of its source, with the same preview toggle, zoom, pan, fit-to-view and fullscreen view Mermaid has had. They are two front ends onto one preview, so anything that works on a Mermaid diagram works here. Sequence, class, state, component, activity, use case, ERD, mindmap, gantt, WBS, JSON, YAML, salt wireframes and the rest of PlantUML's families are covered. It all happens on your machine: the engine is a WebAssembly build bundled with the editor, so no diagram source is ever sent anywhere and none of it depends on `birta.network.enabled`. PlantUML's `!theme name` and `!include url` directives fetch over the network in other tools; here they fail with an explanatory message rather than reaching out, which is deliberate: a document you opened cannot make the editor request anything. The engine loads only when a document actually contains a diagram, so files without one pay nothing for this. Two gaps are worth knowing: JCCKIT does not render at all (upstream emits it as a raster image, so you get an error card instead), and DITAA renders its boxes, lines and text but ignores ditaa's own colour and shape tags, so a `cRED` or `{s}` marker draws as literal text rather than a red fill or a storage shape.

- `birta.plantuml.theme` sets the palette for PlantUML diagrams: `light` (the default, PlantUML's own palette on a light canvas, so a diagram reads like an embedded image under any editor theme), `dark` (re-skinned with your editor's own foreground, surface and border colors), or `auto` (follow the editor). It mirrors `birta.mermaid.theme` and is independent of it, so one document can hold a light Mermaid diagram and a dark PlantUML one. `@startjson` and `@startyaml` blocks always use their own palette; their contents are data, and re-skinning them would corrupt the diagram.

- Ordered lists can be drawn with letters or roman numerals. A Numbering section in a list's gutter menu offers `1.`, `a.`, `A.`, `i.` and `I.`, and typing `a. `, `A. `, `i. ` or `I. ` where you would type `1. ` starts a list in that style. Typing one of those markers just below a numbered list, or at the start of an item in one, restyles that list rather than starting a second. Nested levels alternate decimal, letters and roman by depth already; this is the same choice at any level. Your file still gets ordinary `1.` markers, because CommonMark has no lettered marker and `a. alpha` is a paragraph to GitHub and to VS Code's own preview, so the list stays portable. The choice is remembered per list alongside your folds and widths, which means it survives closing the file but stays with the workspace rather than travelling in the document. One consequence: a paragraph that genuinely opens with an initial (`A. Smith said`) becomes a list. Backspace immediately after puts the characters back as text, and Cmd+Z forgets them.

- Birta Writer has an icon. The Extensions view and the Marketplace listing showed the gray placeholder tile every extension gets without one; both now show the Birta Writer wordmark.

### Changed

- Full screen is one surface now, whatever you opened. A diagram, a code block, an image and an embedded player used to be four overlays that had drifted into three different designs, so the close button moved depending on what you were looking at. They share an anatomy: the title of what you opened sits top-left, the controls sit top-right with Close always last, and anything that pans has its pad bottom-right. That is also where those controls sit on a diagram in the page, so going full screen no longer moves a button out from under your pointer.

- A full-screen diagram is now the diagram, edge to edge. It used to be a card floating on a tinted wash, both drawn from your editor theme, which on most themes made them near enough the same shade that the card had no visible edges. The backdrop is now the diagram's own paper, with no card and no shadow, the way a drawing canvas works. It also opens large: a small diagram used to be centred at its original size in an otherwise empty window, and it is now scaled up to fill the space, which is what asking for full screen meant.

- A full-screen diagram keeps its pan pad and gains a real fit-to-view. The pad was in the page but not full screen, which is backwards: full screen is where there is most to move around in.

- Images and embedded players still dim the page behind them, and now do it properly. That wash was also mixed from the editor background, so on a dark theme it barely dimmed anything; it is a neutral dark scrim on every theme, the way a photo viewer dims. For a player we deliberately add nothing but Close, and we keep it out of the frame: YouTube and Figma put their own controls in their own corners, and ours should not land on top of them.

---

## [2026.808.0] - 2026, August 8

### Added

- Typing a list marker at the start of an existing list item now changes that item's kind, which is what finally makes mixed lists reachable from the keyboard. Type `1. ` at the head of a bulleted item and it becomes a numbered one; `- `, `* ` or `+ ` at the head of a numbered item makes it a bullet. So the ordinary way to number a sub-list is now the obvious one: Enter, Tab, `1. `, and you have a numbered list nested inside a bulleted one, no menu involved. Until now the marker was simply text, and saved as an escaped `1\.`, so the only route to a mixed list was the gutter menu. Know what it changes: the marker describes the line it is on, so a marker typed in the middle of a list splits it, exactly as the same characters would in the file. Three bullets with the middle one numbered are three lists, and the editor shows them as three blocks. A marker that changes nothing (`- ` on a line that is already a bullet) stays as text, so a literal dash is still typeable. If a marker fires when you meant text, Backspace puts the characters back, as it does after any typed shortcut.

### Changed

- Changing a list's kind now leaves nested lists of another kind alone. Converting `- item` with a numbered sub-list under it to a task list gives you checkboxes on the bulleted lines and leaves the numbered ones numbered; it used to flatten every level to the new kind, so a mixed outline came back all one kind. A sub-list you deliberately made different stays different, at any depth, and the exemption follows the list rather than the branch, so a bulleted list nested under an exempt numbered one still gets converted along with its own kind. Worth knowing at the boundary: because Task List is offered as a kind of its own, converting an outline to a checklist leaves a numbered branch inside it without boxes. Convert that branch as well if you want them; it is one more gesture and it does not disturb anything else.

- The Lists control and the `/` menu now convert the list your cursor sits in, rather than the outermost list containing it. With the cursor in a bulleted sub-list of a numbered list, "Numbered List" makes that sub-list numbered and leaves its parent alone. Previously the two disagreed: the highlight told you which list you were in, and the command acted on a different one. With the change above, acting on the outermost would have done nothing at all in exactly that case. The `/` menu also stops hiding a list row because of an outer list: in that same spot it now offers "Numbered List", which it used to withhold.

- The bullet character you type is now the character written to the file. A list started with `* ` used to be saved as `-`, the editor's default; it is now saved as `*`, matching what Birta already did for the markers it reads out of a file. `1) ` also starts a numbered list now. It used to be saved as the escaped text `1\)` and never became a list at all. This is about starting a list. A marker typed on the line directly below an existing list still continues that list, as it always has, and the list keeps the character it already had.

### Fixed

- Setting one table to Full Width changed a different table too. The width control treated any two tables sharing a header row (`| Name | Age |`, the common case) as one block, and Duplicate makes such a pair in a click. Editing either header row was worse: the other table kept its width on screen and then reverted the next time you opened the file. The same coupling applied to two code blocks opening on the same line, one image used twice, and one URL embedded twice. Each block now keeps its own width, and Duplicate hands the copy the width of the block it copied. None of this was ever written to your file. Two limits stand, both unchanged in kind: these preferences stay with the workspace rather than travelling in the document, and identical blocks are told apart by their order in the file, so reordering two of them swaps their widths.

- A `[ ] ` typed on a list item's second line put the checkbox on the item's opening line. Typing the marker below `- alpha`, on a continuation line of the same item, consumed the characters where you typed them and moved the checkbox to `alpha`, a marker that took effect on a line you were not on. A continuation line has no marker of its own, so the characters now stay as text there.

- There was no way to tick a checkbox by typing. `[x] ` on an existing task item was ignored and left behind the escaped literal `\[x]` in the item's own text. It now ticks the box, and `[ ] ` on a ticked one clears it. Typing a task marker in a numbered item works too, and keeps the item numbered (`1. [ ] step`), rather than being available only in bulleted lists.

- A list indented four spaces per level, the spelling most other Markdown tools write, could silently lose its deepest nesting levels on any save that carried an edit. It took a second thing in the same file: something whose own indentation happens to match one of the list's levels but means nothing structural, such as a diagram or code sample indented four spaces inside a fence. The editor learns how your file spells each nesting level by reading its own round trip, and those fence lines were allowed to vote, reporting that four spaces stay four spaces while the list said four spaces mean one level. Two answers for one question is a tie, so the editor dropped what it knew about that level and every level below it flattened. On one of our own test documents an eight-level list came back with five of them gone, as one paragraph of loose lines. Text inside a fence or an indented code block is now read as content rather than as evidence about your outline, so the tie never happens. Lists whose indentation matches the editor's own two-space spelling were never affected, which is why this went unseen.

- Moving a block could save a code block as ordinary prose. The trigger is narrow and the loss is not: when a file holds a code block written in the indented style, which the editor preserves byte for byte because it cannot re-create it, a move that lands a list item directly above it leaves those bytes reading as part of that list item instead of as code. The file looked correct in the editor and reopened with the code demoted to a paragraph. The editor already checked its saved output against its own rendering, but this damage was present in both, so the check agreed with itself and passed. It now separately confirms that the version it is about to write still holds as much code as its own rendering does, and where it holds less it writes its own version instead. That fallback costs the byte-for-byte preservation for that one save, so a construct the editor cannot re-create exactly may come back re-spelled; this check is deliberately narrow enough that it did not fire once across 285 block moves over our test corpus.

- An ordered list that does not start at 1 could be destroyed by dropping it into a list item. Markdown only lets an ordered list begin in the middle of a paragraph when its first number is 1, so a list starting at 5 written directly beneath a line of text is not a list at all, it is more of that text. Dropped into an item this way, `5. five` reopened as literal text on its own line and the list was gone. Nothing refused the drag and nothing warned. Such a list is now written with a blank line above it, which is all it needs to start a list again. The start number is the whole of it: the same list starting at 1 was always safe, and neither the indentation nor the `.`-versus-`)` spelling ever mattered. The same missing blank line was also found between a link definition and such a list, and is fixed with it.

---

## [2026.807.0] - 2026, August 7

### Fixed

- Moving a block within a tab-indented outline could corrupt the saved file in three ways the previous fix did not reach: a moved sublist could nest one level too deep, an unrelated table could degrade into a run of loose text lines, and pulling a paragraph out of a quote inside a list could leave a stray marker that broke the list open on reopen. A tab is resolved by the real Markdown reader at the next four-column stop rather than as a fixed width, and a move can place a line beside a neighbour whose content starts inside the span a tab jumps over. The save now compares the nesting depth of what it is about to write against the editor's own rendering, and where they disagree it falls back to writing the editor's version. Know what that fallback costs: it rewrites the whole file, not the lines you moved, so a tab-indented outline comes back space-indented and table padding is re-spaced. On one of our own outline fixtures it fires on more than half of the block moves the document allows. Your content survives; your indentation style may not. Found by widening the nightly fidelity sweep rather than by any report.

---

## [2026.806.1] - 2026, August 6

### Added

- A block can be dropped inside a list item, between the blocks that make it up. Dragging into the gap between an item's paragraph and the quote, code block, or sublist under it now shows a drop target at the item's content column, and the drop nests the block into the item; until now a drag could only land beside the item, and a block already inside one could only be pulled out. Items holding a single block offer no interior target, no target is offered ahead of an item's first paragraph, and an item written as `- > quote` (whose first block is not a paragraph) offers none at all, because a second block there would break the list open on reopen.

### Fixed

- On older VS Code builds (verified on 1.95.0, the oldest we support), opening a Markdown file left it in the raw text editor instead of switching into Birta. The auto-switch re-checked the just-opened tab by object identity after a short capture wait, and on those builds the tab object is replaced when its preview state settles, so the check read "tab closed" and quietly did nothing. The switch now re-finds the tab by its file. Found by the new release step that actually launches the oldest supported VS Code; nothing had ever launched it before.

- On the same older builds, clicking a search result opened the document without selecting the match. Those builds apply a search reveal without stamping the event the newer ones stamp, so the navigation capture ignored it. A reveal is now also recognized by its shape (a selection highlighting a match); an ordinary reopen restoring a bare caret still reads as no navigation, so remembered scroll positions survive.

- An invalid Mermaid diagram froze the window on document open. A diagram Mermaid cannot parse (one mistyped bracket is enough) sent the renderer into an endless retry the moment the preview first drew it, on the same thread everything else runs on: the window stopped responding before the first keystroke. A failed render now settles on an error card showing Mermaid's own parse message, and attempts a render again only after the diagram's text or the effective theme changes. The fullscreen view also stops opening on the error card as though it were a diagram.

- Moving a block within a tab-indented outline (the Logseq convention, where indentation is the block tree) could silently flatten the moved list's nesting in the saved file. The moved lines were written with the editor's space indentation while the untouched lines around them kept their tabs, and a tab is four columns against the editor's two, so the file reopened with the moved sublist one level shallower. The document looked right on screen and was wrong on disk. The save now writes moved lines the way the file itself spells that depth, learned from the document's own round trip. Where the file has never spelled that depth, or spells it two ways, the moved lines keep the editor's own indentation rather than a guess at yours. The one gesture known to reach this was the new in-item drop target above, which was withheld until this was fixed, but other block moves in tab outlines could plausibly reach the same splice.

---

## [2026.806.0] - 2026, August 6

### Added

- Focus Review Sidebar, a new Command Palette command, moves the keyboard into the review sidebar, opening the panel first when it is hidden; give it a keybinding in the Keyboard Shortcuts UI if you use it often. Escape hands focus back to the text, so the round trip never needs the mouse. The toolbar's Show issues action now also places the keyboard in the list it opens. Until now nothing moved focus into the panel: its lists were fully keyboard-navigable once you were there, but getting there took a click.

### Security

- A link whose address is `javascript:` or `data:` is no longer clickable. Nothing could run through one before this either, because the editor already blocked that. This is a second layer, not a way in that was open. Your file is unchanged.

### Changed

- Scrolling a long document is smooth. A flick down a 300 KB file with 344 headings previously blocked the editor for about 2.5 seconds spread over 32 stalls. It now costs a single stall of about 0.1 seconds. The editor was asking the document where every heading was, on every frame, twice over: once for the sticky heading and once for the table of contents.

- Documents with many tables open faster. On a 95 KB document with 108 tables the editor now appears in 521 ms instead of 639 ms, because a table's row and column grips are built when you first move the pointer over it rather than for every table at startup. Selecting cells with the keyboard still brings them up.

- Typing in a large document costs less than half what it did per keystroke. On a 300 KB document the median keystroke dropped from 4.6 ms to 2.0 ms, and moving the caret with the arrow keys from 1.7 ms to 0.5 ms (same-session interleaved measurement). The editor was re-answering three questions on every keystroke whose answers a typing edit cannot change: where every heading element is, what every heading's link anchor should be, and what every ordered-list item's number is. Each now updates only when an edit could actually have changed it.

### Fixed

- Dragging an ordered-list item into a bullet list no longer sets a trap that kills later edits. The moved item quietly kept its "ordered" identity, and the next structural edit inside any list (Enter, another move) then hit a crash in list renumbering: the edit was thrown away, and every further list edit died the same way until the file was reopened. The renumbering now targets the right positions, so that first edit converts the receiving list to an ordered list, in place, as intended. The file itself was never corrupted; saving always wrote a clean bullet list.

- Dragging the only real block out of a list item no longer destroys the list on reopen. An item like `- > quote` carries an invisible empty line the parser adds in front of the quote; moving the quote out left the item holding only that artifact, which saved as a bare `-`. Markdown reads a lone `-` under a line of text as an underline that turns the text into a heading, splitting the list. The move now carries the emptied item away with its content. Where the same bare-marker shape can arise for other reasons, a move that would actually damage the document on reopen is refused with a notice instead, keeping the block-editing integrity promise: content is never silently altered.

- The review sidebar's last mouse-only controls work from the keyboard. The move-panel-to-the-other-side and hide buttons are a Tab stop of their own, and ArrowRight on a finding reaches its Ignore and Add-to-dictionary buttons, ArrowLeft returns to the row.

- The keyboard is never stranded by the review sidebar. Hiding or collapsing the panel while focus was inside it dropped focus nowhere, so the next Tab press started from the top of the window; it now returns to the text. Ignoring a finding keeps the keyboard on the list instead of losing it. The collapsed panel's hover preview no longer retracts while the keyboard is inside it, and a hidden panel's buttons can no longer be reached invisibly with Tab.

- Menus and palettes opened near the top of a document no longer appear behind the toolbar. Selecting text on the first line put the formatting palette underneath the toolbar, where it could be neither seen nor clicked; the link editor, the image title bar, suggestion dropdowns, footnote previews, and writing-check popups could all land there too. Every floating surface now measures the room it has from the bottom of the toolbar and sticky heading rather than from the top of the window, and one too tall for the space left scrolls instead of running off an edge.

- Fullscreen image, diagram, and embed previews now cover the toolbar instead of opening underneath it, so the close button is fully clickable.

- A suggestion list stays with the text it belongs to while you scroll. The link, heading, wiki-link, calculation, and file-path dropdowns were placed once when they opened and then stayed where they were, drifting away from the cursor or field they were completing.

- The image toolbar picks its side again after the page moves. It chose above or below the image when you selected it and never reconsidered, so scrolling could slide it under the toolbar.

- A long file path in a suggestion list no longer runs off the right edge of the window, and the code block's language menu stays on screen for a code block near the right edge.

- The offer to replace a pasted link with its page title appears next to that link. If the page took a moment to load and you scrolled meanwhile, the offer appeared adrift from the link it was about.

- Splitting a highlight in two keeps both halves highlighted. Pressing Enter inside `==one two==` previously produced `==one ==`, which reopens as ordinary text with the `==` visible, so the highlight was gone from the file.

- The release notes you read when the extension updates carry every kind of change. A Security, Removed, or Deprecated note had no section to land in. Worse, when the notes were generated without an API key the changelog was not read at all, so a reviewed Security note was dropped and a raw commit subject published in its place.

---

## [2026.805.0] - 2026, August 5

### Changed

- Documents with many tables and code blocks open faster. On a 96 KB document with 108 tables, the editor appears in 554 ms instead of 707 ms.

- Selecting a block and typing are faster on large documents. On a 300 KB file, two dozen Escape presses went from a stall on every one, about 1.4 seconds in total, to at most two. An 80-keystroke burst went from 627 ms of blocked editor to 465 ms.

### Fixed

- Editing inside a `~~~` code fence keeps the rest of the document. The file could previously be saved with mismatched fence characters, and everything below the fence reopened as code. Fences written with backticks were never affected.

- A rule or paragraph inside an emptied list item stays in the list. It previously reopened outside the list. The content was never lost from disk. This affects plain bullets and task items alike.

- Emptying a list item's first paragraph keeps the item's other content inside the item. It previously moved out of the list. Only reachable by editing, so nothing already on disk is re-spelled.

- Editing two lines in one sitting keeps the untouched one written the way you wrote it. Editing adjacent table rows could swap cells between rows and drop one, and editing outline siblings could return mixed indentation. Editing any of those lines alone was always correct. Verified over 1,162 multi-line edits across every test document.

- Emptying a task item that holds another block keeps the block. The block was previously destroyed, and where the item held a second paragraph the saved file could not be reopened at all. The checkbox itself is not kept, because Markdown cannot write a checked item with no text. One known limit remains: the rule reopens after the list rather than inside its item.

- Inserting a horizontal rule into an emptied nested item leaves the rest of the list alone. It previously rewrote the bullet character on sibling lines you had never touched.

- Inserting a horizontal rule keeps the block you insert it into. The Horizontal Rule command previously destroyed a list item or its sublist, failed with an internal error in an emptied top-level bullet, and split one table into three. It also left an extra empty paragraph behind on every insertion. Typing `---` never had either bug.

- Copying a footnote's nested list keeps its spacing. Copy as Markdown previously added a blank line before a sublist. Saving was never affected.

- A spaced-out list inside a blockquote offers to tighten it, rather than to loosen it again. Blockquote lists without a sublist, and lists outside a blockquote, always read correctly.

- Outdenting a bullet by moving it leaves the bullet below it where it was. In a tab-indented outline the moved line previously took the editor's own indent, so the bullet below could be swallowed as a child. Across 2,471 moves over thirteen outline shapes and six test documents, this halves the remaining losses from ten to five.

---

## [2026.804.0] - 2026, August 4

### Added

- The installed extension carries its own attribution. `licenses/THIRD_PARTY_LICENSES.md` ships inside the extension, listing every bundled open-source package with its license text and copyright line. It is generated from what the bundles actually inline, so it lists what you have rather than what a manifest claims.

### Fixed

- Moving a bullet in an outline that spells one indent level two ways keeps its nesting. In a file that writes the same level as a tab in one place and as spaces in another, the ordinary state of an outline more than one tool has edited, a moved bullet came back one level deeper than you left it. It now takes the indent spelling its neighbours use, and the file's own tabs are left alone. Nothing was ever lost to this: tables and text survived, and only the nesting changed.

- Typing into one of two siblings at an unusual indent leaves the outline as it was. In a file indenting a level as, say, a tab plus three spaces, editing one of two adjacent lines at that level pulled both of them out of their parent. Each line now keeps the indentation the file gave it, where the two lines correspond exactly (identical apart from their leading whitespace); anywhere else the editor still falls back to its own spelling rather than guessing.

- A nested bullet holding a horizontal rule stays in its list, Tab included. Saving such an item gave a file that reopened with the sublist gone, the text above it promoted to a heading, and the rule loose in the document. Tab was the likeliest way in: indenting an item that holds a rule produced exactly that. Where the bullet and the rule would use the same character (`-` with `---`), the list's bullet is switched to a different character so the two can sit together, and files that already round-trip cleanly are left alone. Measured over every bullet character against every rule spelling in every shape: 14 of those 54 combinations reopened as a different document before this fix.

- Reordering a list's first item keeps the spacing the list had. Moving the first item of a list down into the middle of it saved a blank line the document never had, so a tightly packed pair reopened spaced apart. The item now takes the spacing of the gap it lands in. Pressing Enter at the very start of a list's first item stranded the old first item the same way, and that path is fixed too. Spacing you wrote yourself is still never rewritten.

### Security

- A crafted diagram can no longer style or deface the editor around it. A `.md` file you opened could use Mermaid `classDef` values to apply arbitrary CSS to the editor surface, or inject DOM that escaped the diagram's SVG: page defacement, tracking pixels via `url()`, and attribute exfiltration through `:has()` selectors. Script execution was already blocked. A gantt chart that excluded every day of the week could also spin the renderer forever, hanging the document. Diagram rendering is updated past all three, and the sanitizer behind inline HTML alongside it.

---

## [2026.803.0] - 2026, August 3

### Changed

- Calculator results follow the convention most other calculators use, and where no convention wins Birta declines to answer. `%` is floored modulo, carrying the sign of the divisor, so `-10 % 3` is `2` (as in `MOD` in Excel and Sheets, Python, Ruby and Wolfram) rather than JavaScript's truncating `-1`. `round` sends halves away from zero, so `round(-2.5)` is `-3` and `round(-x)` is always `-round(x)`. A bare `log(...)` computes nothing at all, because it means base 10 in spreadsheets, Desmos and every pocket-calculator LOG key, and the natural log in Python, R, Mathematica and JavaScript; `log(100) =>` offers both readings with the value each gives, and picking one rewrites the equation to `log10(100)` or `ln(100)`. In a ` ```calc ` block that line takes the quiet error dash, and its tooltip says what to write instead. `log10`, `log2`, and `ln` are unchanged, as are the conventions now written down: trig is in radians, `^` is right-associative, and `-2 ^ 2` is `-4`. Answers you already accepted are left exactly as they are, so nothing is rewritten, withdrawn, or flagged behind your back; re-accept the equation if you want the new reading.

### Fixed

#### Saving and round-trip

- Splitting a paragraph in two now reaches the file. In a paragraph whose source is wrapped across several lines, the ordinary shape of hand-written Markdown, putting the caret mid-paragraph and pressing Enter looked right on screen and then was not saved, and reopening showed one paragraph again with nothing to say an edit had been dropped. Splits now save, in plain paragraphs and inside list items, blockquotes, and tab- or space-indented outlines, and so does the reverse: joining two paragraphs back into one is written back instead of silently reverting. Spacing you wrote yourself is still never rewritten. One related case is not fixed: splitting inside a loose list, one with blank lines between its items, still writes the new item glued to the one above, so that pair comes back tighter than the rest of the list.

- A table pasted into a list item keeps the text after it. The saved file wrote the trailing half of the paragraph directly beneath the table's last row with no blank line, so reopening showed your sentence pulled into the table as a one-cell row. The blank line the file needs is now written. The same repair covers the family, found by checking every pair of block types a list item can hold: text or a table under a nested list, a quote, a callout, or a footnote definition was swallowed by it; a second quote fused into the first; a divider under a paragraph turned that paragraph into a heading; and a Notion `<aside>` swallowed everything after it. Ordinary outlines are untouched, and a bullet with a sublist under it still saves with no blank line. One related case is not fixed: a paragraph beginning with a raw HTML tag still swallows the block after it inside a tight list item.

- A list item that starts with raw HTML keeps the block after it separate. An item whose text opened with a block-level tag (`- <div>raw</div>` followed by a heading, a table, a code fence, a sublist, a quote) was written glued to the block below it, so reopening gave one block where the editor held two. Such an item now gets the blank line that keeps its blocks separate. An item that merely contains inline HTML is unaffected and stays tight, as is one whose tag closes on its own line (`<pre>x</pre>`, `<!-- a comment -->`).

- Turning a list item into a paragraph now actually leaves the list. Un-bulleting an item (Backspace at its start, Shift+Tab, the toolbar's Lists toggle) looked right on screen, but the saved file glued the new paragraph under the item above it, so reopening showed it fused onto the bullet above or back inside the list. The blank line the file needs is now written, for bullet, numbered, and task lists, at any position, including sublists indented with four spaces or tabs.

- Splitting a paragraph inside a spaced-out list keeps the list's spacing. Splitting one item's wrapped text into two items saved the new pair glued together, so one pair reopened tightly packed while the rest of the list stayed spaced. Nothing was lost, but the item's spacing changed under you.

- Moving a bullet whose content is a table keeps the table. In a tab-indented outline, the Logseq shape, dragging or Alt+moving such a bullet brought it back as three lines of literal pipe text. The rows now re-base to the depth the bullet lands at, and the outline's own tabs are untouched.

- Editing near a `$$` math block leaves it where it is. A math block written directly against its neighbouring text had a blank line inserted there the first time you edited anything else in the document, and an empty block was at risk of losing the blank line that is its entire content. An untouched math block now keeps its exact bytes however you edit around it. A line that merely starts with inline math (`$$x$$ ...`) is still ordinary paragraph text.

#### Editor surface

- Clicking a code block's controls parks the editor instead of leaving a live caret in your text. The caret stayed where it had been in your text, so the next Enter split a paragraph somewhere else in the document with nothing on screen to show it. The editor now goes inert when you click a rendered diagram or formula, and when you click any of the block's chrome: the language pill, the copy, preview-toggle, word-wrap, width and fullscreen buttons, and the resize handle. Worst of the set, and also fixed: opening a diagram fullscreen left the editor typing into the document behind the overlay. Clicking the code itself still puts the caret in the code.

- A selected horizontal rule shows the same selection ring as anything else. Pressing Arrow onto a `---`, or clicking it, selects it, and the next character you type replaces it; the only cue was previously a one-pixel line changing colour, while a link reference definition showed a full ring for the same state. The behaviour is unchanged, and one undo still brings the rule back.

- Menu group dividers stay visible in a tall menu. In a menu long enough to be capped and scrolled, the one-pixel rule was squeezed to nothing, so the block menu lost the line between its groups and the toolbar's Checks menu had no rule under Highlight note markers. Dividers now hold their line at any menu length.

---

## [2026.802.0] - 2026, August 2

_No user-visible changes; internal work only._

---

## [2026.801.0] - 2026, August 1

### Added

- Editor notes are highlighted where they sit. The markers you leave yourself while drafting (`[TK]`, `[TK: ...]`, `TODO:`, `FIXME:`, and anything in `birta.notes.customMarkers`) carry a quiet chip in the text, so a draft's unresolved bits are visible without opening the review sidebar. One tint for every kind, and only the marker itself is highlighted, never its line. HTML comments are left alone, and a marker inside backticks is source and stays undecorated. On by default, off costs nothing. The same switch appears as Highlight note markers in the toolbar's Checks menu, Highlight on the review sidebar's Notes tab, the Highlight Note Markers command, and `birta.notes.highlightMarkers`, all in sync across open editors. It sits above Proofreading as its sibling: turning proofreading off silences spelling, grammar, and style, but never your own notes.

- Backtick wraps a selection in inline code. With text selected, pressing `` ` `` toggles the inline-code mark over it instead of replacing it with a literal backtick, matching ⌘E, the toolbar, and the slash menu. Press it again to un-code. With nothing selected the backtick is unchanged.

### Fixed

- Dropping several images at once inserts all of them. Selecting three images and dragging them in together inserted one and discarded the other two, with no message. All of them now land, in the order you dragged them, as a single edit one undo takes back, and the pill that marks the spot says how many are saving. If one cannot be saved, the rest still land and the message says how many did not. Pasting several copied image files behaves the same way.

- The inline calculator answers an expression with an unclosed parenthesis in front of it. `here's the formula (3+7=` offered nothing. An unmatched leading paren is now read as the prose punctuation it is, so the answer arrives and the paren stays where you typed it (`(3+7= 10)`). The same fix covers the `=>` form. Everything refused before still is: an unmatched paren inside the expression (`2*(3+7=`) means you are mid-formula, a run glued to a letter (`f(3+7=`) is a function call, and a trailing unmatched `)` reads as the tail of something larger.

- The inline calculator's `=` works inside a code span. Typing `` `3+7=` `` offered nothing, because the suggestion machinery refused inline code outright. The answer is now offered as usual and lands inside the span. The richer `=>` form deliberately still declines there: its answers are kept alive against definitions elsewhere in the document, and that maintenance cannot see inside a code span. Also unchanged: a fenced code block never computes, and a `name = value` line in backticks is still source, not a variable definition.

---

## [2026.731.0] - 2026, July 31

The first public release, and Birta Writer's first version on the VS Code Marketplace.

### Added

#### Fidelity, privacy, and trust

- Byte-faithful round-trips. Untouched lines are preserved exactly, and constructs the editor cannot re-emit byte-for-byte (reference links, wikilinks, callout markers, tight lists, Notion asides) are pinned to their saved bytes, so editing one part of a file never rewrites another.

- A content-conservation guard refuses a gesture that would lose content. A move, duplicate, drag, or table reorder that would silently lose or corrupt content, or whose result would not survive saving and reopening, is declined with a quiet notice instead of vanishing text. Drops cannot land inside hidden or collapsed content. A document that already carries such damage still edits normally; only a gesture that would add damage is refused.

- Offline by default, behind one master switch. Every feature that could contact the network (paste-unfurl, URL embed players) sits behind `birta.network.enabled`, which ships off, so out of the box the editor makes no outbound request. The moment you do something that would use the network, a dismissable Enable prompt appears where you are working, and dismissing it stops the prompt for the session. Enabling from the prompt, the setting, or the Toggle Network Features command takes effect immediately in every open editor, with no reload.

- No network egress for document content. Images are always saved to the local workspace and never uploaded, remote image loads are blocked, opened URL schemes are allowlisted (`javascript:` / `file:` / `command:` are blocked), the HTML sanitizer is hardened, and Mermaid runs in strict mode.

- Send Feedback composes a report and hands it to you to send. The palette command asks what the issue is, optionally how you would feel if you could no longer use Birta, optionally any further detail, and where it should go: a prefilled GitHub issue, a prefilled email to Birta Labs, or the clipboard. Birta never sends it, you do, so it works with `birta.network.enabled` off and needs no account with us. It never asks first: no prompt, no nag, no rating popup, and the palette is the only way in. The report carries your Birta and VS Code versions, your OS, and which `birta.*` settings you have changed from their defaults, in a collapsed block you can delete before sending. A setting's value is included only when it cannot be a path or a sentence (so `birta.customCss` reads "2 entries", never your paths), and your document, its file path, and your workspace name are never included at all.

- A disk-drift badge warns when a file with unsaved edits changes on disk. Another tool can do that (a terminal, git, an AI assistant); reload from disk or compare the two versions side by side. The editor never silently overwrites or merges.

- Crashes surface instead of going silent. If the editor's rendering layer hits an unexpected script error, VS Code shows an error notification, deduplicated and capped per session, rather than the editor quietly stopping. Your document and its native save path are unaffected either way.

- Restore Previous Content is a last-resort recovery command. If a single editor update ever removes a large share of a document's lines, the extension quietly keeps the prior text in memory, and the command swaps it back; running it again swaps back the other way. The kept text survives closing the editor tab but not a VS Code restart, and nothing is written anywhere or sent off the machine. VS Code undo and hot exit remain the primary recovery paths.

#### Editing

- WYSIWYG Markdown editing. Open a `.md` file as rich text and save standard Markdown back. The editor is backed by a real VS Code text document, so it carries native dirty state and saves through VS Code's own `files.autoSave` and Cmd+S with no separate save timer. Toggle to Raw Markdown and back at any time.

- Block handles and the block menu. Every block, at every nesting depth, has a gutter handle. Click it for a menu (turn into another block type, duplicate, copy as Markdown, copy link, move up/down, delete) or drag it to reorder; a heading carries its whole section. ⌘. / Ctrl+. opens the same menu from the keyboard. Resting visibility is set by `birta.blockHandles` (`always`, `headings`, the default, or `hover`).

- Block selection and keyboard editing. Select whole blocks with an Escape ladder, Shift+↑/↓ to extend, or a marquee dragged in the margins; move them with Alt+↑/↓, duplicate with ⇧⌥↑/↓, delete with ⌘⇧K. Plus the VS Code editing canon adapted to WYSIWYG: join lines, insert a paragraph above or below without splitting, transform case, and expand or shrink selection.

- Folding. Fold headings, callouts, nested list items, tables, and code blocks from a gutter chevron, or with the Fold / Unfold / Fold All commands (⌘⌥[ / ⌘⌥]). Chevron visibility follows VS Code's own `editor.showFoldingControls` and `editor.folding`. Folds persist per tab and never touch the file, or write an Obsidian `[!kind]-` marker explicitly from a callout's menu when you want the collapsed state saved.

- Slash command menu. Type `/` for a filterable, keyboard-first insert menu with the markdown shortcut shown for each row. Filtering matches label and keyword prefixes, substrings, and compressed abbreviations (`/seclink` finds Section Link). It runs the same commands as the toolbar and command palette.

- Find and replace. A find bar with ⌘D occurrence cycling, Change All Occurrences (⌘F2, also ⇧⌘L), Find in Selection, and Match Case / Whole Word / Regex toggles. It skips code blocks and diagrams showing their rendered preview, so a match never lands on hidden source.

- Self-sinking checklists. Turn on Move checked tasks to bottom (the toolbar's Lists menu, a task list's block menu, a palette command, or `birta.checklist.sinkChecked`) and checking an item moves it below the still-unchecked items in the same list; unchecking floats it back. A parent carries its nested items with it and one undo restores the previous order. Off by default. An Uncheck All Tasks command clears every box in the whole checklist, nested sublists included, in one undo step.

- Floating selection palette. Selecting text raises a small formatting bar (bold, italic, strikethrough, inline code, link, and a copy-for-AI-agent button), lighting the buttons for marks already applied. Four more buttons (inline math, highlight, link to section, clear formatting) ship hidden; opt them in via `birta.floatingToolbar.items.*`. Selecting whole blocks raises move, duplicate, and delete instead. Turn the bar off with `birta.floatingToolbar.enabled`.

- Tighten / Loosen List. A list item's block menu offers one toggle for the whole list's spacing: Tighten List removes the blank lines between items, keeping any blank line Markdown requires, and Loosen List adds them everywhere. Nested sublists follow, one undo step either way. It matters beyond the source bytes, since loose items get paragraph spacing in most Markdown pipelines.

- Merge adjacent lists on demand. When a document carries two same-kind lists back to back (Markdown's `-`/`*` marker-change syntax), a quiet inline suggestion in the first item of the lower list offers Merge with list above, and any item's block menu offers Merge with List Above / Below whenever a same-kind neighbor exists. Either way the merge is one undo step. Splits created by your own edits merge automatically instead.

- Browse for a link target with the OS file picker. The link editor's URL field gains a folder button that opens your system's file dialog, anchored at the document's own folder. The picked file lands in the field as a document-relative path, and nothing is written to the document until you confirm with Enter or click away.

- Section links follow a heading rename. Rename a heading and every same-document `[text](#slug)` link pointing at it is repointed automatically, in the same undo step. Only the target slug changes, and duplicate-heading `-N` slugs stay consistent. Moving a heading without changing its text rewrites nothing, and a link to a heading you delete is left exactly as typed and flagged Heading not found in the link popup rather than silently repointed. On by default (`birta.autoUpdateAnchors`).

#### Paste and clipboard

- Paste Markdown as Markdown. Pasting plain text that carries Markdown syntax becomes real nodes: `# Title` is a heading, `- item` a list, a double-asterisk run bold. That text previously landed literally and was escaped back out on save (`\# Title`). Pasting from a browser or word processor is unchanged, and a paste inside a code block is always literal. A lone block pasted mid-sentence still merges as text, and becomes a heading when it lands on an empty line. Paste as Plain Text (⇧⌘V) pastes literally for one paste, and `birta.pasteFormat` set to `plainText` makes every paste literal. Pasting into a table cell keeps the table's shape: pasted blocks land as the cell's lines joined by line breaks instead of widening the table with junk columns or splitting it into fragments.

- Copying from the editor copies Markdown. Cmd+C, cut, dragging text out, and the native Copy menu put the selection's Markdown source on the clipboard's plain-text flavor, so pasting into a chat box or a code editor keeps the syntax. A selection inside one block stays proportionate: a few words of a heading yield the words with their inline marks and never a stray `#`, and a partial copy from a code block yields plain code, never fences. Rich-text apps still paste formatting, since the HTML flavor is written alongside. `birta.copyFormat` set to `"richText"` restores the old plain-text rendition.

- Copy as Rich Text. A command in the palette and the right-click Copy group puts a real HTML clipboard entry on the clipboard from the selection, or the block under the pointer, so Docs, Word, or an email compose paste real formatting. Copy as Markdown joins it in the palette. Each copies its named format regardless of `birta.copyFormat`.

- Rich HTML pastes keep more of what you copied. Three kinds of marked-up content were being silently dropped and now survive: strikethrough written as `<s>` (only `<del>` was recognized), task-list checkboxes (a rendered checklist pasted as plain bullets with every tick lost), and an image's title is no longer invented from its alt text, where an ordinary `<img src alt>` used to gain a hover tooltip the source never had.

- Pasting multi-line text into a heading keeps it one heading. The lines join with a space, as a heading has no way to hold a line break. The break was previously written into the file as a real newline, so reopening split the heading in two.

- Pasting an image from a browser inserts one image, not two. An image copied from a web page carries both the picture and its HTML markup, and the editor was inserting both. It now saves the file once and keeps the description from the page.

- A pasted or dropped image shows that it is saving, and says so if it fails. Until the save returned the editor said nothing, and nothing at all if it failed. A quiet inline pill now marks the spot while the save runs, only if it takes long enough to be worth saying, and a failure becomes a dismissable message naming the reason. Both are display only: a failed save leaves your document exactly as it was, with no stray undo step. The image lands where you pasted it rather than wherever the cursor moved to while it saved.

- A dragged-in image shows where it will land. The drag draws the same accent insertion line a block drag draws, snapped to the boundary between blocks nearest the pointer, and the image lands there as a block of its own. Holding near the top or bottom edge scrolls the document. Hold ⇧ while you drag: that requirement is VS Code's, gated on ⇧ for every editor, and an extension has no way to waive it, so without ⇧ the file opens in a new tab. Pasting an image (⌘V) has never needed a modifier.

#### Calculation

- Inline calculator. Type an arithmetic expression with an equals sign at either end (`12 * 4 =` answers after it, `=5+7` answers before it) and the result is offered as a suggestion you confirm with Tab, leaving Return free. An Always insert result row, also the Toggle Calc Auto-Insert command and `birta.calc.autoInsert`, switches to insert-on-`=`. Everything inserts as plain text. It supports `+ - * /`, `%` for modulo, exponents (`^`, a doubled asterisk, or superscript digits), parentheses, decimals, and unary minus, plus the Unicode operator glyphs and a lone `x` between numbers as multiplication (`1024x768 =`). Only pure arithmetic is evaluated, and detection refuses any run that would compute a different question than the visible one. Answers are rounded for display, at most 6 decimals, and refused when they cannot print truthfully. An existing `expr = answer` stays maintained as you edit the expression, and editing the answer is always your override. On by default (`birta.calc.enabled`).

- Living calculations with `=>`, variables, and units. Type an expression followed by `=>` (`rent / budget * 100 =>`, `3 km in mi =>`) and the answer is offered for Tab, written as `expr => result` in plain text. Expressions can reference named variables defined earlier as `name = value` lines, resolved top to bottom, where only definitions above the line count; functions and constants (`sqrt`, `abs`, `ln` / `log10` / `log2`, `exp`, trig in radians and inverses, `round`/`floor`/`ceil`, `pi`/`π` and `tau`/`τ`); superscript exponents (`c²` is `c^2`); and offline unit conversions with `in` / `to` across the full mathjs catalog, computed locally by the same eval-free engine as `=`. The lazily-loaded unit catalog never sees your expressions, and currency is deliberately absent, since live rates would need the network. A few units side with the note-taker: kitchen spoons are US customary (1 cup = 16 tbsp), and `1 year in days` is 365 rather than the Julian 365.25, so write `365.25 days` when you mean the astronomical year. Accepted answers stay alive: edit the expression or a definition above it and every dependent result updates in place, and delete or rename a definition away and its dependent answers are withdrawn rather than left stale. One undo restores everything, editing a result is your override, and anything inside backticks is source, never touched.

- Calculation blocks. A fenced ` ```calc ` block is a live worksheet: every line is computed under one shared, top-to-bottom scope and shown in a two-column ledger, source on the left and value on the right, that recomputes as you type (` ```calculation ` works as an alias). Define variables with `name = value` and reuse them below, convert units offline (`3 km in mi`, `1 GB in MB`), and annotate with `#` or `//` comment lines. A bare number or prose shows no value, while a line that reads as a formula but cannot compute shows a quiet dimmed dash; prose compounds like `T-1000` never trip it. A rounded value offers its full-precision number on hover, and the ledger's text is selectable. The source is never rewritten and results live only in the rendered view, so the block round-trips byte-for-byte as ordinary Markdown. Its switch, `birta.calc.blocks.enabled` (on by default), is independent of the inline `birta.calc.enabled`.

- Stale and broken living-calc answers are visibly flagged. When an accepted `=>` answer stops matching the document and the editor deliberately will not rewrite it (the definition changed in the raw editor or a git checkout, the equation moved above its definition, or the file arrived that way), a faint warning tint on the number means stale, and the same tint with a strikethrough means broken. Click the number for the explanation and the actions: Update rewrites it, Remove answer leaves `expr =>` ready to re-answer, and Ignore silences that equation for the session. Nothing touches the file except those clicks, each a single undo step. Only answers with an outside premise are ever flagged: plain `=` equations and constant-only arrows are yours, and a definition you are mid-way through retyping never flags its dependents. The scan runs on idle after the editor is interactive; with `birta.calc.enabled` off it costs nothing.

#### Blocks and syntax

- Tables. Google-Docs-style overlay chrome (row and column grips, hover insert bars, drag-to-reorder) and per-column alignment with GFM markers that round-trip faithfully.

- Callouts, admonitions, and directives. GitHub alerts (`> [!NOTE]`), Obsidian callouts (per-kind icon and accent, collapsible bodies, aliases, fold markers), Docusaurus `:::name` container directives, and Notion `<aside>` exports all render richly with editable titles. Insert from the slash menu, the command palette, or by typing `[!note] ` or `:::name `. Callout types nest, and every marker line round-trips byte-for-byte.

- Math. Inline `$...$` edits in place like inline code, plus `$$...$$` math blocks. KaTeX loads on demand.

- Mermaid diagrams render on a white canvas by default so they stay legible in dark themes. `birta.mermaid.theme` chooses `light` / `dark` / `auto`. The engine loads on demand.

- Highlight. `==marked text==` renders as a theme-aware highlight.

- Images. Alt text shows as an editable caption under the image, the title as a hover tooltip, and the file path edits from a filename chip in the image toolbar.

- URL embeds. A bare provider link on its own line renders as an inline card, for YouTube, Vimeo, Loom, Figma, and GitHub. Players are click-to-load, so nothing reaches the provider until you press play: YouTube loads through `youtube-nocookie.com`, Vimeo with `dnt=1`, and Loom fetches no thumbnail at all. The GitHub card is built from the URL alone with zero network, so it renders even with the network switch off. Every card is display only: the source stays the plain link, so the file round-trips byte-for-byte and turning embeds off shows the link again. Cards are blocks you edit around: arrow keys stop at each one with a selection ring, clicking selects, a selected card opens a palette with the editable URL plus open, copy, show as text link, and delete, and Space toggles play and stop. Each player card carries an identity strip under the frame, the page title over the URL; the title is fetched from the provider's oEmbed endpoint when network features are on, and is display-only, never written to the file. Hovering a labeled link whose URL could card offers Show as embed in the link popup. `birta.network.enabled` gates every card that would make a request, while the request-free GitHub card needs only `birta.embeds.enabled` (on by default), and either switch takes effect immediately in every open editor.

- Links and wikilinks. One link editor for inserting and editing (⌘K, or click a link; applies on blur; a Markdown / `[[wiki]]` format switch), previewing live as you type, where Escape puts the original back exactly. The URL field suggests the document's own headings, so an internal section link is two keystrokes away. Wikilinks (`[[target|alias#heading]]`) round-trip byte-identically with bare-name autocomplete. Smart link resolution (`birta.smartLinks`) opens local links the way a site generator would publish them (workspace-root paths, content-root inference, `index.md` / `_index.md` suffixes). Link to a section: type `#` after a space anywhere in prose and a dropdown of the document's headings opens; pick one and it becomes a standard `[Heading title](#slug)` anchor link. The menu never captures plain typing or inserts on its own, and a line-start `#` still means a heading. The same flow starts from the slash menu (`/section`), the selection palette, or the Link to Section command. Pasting a URL over selected text links the selection instead of replacing it. Detection is narrow: full URLs and bare web domains link, while a file path or bare filename (`notes.md`), a version tag (`v1.2`), or a markdown snippet still replaces the selection, and a paste inside a code block, over an existing link, or across blocks is never intercepted.

- Paste a bare URL to get a titled link. With nothing selected, pasting a bare URL inserts a link and, when network features are enabled, fetches the page's title and offers it as the link text: take the prompt and the link becomes `[title](url)`, ignore it and the plain link stays. Nothing is written to your document until you accept, because a network reply landing seconds after you paste should not quietly edit your file; `birta.pasteUnfurl.autoApply` (off by default) switches to applying titles the moment they arrive. The fetch requests only the URL you pasted, reads the title from its HTML with no third-party service, and keeps the plain link when the page is offline or untitled. It refuses local and private-network addresses outright (localhost, `192.168.*`-style ranges, cloud metadata endpoints) and re-checks every redirect against the same rule. With `birta.network.enabled` off, the default, the paste makes no request and a dismissable prompt offers to turn network features on. The feature also has its own `birta.pasteUnfurl.enabled` (on by default). A link that renders as an embed card is left to the card.

- Frontmatter panel. YAML metadata edits as a borderless key/value grid, list values become removable chips with workspace-wide autocomplete, and the panel collapses (`birta.frontmatterExpanded`) with full keyboard, undo, and screen-reader support. A document without frontmatter opens with no panel at all by default. Turn on `birta.frontmatterAddButton` and such a document shows a quiet Add metadata button instead: committing the first field inserts the fenced block at the top of the file, while abandoning the empty row leaves the document untouched. The Edit Frontmatter command starts the same flow either way.

#### Layout and appearance

- Customizable toolbar. Show, hide, and reorder every item (`birta.toolbar.items.*`), or hide the whole bar; hidden actions stay reachable from the slash menu. Quote, Lists, and Code dropdowns group related inserts, and the bar highlights whatever the cursor is in.

- Typography. Sans, serif, and mono font presets with customizable stacks and a content font-size stepper (`birta.fontPreset`, `birta.fontFamily*`, `birta.fontSize`), plus a Full-Width / Fixed content-width control (`birta.contentWidth`, `birta.maxContentWidth`).

- Per-block width and centering. Embed cards and standalone images center in the content column, and every embed card, image, code block, and table carries its own Full Width toggle: the block spans the whole pane while the rest of the document keeps the column. Images cycle natural size to fit column width to full width, so a small image is never blown up unasked. Top-level blocks only. The choice is presentation-only and the Markdown never changes, so the file round-trips byte-for-byte. Widths persist per document and per workspace, keyed to the block's own content, and survive a raw-editor round trip, window reloads, and restarts; a width whose block no longer matches falls back to the default. The same durability covers folds, scroll position, and the frontmatter collapse.

- One control column for every rich block. Embed cards, images, tables, and code blocks put their key actions in the same place: a column of icon buttons just outside the block's top-right corner, hidden at rest, and pinned open while you are in the block. One order everywhere: the block's primary verb first, then view controls, then editing verbs. There are no delete buttons, since deletion belongs to the block menu and the keyboard. A code block's word-wrap toggle is a remembered per-block choice: an overridden block keeps its wrap across reopens, while an untouched block follows `birta.codeBlockWordWrap`. A persistent tint marks only the toggles whose state is not visible in the content.

- Block rhythm. Embed cards, tables, standalone images, callouts, code blocks, and rendered raw-HTML blocks get generous vertical room (1.5em above and below, top level only), and horizontal rules carry an equivalent band with the line through its middle, so a section break reads as a pause and is a far easier click target.

- Width flips keep your place. Switching the page between Full Width and Fixed re-wraps the whole document, and the top visible line stays the top visible line.

- Word count in the status bar. Words, characters, and estimated reading time for the active document update as you type, and selecting text switches to the selection's count. Counting is CJK-aware. Hide it from the status bar's own right-click menu.

- Resizable Table of Contents. A chrome-free TOC docks on either side (`birta.tocPosition`), resizes by dragging, hides to a small tab, and switches sides in place. Collapsed, hovering the tab flies the panel out as a live floating overlay. Drag TOC items to reorder whole sections, or drag blocks into a section to refile them.

- Sticky heading. The heading of the section you are reading stays pinned under the toolbar as you scroll, carrying its own fold chevron and block handle. Click its title to jump back to the real heading, with the caret on the exact character you clicked.

- Source line numbers. An optional column of quiet line numbers along the start edge of the window, for matching a rendered document against a diff, a build error, a review comment, or an agent. They are display only and off by default (`birta.lineNumbers`, or the Toggle Line Numbers command). The spacing follows the rendered document rather than a fixed ladder: a paragraph that wraps to six rows gets one number and the room it takes, each table row and list item gets its own, and a line that renders nothing sits in the whitespace after the block it follows. Two deliberate omissions: a code block's interior is left to the code block's own line numbers, and a line the editor cannot place honestly, inside a collapsed section or in a document whose text no longer matches the saved source, gets no number at all instead of a wrong one. With the setting off nothing is loaded, so launch is unaffected.

- Live theme following. The editor always matches your active VS Code color theme, recoloring on theme and OS light/dark switches, Mermaid diagrams included.

- Keyboard-first. A Keyboard Shortcuts Help cheatsheet, plus command-palette entries for fonts, checks, and view toggles. UI-level actions are contributed VS Code keybindings, rebindable in the Keyboard Shortcuts editor: the list and heading chords, find and its navigation, Replace, Insert/Edit Link (⌘K), Delete Block (⌘⇧K), Fold/Unfold, Open Block Menu (⌘.), Go to Symbol, and the Raw Markdown switch. The typing-level grammar keeps a fixed chord set, including formatting (⌘B, ⌘I, ⌘E, ⌘⇧X), undo and redo, block move and duplicate, block selection, and insert paragraph above or below. Those defaults cannot be reassigned, but each except undo and redo has a palette entry you can bind an additional chord to.

#### Writing assistance

- Proofreading, offline. Spelling, a Harper-backed grammar engine, and style checks (fillers, clichés, wordiness, passive voice, AI-tell vocabulary, em-dash and punctuation, and more) underline issues inline; click one for a popup with a one-click fix, Ignore, or Add to dictionary. A unified Checks menu groups them under a master Proofreading switch (`birta.proofreading.enabled`), and each check toggles individually. It runs entirely offline, is decoration-only, and loads after the editor is interactive, so a check you have turned off costs nothing.

- A review sidebar with Links, Notes, and Proofreading tabs. The table-of-contents drawer is now a review panel, and a review tab appears only while it has entries. Links lists every link in the document (inline, autolink, reference, and wikilink) grouped by destination, with the URL beside the title and an Open action that follows the link from the sidebar. Notes lists the editor-note markers you leave for yourself while drafting, each clickable to jump to; a note is document content, so clearing one means editing the document. Add your own with `birta.notes.customMarkers`, where a plain token like `DRAFT` matches only as a whole word. Proofreading lists every current finding with the same Ignore, and Add to dictionary for spelling, it offers inline. All three lists group by type under collapsible headers by default, with a By type / In order toggle (`birta.review.groupByType`), and jumps land with a couple of lines of lead-in context. The Contents tab's outline is foldable, view only, so it never folds the document. Inside the sidebar everything is keyboard-navigable, and Escape hands focus back to the editor; getting to the sidebar from the text still needs the mouse, because Tab is the editor's own indent key. Only the tab you are viewing does any work, and the has-entries checks run on idle, never while the document is opening or you are typing.

#### Coding-agent integration

- Share your file and selection with AI coding agents. An agent (Copilot, Cursor, the Claude and Codex sidebars, and others) normally cannot see which file you have open or what you have selected while you are in the WYSIWYG editor, because VS Code hides a custom editor from its active-editor API. Three ways to close that gap:
    - A precise clipboard reference, one click away. Select text and the floating palette's AI button puts a `path.md#L12-L20` reference on your clipboard (hide it with `birta.floatingToolbar.items.agentReference`). The same Copy Reference for AI Agent and Copy Selection + Reference for AI Agent commands sit at the top of the right-click menu and in the palette; the second quotes exactly what you selected below the reference as a fenced block of real source markdown, trimmed to your selection's exact start and end even mid-line.
    - A Language Model Tool (`#birtaSelection`) lets Copilot agent mode, and any tool-using agent, pull your current file, caret, and selection on demand. Requires VS Code 1.95+.
    - A public extension API (`getActiveEditorContext()`, returned from `activate()`) lets any cooperating extension read the same live file and selection.

#### Platform

- Remote workspaces. Works in Remote-SSH, WSL, and Codespaces.

- Fast launch. Heavy dependencies (the KaTeX stylesheet, about 70 syntax-highlighting grammars, the Mermaid engine, the inline-HTML sanitizer) load on demand rather than at every open, so a document with no math, code, or diagrams loads a fraction of what it used to, and proofreading and fidelity checks settle in after first paint rather than blocking it.

- A hard fork, in English, source-available under the Functional Source License (FSL-1.1-ALv2). It is free to read, run, modify, and self-host for any non-competing purpose, converting to Apache-2.0 two years after each release. Portions derived from the MIT-licensed project this one forked from remain under that license; see `LICENSE`, `NOTICE`, and `LICENSE-MIT`.

### Changed

#### Performance

- Selecting blocks costs far less on a long document. Selecting a run of blocks, an image, a horizontal rule, or a range of table cells made the editor restyle the entire document, about 170 ms on a 300 KB file and again when the selection was released; it is now under 5 ms, and the total time the editor spends blocked across a burst of selections dropped by about 75%. The same cost hit every arrow key that lands the caret in the gap beside a table or code block. Nothing looks different.

- Typing in a long document costs less per keystroke. On a 300 KB file of several thousand blocks each keystroke took around 45 ms of blocked main thread, which reads as the caret lagging behind your fingers, and is now around 6 ms; the total blocked time during a typing burst dropped by roughly 85%. A 96 KB file went from about 7 ms to about 2 ms per keystroke, low enough that the harness recorded no long frame across a whole burst, and a link-heavy document from about 4 ms to about 2.6 ms. Moving the caret went from about 5.5 ms to about 3.4 ms on that 300 KB file. Editing code changed most: from about 38 ms per keystroke inside a fenced code block to about 9 ms, because only the block you are editing is re-highlighted now. Pressing Enter went from about 33 ms to about 20 ms. Opening a file is unaffected, and the handles for what is on screen are worked out after the editor has painted, appearing as you scroll. Nothing about the document changed: block positions and page height are the same, folded sections stay folded, table alignment still follows its header, and syntax highlighting is byte-for-byte what it was.

- Opening a document is faster, whether or not you ever use Find. A 300 KB file opens about 10% quicker, and a medium one about 6%. The find bar's match highlighting was defined in the stylesheet loaded at startup, so every document paid for search highlighting on open, including documents where Find was never opened. Those styles are now installed the first time something is highlighted, and nothing about Find changes from the first search onward.

- Opening a long document is faster. The fold chevrons and block handles in the gutter of every heading used to be built while the editor was still coming up. On a fresh open they settle in just after the text first paints: measured about a quarter faster to first paint on a 140-heading document. A document opened with folds still collapses them before the first paint, so nothing flashes.

- Every document opens faster, code or not, with about 110 KB less code loaded before the editor appears. Two things were being paid for on every open: a second, unconditional copy of about 35 syntax-highlighting grammars, which the on-demand set already covered, and the sanitizer behind inline HTML, which now loads only when a document contains raw tags. Highlighting and inline HTML render exactly as before, and an inline tag paints a fraction of a second after the text the first time one appears.

- Typing in very large documents is lighter with the outline panel showing. Every keystroke used to recompute the whole table of contents even when the edit could not have changed it. Ordinary typing in body text now skips that recomputation, measured as about a third less total typing stall on a 300 KB document, while edits that touch a heading still update the outline right away.

- Drag auto-scroll holds 60 frames a second on very long documents, and starts where the text does. On a synthetic 15,000-block document, holding a drag near an edge managed about 5 frames a second, so the drop line lurched instead of tracking the pointer; at that size it now holds a steady 60, around eight times the travel for the same gesture. The top scroll band begins at the toolbar's lower edge rather than the very top of the window, so the drag no longer starts creeping upward while the pointer is still well inside the text. Both apply to every drag in the editor.

#### Editing and keyboard

- Backspace at the start of a nested list item joins it onto the previous line. The item break is deleted like a text editor joining lines: the item's text lands at the end of the line above and its sub-items follow one level up, instead of the old outdent-one-level-per-press. Cmd+Backspace on an already-empty item deletes the item and returns the caret to the previous line instead of doing nothing. Top-level items are unchanged: Backspace at their start still removes the bullet. The join only ever targets a paragraph, and an item sitting below a code block outdents instead, so a keystroke can never pour prose into the code.

- ⌘⇧↑/↓ extends the selection instead of moving the block. On macOS that means select to the start or end of the document, matching VS Code's raw editor and every native text field; Ctrl+Shift+↑/↓ likewise regains its native meaning on Windows and Linux. Moving blocks stays on ⌥↑/↓, the block menu, the drag handle, and the Move Block Up/Down commands.

- Editing chords require the editor itself to be focused. With the editor as the active tab but focus in the Explorer or sidebar, pressing a document-mutating shortcut (⌘⇧K, ⌃J, the list, heading, and paragraph chords, ⌘K) used to edit the document you were not looking at. These chords now require the editor itself to be focused; find, fold, and navigation shortcuts are unchanged.

- "Select All Occurrences" is now "Change All Occurrences", and answers ⌘F2. The old title borrowed VS Code's ⇧⌘L verb, which puts a cursor at every match; Birta is a single-selection editor and cannot do that. What the command actually does, seed the search from your selection and open the find bar focused on Replace, is VS Code's Change All Occurrences. ⇧⌘L keeps working as a second binding.

- Find in Selection shades the range it is searching. Nothing marked the scoped range before, and once focus moved into the find input the selection highlight could stop rendering, so matches elsewhere read as having vanished. The range is now tinted with VS Code's own find-range color.

- `birta.calc.enabled` applies to open editors immediately. Flipping the inline-calculator switch reaches every open editor live, instead of waiting for the file to be reopened.

- Reordering a heading in the outline sets its level to match where you drop it. Drop onto a heading to make the section its child, or on the line between headings to make it a sibling of the heading below. The whole subtree moves with it and shifts by the same amount, and levels that would pass H6 stop there. A drop whose position already matches the section's level leaves it untouched, and the whole thing is one undo step. Dropping onto a collapsed section files it inside and opens the fold to show where it landed. Dragging a heading's gutter handle in the document is unchanged and stays a literal move.

#### Round-trip fidelity

- Nesting one `:::` directive inside another survives a save. Moving a `:::note` or `:::info` admonition into another directive writes the outer fence longer than the inner (`::::` around `:::`, the CommonMark convention), so the inner block reopens as a directive instead of flattening to plain text.

- Moving a horizontal rule to the top of a directive or a callout keeps it a rule. A `---` dropped directly under a directive's opening fence, or under a callout's `> [!NOTE]` marker line, turned that line into a heading and destroyed both the rule and the container.

- Moving a block between callouts keeps both callouts whole on reopen. Dragging a paragraph out of one callout or blockquote and into another left a stale blank line where the emptied one sat, so on reload the destination callout was split in two and the moved block landed in a plain blockquote.

- Moving a block keeps an escaped `\==highlight==` escaped. A hand-escaped highlight literal kept as plain text re-serializes with its backslash intact, instead of dropping the `==` bytes and turning into a highlight on reopen.

#### Chrome and panels

- The editor chrome shares one visual system. Buttons, menus, popups, and panels across the toolbar, find bar, table of contents, link editor, image and selection toolbars, code-block headers, and the metadata panel draw from a single set of corner radii, text sizes, and hover behaviors, and menu rows and their group headings share one row anatomy. Customize Toolbar joins the system: its Done button matches the standard filled-button style, and the Hidden tray wears a faint diagonal-stripe pattern so "off the bar" reads differently from the two placement areas. Most differences were a pixel of drift; the visible ones are cohesive corners on floating menus and consistent feedback on small icon buttons.

- Floating menus and panels cast a much lighter shadow, roughly half the ink of before. A menu, popup, panel, toolbar, or tooltip reads as lifted off the page instead of ringed by a dark halo. Every floating surface shares the one shadow, and it stays a quiet dark lift on every theme, where the outline fly-out, its overflow menu, the Keyboard Shortcuts card, and the link popup previously used the theme's widget-shadow, which on some dark themes inverted to a glow. The image dialog and lightbox keep a wider, softer version. A diagram opened fullscreen is crisper too, with the shadow under its white canvas instead of tracing a halo around every node and label.

- A little more air under headings. The space between a heading and the content it opens grew slightly, in the shared spacing token behind every heading level, so a list directly under a heading no longer reads cramped against its baseline. Headings still sit visibly closer to their own section than to the block above.

- The block palette leads with the selection's type. Its leading button shows the selected blocks' own gutter symbol whenever every block in the selection is the same kind: a list icon, an H1–H6 badge, a paragraph's pilcrow. A mixed selection keeps the neutral grip.

- Menu group headers share one typographic voice. The slash menu, block menu, and toolbar dropdown section headers use the same heading grade as the sidebar's group headers, replacing four hand-rolled all-caps caption styles.

- The display (A) menu slimmed down to the frequent moves (size, width, family). Font settings and Show Block Handles are Settings-only now; `birta.blockHandles` and its palette commands still work.

- The Keyboard Shortcuts panel is a true inventory. It lists only the fixed, always-accurate shortcuts, and the Edit Keyboard Shortcuts button sits in a fixed footer below the scrolling list. The old names-only "customizable commands" listing is gone: those keys live in VS Code's own Keyboard Shortcuts UI, which the button opens.

- The sidebar is wider by default and cannot be crushed: default width 260px (was 220), minimum 240px (was 150). When the visible tabs do not fit, they collapse into a dropdown showing the active tab instead of clipping or wrapping.

- The table of contents width is now a `birta.tocWidth` setting. It lived in hidden extension state, and is now editable in `settings.json`, scopeable per-workspace, carried by Settings Sync, and echoed live to every open editor. Dragging the panel's edge still updates it.

- The slash command menu opens inside headings. Typing `/` in a heading did nothing, because the heading's own text normalization suppressed the menu right after the keystroke.

- Blocks nested inside a list item have a grabber. A blockquote, code block, callout, table, or heading indented under a list item had no gutter handle at all, so its block menu and drag handle were unreachable.

- List grabbers inside a callout, quote, or directive step clear of the accent bar. The handles now step clear of every enclosing bar, at any content font size.

- The numbered-list block handle stays clear of multi-digit numbers. On a list reaching item 10 or beyond, or at 150–200% content scale, the grabber sat on top of the number as an invisible click target. It now tracks the number's width and the content font size.

- Diagrams fit at up to 100% and follow the pane. Fit-to-view no longer enlarges a small Mermaid diagram past its natural size to fill the preview, inline or fullscreen, so zoom in manually when you want it bigger. Diagrams refit when the pane is resized, unless you have panned or zoomed by hand.

### Fixed

#### Files and saving

- A file written with Windows line endings keeps its CRLF endings throughout. In a `.md` file saved with CRLF endings, typing a single character rewrote the paragraph you edited, and the blank lines around it, with Unix LF endings while the rest of the file kept its CRLF. Every line you do not touch now keeps the exact ending it was written with, an edited line keeps its own, and a line you add takes the ending the rest of the file uses. The same fix restores the other formatting guarantees on these files: a stray `\r` also defeated the checks that recognize a divider or an underlined heading, so a CRLF file's `- - -` divider was rewritten to `---` on an unrelated edit where an identical LF file's was left alone.

- Editing a tab-indented outline block keeps the blocks nested under it attached. In a file whose nesting is written with tabs (a Logseq graph, or any hand-written outline), typing into a block that had children rewrote that line with space indentation while its untouched children kept their tabs, so the children ended up indented too far and stopped being list items at all: a child could reopen as literal text (`\- child`) inside the block above it, one keystroke after touching an unrelated word. An edited line now keeps the exact indentation it was written with, and that extends to outlines that mix indent units, where the edited line used to become a sibling of its own parent. Genuinely indenting or outdenting still saves as the real change it is.

- Moving a block in a tab-indented outline keeps the file's nesting. The moved line was saved with the editor's own two-space indentation while every line you did not touch kept its tabs, so on reopening a sibling became a child, a nested list appeared that you never made, and in a deep outline a block could come back as literal text inside its neighbour. This did not need an unusual file: a plain tab outline, the ordinary Logseq or Obsidian shape, was enough, and it applied to a fifth of the moves possible on a realistic page. A moved block is now written with the indentation the file itself uses at that depth, and an item's continuation lines and any code fence inside it move with it.

- A bullet whose content is a heading or a quote keeps the list around it intact. When a list item's content is something other than a plain paragraph (`- # Project Atlas`, the ordinary Logseq shape; `- > note to self`; a code fence; a table), the editor saved it as an empty bullet with the content indented underneath. On reopening, that empty bullet was read as an underline for the line above it, so the block above turned into a heading and the nesting under it was gone; in a tab-indented file the content came back as literal text in a code block. Both moving such an item and typing inside one could put that shape on disk. The item is now written with its content on the bullet line. On the realistic Logseq page this was measured against, 10 of the 247 moves you could make were still corrupting the file after the previous indentation fix, and none are now. One shape is deliberately left as it was, and is not yet correct: an item whose content is a horizontal rule, nested under another bullet, still loses the nesting on reopen, because both available spellings collide with something.

- Editing one block in a Logseq file leaves its neighbors alone. Logseq graphs indent their whole block tree with tabs and carry org-style tokens (`[#A]` priorities, `CLOCK:` timestamps, `[3/7]` progress). Editing one nested block used to rewrite the surrounding run, collapsing tabs to spaces and turning `[#A]` into the meaningless literal `\[#A]` on lines never touched, scaling to most of a deeply nested page. Untouched lines now keep their bytes exactly, and the edited line keeps its org tokens unescaped. A bracket that matches a reference definition elsewhere in the file keeps its escape, since unescaping it would create a link.

- Editing one table cell leaves every other cell in that row byte-for-byte. A table row is a single line, so typing in any cell re-wrote the whole row on save: a cell containing only `<br />` came back empty, and other `<br>` spellings in that row were rewritten, losing content from cells the cursor never visited.

- Your list markers and numbering survive an edit to a neighboring item. A list written with `+` or `*` bullets came back with `-`, a `1)` `2)` `3)` list came back as `1.` `2.` `3.`, and a list numbered `1.` `1.` `1.`, the style people use precisely because it survives reordering, was renumbered. One keystroke anywhere in the list rewrote the marker on every other item. A list's bullet character, its `.`-or-`)` delimiter, and whether it counts up or repeats one number are now read from your file and written back as you wrote them. Lists you create in the editor are unchanged, and a list that Markdown requires to differ from the one above it still does.

- The editor never rewrites a list's tight or loose spacing. A keystroke near a nested list used to insert blank lines between every item on save, and edits inside a deliberately loose list silently deleted its authored blank lines. The only blank lines the editor ever adds are the ones Markdown's own meaning depends on, where leaving them out would make the file reopen as something other than what you saw. New items inherit their list's spacing, and lists created in the editor start tight. This holds per gap rather than per list: a list with one stray blank line keeps it exactly where it was and stays tight everywhere else. Deliberate cleanup is the Tighten List action.

- A link in angle brackets keeps exactly the backslashes you wrote. A URL ending in a backslash doubled its backslashes on each open-and-save cycle: one became two, two became four, four became eight, without limit. A save with no edits was never affected, since the growth only started once the line had been touched.

- Typing inside a `~~~` code fence keeps the rest of the file. When a fence sat just after a line the editor rewrites on save (say a paragraph containing a literal `*`), a single keystroke inside the fence could save its opening line as a backtick fence while leaving the closing `~~~` untouched, and everything below reopened as code, silently. Fences now keep the marker style they were written with.

- A document ending in an unclosed code fence keeps its fence open when you save. A file whose last construct is an unterminated ` ``` ` fence (a snippet cut off mid-paste, a template, a deliberately open example) gained a synthetic closing fence on every save, even a save with zero edits. It now keeps exactly the fence you wrote, at the end of a document or auto-closed inside a blockquote alike. Editing the lines around the open fence still adopts the canonical closed form.

- A save with no edits leaves a file that mixes a tab-indented code block with a divider exactly as it was. If an indented code line's content coincided with a divider elsewhere in the document, the fidelity layer mistook one for the other, gave up entirely, and the next save converted the code block to a fence and reflowed constructs the editor cannot reproduce byte-for-byte. Lines are now compared with their construct context, so lookalike bytes in different constructs can never be confused.

- Whitespace edits inside a code fence now save. Swapping a tab for spaces, or the reverse, at the start of a line inside a top-level code fence read as "no change" and was silently reverted. Fence content is now compared byte-for-byte. Inside a fence nested in a tab-indented outline, leading indentation still compares by depth, which is what keeps Logseq files from churning.

- Moving a raw `:::` line into a directive keeps it on its own line. Dropping unpaired `:::` fence prose at the tail of a `:::tip`-style directive saved fine but reopened glued onto the preceding paragraph. The same rule protects a divider moved directly under a paragraph, where gluing those turns the paragraph into a heading.

- A setext (underlined) heading next to a divider keeps its underline. Moving one beside an asterisk or dash-style divider could trade bytes between the heading's `-----` underline and the divider, splitting the heading into a paragraph and a rule.

- A save after a failed editor rebuild writes the document's own current bytes. If rebuilding the editor for an external file change failed partway, the editor showed blank, and a Cmd+S in that state answered the save with the previous document's bytes, quietly reverting the on-disk file. A failed rebuild now leaves the save pipeline inert, and the editor recovers on the next successful open.

- Cmd+S always saves what you just typed. A save could silently do nothing and leave your latest keystrokes unwritten: the editor took about 200 ms to register an edit with VS Code, and typing continuously never registered at all, so saving mid-flow could write nothing no matter how long you had been typing. The same delay bounded how much recent work VS Code's crash backup held. An edit now registers within a frame.

#### Editing and typing

- Typing above or below a table or code block stays outside it. A block that starts the document, ends it, or sits directly against another one had no caret position beside it, so arrowing or clicking toward that gap put the caret inside the neighbouring block and the next thing you typed landed in a table cell or a line of code. Those positions now exist and show a caret, and clicking the empty space above the content reaches the first of them. One related case is not fixed: pressing ↓ onto a horizontal rule still selects the rule, so a keystroke replaces it.

- Converting a list converts the whole tree, everywhere. Switching a list between bullet, ordered, and task used to change only the outermost layer from the block menu, and the toolbar's Lists menu and the slash menu could not convert an existing list at all. All three surfaces now run one converter, in a single undo step. Converting to a task list preserves boxes already ticked in nested items, and converting away clears them. Picking the flavor a list already has still toggles the caret's line out of the list.

- Deleting what separates two lists leaves one list, not two. Removing the paragraph between two same-kind lists used to leave two adjacent lists that read as separate blocks, and a save made the split permanent by switching the second list's bullet marker, since that is the only way Markdown can express adjacent lists. Adjacency your own edit creates now merges automatically, in the same undo step. A split the file already carries is the author's syntax and is never merged silently.

- Inline multiplication written with asterisks stays literal text. A star pair that reads as multiplication (flanked by a digit, `)`, or a word character, with numeric content between the stars) stays literal text, and the literal stars are escaped on save and round-trip. Prose italics are untouched, intraword emphasis included. A file authored elsewhere with the unspaced form still parses as CommonMark emphasis on open; write `60 * 60` or use a ` ```calc ` block for formula-heavy text.

- Typing right after a link produces plain text, not more link. Inserting a link leaves the caret at the link's end, and the next characters used to silently join the link's text. They are now plain text; to change a link's own text, use the link editor.

- Adding a heading that repeats an existing one leaves the older heading's links pointing where they were. Two headings with the same text are told apart by a `-1` suffix in document order, so introducing a new heading above an identical one renamed the older heading's anchor out from under it, and existing links quietly began jumping to the newcomer. Those links now follow the heading they were pointing at, through every way a heading appears: pasting one in, pasting over a selection, and promoting a paragraph. Duplicating a section keeps the copy's own links pointing inside the copy.

- Delete Block (⌘⇧K) from a plain caret in a table cell does nothing, where it used to delete the whole table. That matches Join Lines' never-destructive rule; deleting a table stays deliberate.

- A just-inserted diagram, math, or calc block stays editable. An empty previewable block used to drop straight into its rendered preview, which hides the source, so there was nowhere to type. Empty blocks now start in code mode, and a non-empty one still opens in preview.

- "Move Up" is disabled on a block nested in a list item, where it has nowhere to go. The first block under a list item's own line offered a live Move Up row that did nothing when clicked, since a list item has to start with its own text. The row is now disabled. Moving such a block down past its siblings is unaffected.

- A file you just created is offered as a link target right away. Link autocomplete and the frontmatter value suggestions worked from a workspace scan refreshed on a timer, so a newly added file could take up to ten seconds to become suggestible and a deleted one kept being offered. Both now refresh the moment a file is created, deleted, or renamed.

- Path suggestions leave an IME's own keys alone. While composing with a Chinese, Japanese, or Korean input method, an open suggestion dropdown took Return and the arrow keys out of the whole editor, so choosing a candidate from the IME's own window either did nothing or picked a file. Composition keys now pass straight through, in every path field.

- Suggestion dropdowns near the bottom of the window stay on screen. The path and image-path lists flip above the field when there is not room below, the way the link and slash menus already did. In the image path list, arrowing to a row while the pointer rested on another painted both as selected; the keyboard highlight is now the only one.

#### Folds

- Changing a heading's level keeps the content below it visible. If a folded section sat above, retyping a heading to a deeper level could pull that heading and its body inside the fold, where they were hidden with no warning. The fold now opens whenever an edit would grow it over content you could see.

- A block dropped at the end of a collapsed section stays where you dropped it. Dragging a block to the boundary just below a folded heading dropped it inside that collapsed section, so it vanished with no trace, reading as if the drag had deleted it. The fold now opens to show the block where you dropped it.

- Pasting into a collapsed list item's first line keeps the rest of that line where you can see it. Everything after the paste point, plus part of the pasted content, ended up hidden inside the fold. A fold now opens whenever an edit would grow it backward over content you could see, while ordinary edits in a collapsed item's visible line still leave the fold alone.

- Moving a collapsed section leaves the destination's content outside its fold. Dropping a collapsed heading somewhere nothing out-ranks it silently swallowed every following block into the fold. If the fold would hide anything at the destination it did not hide before, it now opens instead.

#### Editors and navigation

- Switching between rich text and Raw Markdown keeps your cursor and your selection. The switch moved the view but never the caret, so arriving in rich text the first thing you typed went in at the very beginning of the file, and going the other way the raw editor opened at whatever line was mid-screen. Cmd+Shift+M, the toolbar's Edit Raw Markdown, and the right-click entry now carry the cursor, column included, in both directions. A selection survives too, drag direction included, even a block selection, which arrives in the raw editor as those blocks' whole source lines. The column holds inside formatted text; only where the two sides cannot be aligned, as with an image or math, does it fall back to the start of the line. Hard-wrapped paragraphs map line by line, tables map row by row with the column inside the right cell's text, and callouts, container directives, and Notion asides map their bodies and titles to the right lines. Both sides scroll the arriving cursor to the center of the view.

- The Raw Markdown keybinding switches the pane you are focused in. With two editors split side by side, Cmd+Shift+M always switched the leftmost pane no matter which had focus, while the toolbar button was unaffected.

- The Edit Rendered Markdown shortcut and button work on a file another extension has claimed. A recent VS Code assigns its own language id to files matching certain names and extensions (any file named `SKILL.md`, or one ending in `.instructions.md` or `.agent.md`), even though the file is ordinary Markdown on disk, and the shortcut was gated on VS Code's `markdown` language id. Both now also match by file extension (`.md` / `.markdown`).

- Jumping to a line lands on the block you asked for. Two causes made the editors disagree about what a line number means. Frontmatter: the line map counted the YAML block the rich-text view does not show, so every line exchanged was off by the height of that block. Loose lists: a list with blank lines between its items is several blocks in the file but one in the editor, so from that list onward every line resolved one block early. Line numbers are now translated across the metadata boundary, and a line is checked against the text of the block it claims to be in before the editor acts on it.

- Clicking a search result lands on the match. A hit in VS Code's search opened the file in Birta and then sat at the top of it, leaving you to hunt for the line. The match is now selected and revealed, centered and without animation, whether or not the file was already open, and an arriving jump takes precedence over the editor's remembered scroll position. Any other navigation VS Code aims at a Markdown file arrives the same way: a problems-panel entry, a `file.md#L120` link, or `code -g file.md:120`. Opening a file normally still returns to where you left it.

- A file with unsaved changes is never taken over by the rendered editor. With edits you had not saved, anything that also opened the file in the raw editor made Birta close that raw tab to render it, and closing an unsaved file is what makes VS Code ask "Do you want to save...?", with the wrong answer discarding the edit. Birta now leaves such a tab alone, at the cost of it staying in raw Markdown until you save. Switching modes yourself with ⇧⌘M still works exactly as before.

- View state survives switching to the raw editor and back. Folds, scroll position, and the metadata panel's Hide/Show choice were reset on every round trip through Edit Raw Markdown, because that switch recreates the editor's webview. The editor now keeps each document's view state for the session.

- Find results stay current as you edit. The find bar computed its matches once per search, so deleting one of 15 matches kept showing 15, Find Next jumped to where matches used to be, and Replace All could rewrite the wrong characters. Anything that acts on a match now re-searches the live document first, and the count and highlights refresh shortly after you pause.

- The outline updates as the document changes. The table of contents refreshed on the save cadence rather than on edits, so it could trail by several hundred milliseconds mid-burst and up to two seconds during continuous typing. It now reflects an edit on the next frame.

#### Diagrams and previews

- A Mermaid diagram you have edited re-renders exactly as it first rendered. Toggling a ` ```mermaid ` block to code, editing the definition, and toggling back often came back mangled whenever the diagram was not resting at exactly 100% zoom: node text clipped, boxes mis-sized, with reopening the file the only cure. Rendering now measures the diagram on a clean off-screen surface instead of inside the zoomed preview.

- Mermaid diagrams follow theme changes. With `birta.mermaid.theme: auto`, switching VS Code between light and dark left already-rendered diagrams in their old palette until their text next changed; they now repaint in place. A re-render requested while a slow render is in flight is no longer dropped, so the newest definition wins.

- Switching a preview block between diagram, formula, and calculation languages switches the preview. Changing a ` ```math ` block's language to `mermaid` left the stale formula on screen while the diagram rendered into a hidden pane. Flipping to a previewable language while the block is empty drops to code mode so it stays editable.

- Editing an image's path or caption from its toolbar shows a caret, and shows what you have selected. While the image stayed selected, its fields drew no text cursor and painted no selection highlight, so a select-all looked identical to having selected nothing.

#### Panels and chrome

- The table of contents snaps into place when a document opens. The panel's load-time reveal is meant to snap into place, but when the editor finished mounting inside a single frame it faded and slid in instead. A show or hide you invoke yourself still animates.

- Showing or hiding the table of contents now sticks. That choice used to reset whenever the editor was recreated from scratch, falling back to the auto-open-by-heading-count default. It is now saved to `birta.tocVisibility` (`auto`, the default, which decides by heading count per `birta.tocAutoHideThreshold`, or `shown`, or `hidden`), and changing it updates every open editor at once.

- The ToC flyout opens at your place in the document, with the active heading centered, rather than scrolled to the top. It also sizes to its contents, still capped and scrolling only once the outline is long, instead of inheriting the docked drawer's full height and trailing empty card.

- The table of contents starts its first row below the panel buttons. Docked, the side-switch and hide buttons floated on top of the first outline row. The list now starts below them and keeps clear of the window's bottom edge.

- Heading gutter badges sit on their text line. Every heading's H1–H6 badge and fold chevron sat below the line it belongs to, about a third of a line at top level and about 8px inside a blockquote, callout, or directive, because the offset compensated a padding at the wrong size. All six levels now align at every content scale.

- A block menu opened near the toolbar sizes to the space available. When its anchor sat scrolled under the toolbar, the menu was pushed down without shrinking and its tail ran off the bottom. It now sizes to the space available and scrolls inside itself.

- The pinned heading's tooltips drop below their control whenever the toolbar leaves no room above, instead of drawing behind it.

- Content clears the toolbar at any UI font size. The editor's top clearance was a fixed 56px while the toolbar's height grows with the UI font. The clearance now tracks the toolbar's real height, and hiding the toolbar reclaims its space.

- Customize Toolbar's two drop areas keep a small permanent gap. The left and right placement zones' drop-target outlines ran into each other, so the toolbar's two halves now keep a small permanent gap.

- Screen readers hear one selected item in the block menu. On a callout set to "Collapsed by default", both that row and the Callout block type announced as selected. The fold toggle now announces as a checked item, and the block type keeps the selection.

### Security

- Network consent is now user-level only. The settings that let the editor touch the network or write fetched content into a file (`birta.network.enabled`, `birta.embeds.enabled`, `birta.pasteUnfurl.enabled`, `birta.pasteUnfurl.autoApply`) can no longer be set from a workspace's `.vscode/settings.json`. Previously a repository you opened could quietly enable them for you; now only your own user settings decide. Accepting an in-editor Enable prompt likewise always records your choice in your user settings.

- Embed players run in a sandboxed frame. The click-to-load player iframe (YouTube, Loom, Figma) carries a minimal capability sandbox: the framed page can run its player but cannot navigate your editor, submit forms, trigger downloads, or write to your clipboard. What hosts may be framed was already pinned by the content-security-policy; this pins what a framed page may do.

---

Versions before `2026.731.0` predate the Marketplace listing and were never publicly installable. Their history is kept in [`docs/CHANGELOG-PRE-MARKETPLACE.md`](docs/CHANGELOG-PRE-MARKETPLACE.md).
