# Changelog: Birta Writer for Mac

Birta Writer for Mac is the macOS menu-bar app in `mac/`. It runs the same editor Birta Writer for VS Code does, out of the same `dist/webview.js`, so every editor change reaches it and those are recorded in [`../CHANGELOG.md`](../CHANGELOG.md) rather than repeated here. This file records the app AROUND that editor: its panel and window, menu bar, settings, file handling, packaging and install.

The two are separate because they have different readers and different ways in. The extension is installed from the VS Code Marketplace and Open VSX, both of which render `CHANGELOG.md` out of the VSIX; the Mac app is installable from neither, and arrives as an app attached to a GitHub Release. An entry a Marketplace reader cannot act on spends the attention the ones they can act on need.

Both surfaces are now called Birta Writer, so an entry here that needs to name its subject calls it Birta Writer for Mac. That is not a second product name; it is the disambiguator the word Jot used to be, moved into the convention now that the two products share a name. `shared/__tests__/changelogSplit.test.ts` matches that spelling, and it is the only thing holding the split up from this side: a bare "Birta Writer" opening cannot be matched there without firing on most of the editor's own entries. Entries below the rename keep the spelling they shipped under.

Versions are shared. Both files are stamped with the same release version, and a version appears here only when something about the app changed in it.

---

## [Unreleased]

### Added

- A Markdown pane in Settings, holding the syntax targets Birta Writer for Mac writes for: GitHub, Obsidian, Pandoc, and Birta Writer's own. All four ship on. Turning one off withdraws the rows that write its syntax from the Format menu, with their keyboard shortcuts, and from the toolbar and menus in the panel below it, so the window offers one answer rather than two. CommonMark is always available and is not in the list, because every target includes it; turn all four off to write CommonMark alone.

  Nothing about a note changes. Every file opens with everything it contains drawn in full whatever is selected, and the rows that edit what is already there stay: a table keeps its row and column controls, and a task list keeps Toggle Task Done and Uncheck All Tasks even where Task List has gone. See [`../CHANGELOG.md`](../CHANGELOG.md) for what the setting does inside the editor itself.

### Fixed

- Birta Writer for Mac draws a fullscreen diagram's name clear of the window buttons. A fullscreen surface covers the whole window, titlebar included, and puts the diagram's name in the top-left corner, which on this app is the corner the traffic lights occupy, so the two were drawn on top of each other. The name now starts after them, on the axis the rest of that band already lines up on.

---

## [2026.901.0] - 2026, September 1

### Added

- Edit Frontmatter, in the Edit menu. It puts the cursor in the metadata panel, or starts one on a note that has none. This window has no command palette, so the panel had no way in of its own: a note that arrived without metadata could not be given any.

### Fixed

- A note's frontmatter is shown in the metadata panel, the way it is in Birta Writer for VS Code, and it is editable there. Birta Writer for Mac handed the whole file to the editor, so the block reached the Markdown parser instead of the panel: the opening `---` drew a horizontal rule and the keys under it were rendered as body text, most often as one large heading, and there was nowhere to read or change the values as fields.

- Editing a note that has frontmatter no longer damages the block. Because the block was in the document rather than the panel, the editor wrote it back as what it had parsed, and the closing `---` was not part of that: the first edit to such a note turned its metadata into ordinary body text, saved. Notes already damaged this way are not repaired, and the fence has to be typed back by hand.

---

## [2026.828.0] - 2026, August 28

_No user-visible changes; internal work only._

---

## [2026.827.0] - 2026, August 27

### Added

- Check Spelling and Check Grammar, in the menu bar. Both have been running on every note this app opens, answered by macOS's own checker, and neither had a control anywhere in the menus: the View menu did not list them at all. They sit under View > Proofreading now, with the master switch above them and a checkmark on each. Check Grammar does have an effect, and always did; macOS objects to a sentence that disagrees with itself and draws it in a different colour from a misspelling.

- Style Options, under View > Proofreading, with a row for each individual style check: Fillers, Redundancies, Cliches and Wordiness, then the AI tells, then the prose ones. The same rows the panel's Checks button offers, in the same order and under the same names, each with a checkmark.

- More than one window. Cmd+N and Open now make a window rather than replacing what is on screen, so two notes can be open at once, and each window has its own title, its own buffer and its own saving. Opening a file that is already open brings that window forward instead of opening it twice, which matters beyond tidiness: two windows over one file would both write the whole file and the later write would win with nothing to say so. Cmd+W closes a window, except the last one, which hides as it always did so the next summon is still instant. The summon hotkey shows and hides every window together. Quitting asks about each unsaved note in turn, and Cancel on any of them keeps the app running.

- The notes folders wear the app's mark in the Finder, the way the folders of other apps that keep one in iCloud Drive do, so the folder is found by looking rather than by reading. Both folders the app names get it, the one in iCloud Drive and the one in Documents, whichever is currently in use. A folder you have given your own picture to is left alone, and deleting the icon puts the plain folder back for good.

- A Show in menu bar setting, on by default, under Settings > General. Turning it off leaves the app with no menu-bar icon, which suits anybody who summons it by hotkey or keeps it in the Dock. It is bound to Show in Dock by one rule: whichever of the two is the last one on cannot be switched off, so there is always a way to open the app without its hotkey. The row that is currently the last one says so rather than simply refusing.

### Fixed

- The Highlight note markers switch is remembered. Nothing stored it, so it went back to on at every page load, which for this app is every file you open. If you had turned the `[TK]` and `TODO:` tints off, they came back the next time you opened a note.

- The editor is locked while the file it was editing is gone. It stayed editable, so anything typed into it was refused by the panel and dropped without a word, in the one state where what is on screen may be the only copy of it. What is there can still be selected and copied somewhere safe, which is what the card is offering; it just cannot be added to until the file is back or a new note is started.

- Open Recent lists a file you closed a window on. A file joined the list when the panel moved off it, which was every case while there was one window, because the only way to stop looking at a file was to go to another one. A window that opened a file and closed was not one of them, so the file it had been showing was one the menu had never heard of.

- The notes folder gets the app's mark back when the app rebuilds it. The mark is a file inside the folder, so deleting the folder takes it, and the folder comes straight back the next time anything is written into it. It was only ever applied at launch, so a folder deleted mid-session stayed a plain blue one until the app was next started.

- Turning off Show in Dock no longer sends the app to the background. macOS reads the change as the app no longer being a foreground app and deactivates it, so every window went behind whatever else was open at the moment the switch was moved, and the only way back was the menu bar or the summon hotkey. The window you are looking at stays in front now, and the switch does nothing at all when it already agrees with the policy.

- The titlebar's New Note, Open and Open Recent buttons name themselves when the file you were on has gone. The label was being drawn by the page, underneath the screen that says the file is missing, so it never appeared in the one state where those three buttons are what you need. The Settings gear beside them was hidden the same way.

- With Automatically save changes turned off, dismissing the panel no longer writes the note. It did so through a path that never consulted the setting, so the one promise that switch makes was being broken by the most ordinary gesture there is. The same path also wrote the file on the way out of a quit before the Save / Don't Save question appeared, which meant Don't Save had nothing left to decline. Anybody who keeps autosave off should stop assuming a dismissed panel left the file alone; it did not.

- The titlebar's Open Recent list opens below the button rather than across the titlebar. It was positioned at the button's bottom-left corner in coordinates that grow the other way, so it came up over the name of the file it was offering to replace.

- The titlebar's New Note, Open and Open Recent buttons name themselves when you rest on them, in the same tooltip the rest of that band uses. Each had a label and none of them ever appeared, because macOS delivers a tooltip through a tracking region it installs when the label is set and these buttons were clearing every region they had on each layout pass. They also use the editor's own tooltip now rather than the system one: they sit in the same strip as Checks, Find, Settings and the table of contents, which have always named themselves with a dark chip that appears as soon as you point at them, so a macOS tooltip there was one row of controls labelling itself two ways, in two shapes, on two delays.

- Open Recent lists the notes you have had open, and not only the files you opened through Open. A note made with New Note, the note the app launches on, and the scratchpad it returns to all reach the panel without a file chooser, and none of them was being recorded, so the menu could say No Recent Files to somebody who had just switched away from a note. Every file the panel leaves and every file it moves to now joins the list, whichever gesture put it there. The file you are in is on the list too, with a checkmark beside it.

- Every button in the titlebar names itself when you rest on it. Checks and Settings open their menus on a click here rather than on hover, which is what a Mac does, so resting on one promised nothing and said nothing either, and the only way to find out what a glyph did was to press it and see. Both now show their name, and the name goes away when the menu opens. Birta Writer for VS Code is unchanged: its menus open on hover, so a label would appear where the menu is about to and be covered by it.

- `/ai` and its Test button find the agent tool you actually have installed. An app opened from the Finder or the Dock is given four system directories to look in and nothing else, and none of the CLIs the AI Agent pane offers installs into any of them, so Test reported Claude Code, Codex and the rest as not working on machines where they run fine from a terminal, and `/ai` failed the same way. Birta Writer for Mac now asks your login shell where your tools are, once at launch, and runs the command with the same `PATH` Terminal would have given it. The AI Agent pane always promised a tool installed and runnable from Terminal would work; this is that promise being kept.

- Choosing Codex CLI from the AI Agent pull-down writes a command that runs. It wrote `codex exec --full-auto {prompt}`, and current Codex has no `--full-auto`, so both `/ai` and Test got a usage error rather than an answer. It writes `codex exec --sandbox workspace-write --skip-git-repo-check {prompt}` now: the sandbox is what lets the agent edit the note, and the second flag is needed because `codex exec` otherwise refuses to run in a folder that is not a git repository, which a notes folder is not. A command you have already got is left alone; choose Codex CLI again to take the new one.

- The AI Agent pane follows the command as you type it. Typing `claude` over another tool's command left the pull-down naming the old tool and the link under the field pointing at the old tool's documentation until focus left the field. Both now move on each keystroke, and a command naming no tool this build knows leaves no name and no link rather than the last one.

- Choosing a tool from the AI Agent pull-down no longer reloads the note you were reading. The editor was torn down and rebuilt on every use of that menu, which was visible as the page blinking out and coming back. It is reloaded now only when `/ai` becomes available or stops being available, which is what the editor is actually told at boot. Emptying the command field now reloads for the same reason, and used to reload for none: `/ai` stayed on the slash menu with nothing left to run.

- The Test button's result reads as a sheet rather than an empty box beside the text. What the tool printed was drawn in a panel with no size, so macOS placed it over the sentence above it and showed nothing inside it, which on a failure hid the tool's own error, the only part of that sheet worth reading.

### Changed

- Breaking: an already-installed copy cannot update itself to this release, and none of its settings carry over. The last traces of the app's former internal name are gone from what ships: the release asset is `BirtaWriter-<version>.zip` (the updater in older copies looks for the old asset name, finds nothing, and stops with the working copy in place), the app's settings live under `com.birtalabs.birta-writer` (so the summon hotkey, the note location, the agent command and every other setting start from their defaults), and the process is `BirtaWriter` in Activity Monitor. Install this release by hand and set your settings again; your notes are files and are untouched.

- A new dated note is called `Note <date>.md` rather than `Jot <date>.md`. Existing notes keep their names; only notes made after this release use the new stem, and the What a new note is called template in Settings still decides the rest of the name.

- The app icon and the first-run artwork are the Birta Writer lockup, the same mark the extension carries, replacing the artwork that still spelled the former name.

- The menu bar reads View before Format. View is about the window rather than about the document, so it sits above the menu that writes in the file, which is where Mail puts its own.

- The View menu's proofreading rows are behind one Proofreading row rather than loose in the menu, with the master switch at the top of it and Highlight Note Markers below a rule. Every row carries a checkmark, so a switch's position can be read without flipping it. Turning the master off takes away the rows it governs rather than leaving them ticked and doing nothing, and turning it back on brings back exactly what was on before; Check Style does the same for Style Options.

- Table of Contents says Show Table of Contents or Hide Table of Contents, for what picking it will do.

- Settings rows are regrouped by subject rather than piled into one card. Show in Dock and Show in menu bar share a card, since each one's availability depends on the other, and Start at login and Rich link previews and embeds each have their own.

- Automatically update moved from General to Advanced, which now holds what the app does to itself. Reset all settings leads the card below it.

- The spelling and grammar checker hands the run loop back on a budget of text rather than of paragraphs. It used to yield every twenty blocks, which is a very different amount of work for a note of one-line bullets than for one of long unwrapped paragraphs, and the second is where the caret stuttered while a note was being checked.

- The card that says a file is gone reads This file can't be found, and leaves naming the file to the window's own title bar a few inches above it. A file name is arbitrary length and it was in the largest type on the window, so a long one set the width of the whole card and a very long one truncated in the middle of the only sentence saying what had happened.

- Show in Dock sits above Show in menu bar under Settings > General, which is the order the two are usually thought about in.

- Open and Open Recent reuse the window you are in when the file it was on has gone, instead of leaving a dead window behind and opening a second one. Only the window in front is ever reused, so with several windows open there is nothing to guess about, and only when its buffer is empty: a window whose note was deleted while unwritten text was still on screen keeps that text, and the file you opened gets a window of its own.

- With the file gone, the titlebar keeps the Settings gear and puts the rest of its controls away. Find has nothing to search, the checks nothing to flag and the outline no headings, and the gear is the way to preferences on a panel summoned with no Dock icon in front of it. It stays on screen rather than fading when you look away, which the rest of that row still does.

- Fold, Unfold, Fold All and Unfold All are behind a Folding submenu in the View menu, beside Font. On the menu they took four lines, two of them without a chord, and they sat in the group macOS lines up against Enter Full Screen's icon, so they were drawn indented against blank space.

- A file that has gone missing is said properly, on the panel, instead of in a strip along the bottom edge. When the note you are editing is deleted or moved out from under the app, it now says so on a card in the middle of the window and offers the ways out: save what is on screen back to that file, start a new note, or open a recent one. The strip it replaces said the same thing in the smallest type in the window, furthest from where you were looking, beside two buttons that both read as ways of making a file. What is offered depends on what is at stake: with unsaved writing on screen, saving it back comes first and the button that throws it away says so; with an empty note neither is offered, because there is nothing to save and nothing to lose. The card covers itself and nothing more, so the writing that is at risk stays readable and can be selected and copied somewhere safe without answering the card first, and it keeps clear of the titlebar's tooltips and of the status line's corner wherever there is room for it to. In a window too small for that, it gives up both rather than any part of itself, because every button on it is a way out of the state.

- New Note is a plus in a square rather than a pencil over one. The three file buttons sit in a row and are read together, and the compose mark puts its pencil through the top-right corner, so the square gives way and the whole glyph reads low beside a folder and a clock that are drawn around their own centres. What changed is where the ink sits; the button, its place and its shortcut are the same.

- The titlebar's two halves are drawn as one strip of controls. New Note, Open and Open Recent sit beside the file's name at one end of the band and Checks, Find, Settings and the table of contents sit at the other, and they were a different size, a different shape and a different distance apart, sitting a point lower than the three beside the name. One set is drawn by macOS and the other is the same HTML Birta Writer for VS Code draws, and each had been laid out to its own numbers. The file buttons now take the box, the spacing and the hover treatment the toolbar's own buttons use, and the toolbar's first row takes the titlebar's height so that both sets sit where macOS puts a window's title. The three are also drawn at full strength rather than dimmed, and resting on one shades it the way resting on Find or Settings does, instead of brightening the glyph and nothing else. They are wider than they were, so a long file name has a little less room before it is shortened.

- The update offer says how long its buttons are held and why. Both buttons are dead for the first few seconds so that a keystroke already on its way to your note cannot answer an offer that arrived mid-sentence, and until now nothing said so: a dialog whose buttons do nothing reads as a dialog that is broken. The confirming button counts the seconds down in parentheses, and the offer says what the wait is for.

- The table of contents docks on the right and no longer offers to move, and the toolbar button is the only control that shows and hides it. Resting on that button flies the outline out over the text without opening it; pressing opens it for good, and pressing again puts it away. The panel used to carry a hide button and a swap-sides button of its own, and a reveal tab on the window's edge when it was shut, so there were three controls for two questions and one of them sat a few pixels from the button that already did the same thing. A Mac puts a sidebar on the trailing edge, so the side is the app's answer rather than a question, and Swap Table of Contents Side is gone from the command list with it. Birta Writer for VS Code is unchanged: it keeps both controls and the reader keeps the side.

- The titlebar's buttons go away when you are neither pointing at the window nor typing in it, and are there the whole time you are. Checks, Find, Settings and the table of contents used to sit in the titlebar at every moment, including on a window in the background you were not using; New Note, Open and Open Recent had the opposite problem and appeared only while the pointer was on the band, which is a hard place to discover a button and an impossible place to read its tooltip. Both halves of the band now follow one rule, so a window you are working in shows its controls and a window at rest is a page and a cursor. Nothing moves when they come and go: the room they take is held either way, so the file's name never changes width. The three file buttons are also drawn at the size the toolbar's own icons are, which they were not.

### Removed

- Enter Full Screen, from the View menu. macOS adds it to any menu called View and it was permanently dimmed: this app's windows accompany another window's full screen rather than taking one of their own, so the row could never do anything. It is not moved to the Window menu, for the same reason it is gone from this one.

---

## [2026.826.0] - 2026, August 26

### Added

- Birta Writer for Mac notices when the folder it keeps your notes in has moved because the app was renamed, and offers at the next launch to bring the notes and their images across. That folder's name is derived from the product's, so a rename moved it with you changing nothing, and your writing stayed in a folder under the old name with nothing on screen to say so: the app opened a fresh, empty home and looked as though it were working. Both folders are named in the question, declining moves nothing, and anything that could not be copied is listed. A rename changes the note's name as well as the folder's, so your scratchpad arrives under the name this version opens and the panel has your writing in it rather than an empty note beside it; where some other note already answers to that name, it keeps it and yours comes across under its own. It compares against the folder the previous launch used, so it covers a rename from this version onward rather than one that has already happened.

- Birta Writer for Mac has the table of contents. It is the same sidebar Birta Writer for VS Code draws: the document's outline, with the Links and Notes tabs appearing beside it when the note has either, the same drag within the outline to move a section and renumber what it contains, and the same drag on its edge to resize. It opens from a button at the far right of the toolbar, past the gear. View, Table of Contents opens it too. It starts put away and stays however you leave it, across opening another file and across a restart, as do the side you dock it to and the width you drag it to. On a window this size it comes out over the text rather than pushing it aside, and it goes back with a second press.

- Open Recent, as a clock button in the titlebar beside Open and as a submenu of the File menu. It holds the last ten files you opened, with the twenty before those behind More, and Clear Menu empties it. A file you have since moved or deleted is left out rather than offered and then refused, and two files with the same name are told apart by the folder each is in. Every way of opening a file counts: the Finder's Open With, a drop on the Dock icon, and Open itself.

- Spelling and grammar, from the checker macOS already has. Birta Writer for Mac answers the editor's spelling and grammar requests with `NSSpellChecker`, so Check Spelling and Check Grammar are on the Checks menu here for the first time, with the same dotted underlines, the same popup and the same suggestions Birta Writer for VS Code draws. Add to Dictionary teaches the word to the Mac itself rather than to a list this app keeps, so a word you add is known to Mail, Notes and everything else, and words you have already taught your Mac are known here from the start. The findings are worded by macOS and so will not match the ones VS Code shows, which uses a checker of its own; what is the same is which spans it stays quiet about, because file paths, URLs and identifiers such as `getEditorView` are filtered by the same rule on both.

- Your Checks choices are remembered, and so is Keep This Phrase. Turning off a category, turning off the whole pass, or telling the style check that a phrase is yours all used to last until the next time the panel loaded a file, which for this app is often. They now survive that and a restart.

- The Checks menu is on the toolbar, to the left of Find, and View carries Check Style and Highlight Note Markers for the keyboard. The style check now draws its dotted underlines on this app exactly as it does in VS Code, and until now it drew none: the whole menu was withheld because two of its rows, Check Spelling and Check Grammar, need a checker this app does not have, and the app switched the whole pass off at launch for the same reason, so a check it could run perfectly well never ran. Those two are still absent. Check Style, each of its categories, the note-marker highlight and the master Proofreading switch are all in the toolbar's menu.

### Changed

- Store in iCloud Drive is now a choice between the folder Birta Writer for Mac picks inside iCloud Drive and a folder you name, and the folder you name is remembered. Switching iCloud on used to throw that choice away, so trying iCloud and changing your mind meant finding the folder again. Off, the Location row starts on the note in `~/Documents/Birta Writer` and you can point it anywhere, including somewhere inside iCloud Drive, which syncs like any other folder there; the row says so under it. Changing the location still offers to bring your notes and their images across before anything moves.

- The Format menu carries the inserts itself. Link, Link to Section, Table, Image, Callout, Math, Footnote, Horizontal Rule and the dates were behind an Insert submenu and are now four groups on Format, in the order they were in. The dates are one row of that four, opening a submenu named Date: Today, Tomorrow and Yesterday, with Choose Date under them for any other day. Four rows that answer one question is what Paragraph Style and Lists are, which is why those stay submenus too. Format is the longest menu the app has and this lengthens it, on the argument that putting something into a document is a different act from restyling what is already there.

### Fixed

- The keyboard shortcut field in Settings is drawn in the appearance the window is in. Opening Settings could leave it a black box in an otherwise light window, and it stayed that way for as long as the app was running, because the field took its background once when it was built rather than from the window it ended up in.

- Naming a folder for your notes on a Mac with iCloud Drive switched off in System Settings now takes effect. The setting went on saying iCloud, so switching iCloud Drive on later moved the notes back to the folder the app derives, with nothing asked.

- Renaming your note in the title popover, or moving it in the Finder, keeps working when the notes folder is the one Birta Writer for Mac derives. The app followed the file and wrote the new path somewhere that was no longer read, so the next launch went back to deriving the old one and opened an empty note beside your renamed file. A name you chose is a location you chose, so this switches Store in iCloud Drive off and fills the Location row in with where the file now is. Nothing moves and nothing stops syncing: a file that was in iCloud Drive is still in iCloud Drive, and the setting now describes it rather than a file that is no longer there.

- When notes move, an image that could not be copied is no longer reported as a note. A move that left one image behind said two notes could not be copied when it meant one note and one image.

---

## [2026.825.0] - 2026, August 25

### Added

- File, Open (⌘O) in Birta Writer for Mac, and two buttons in the window's titlebar for the same pair of gestures. The chooser offers the three formats the editor reads (`.md`, `.markdown`, `.mdx`) and starts in the folder of the file on screen; opening one binds the panel to it exactly as the Finder's Open With does, and File, Back to My Notes returns to your own note. The note you were on is written first either way. The buttons appear after the file's name when the pointer is on the titlebar, one for a new note and one for the chooser, and each names its keyboard shortcut. They are not offered while the first-run screen is up, where both actions are refused anyway. The name has a little less room before it truncates in a narrow window, because the buttons hold their place whether or not they are drawn.

- Birta Writer for Mac is in the Finder's Open With for Markdown files: `.md`, `.markdown` and `.mdx`. Choosing it binds the panel to that file, and File, Back to My Notes returns to your own note; the note you were on is written first, so nothing you typed into it is lost. It does not become what double-clicking a Markdown file opens and it changes nothing about whichever app does that now. Selecting several files and choosing Open With opens the first one it can read, since the panel holds one file at a time. If that is the first time you have opened the app, it opens on your file rather than on the short tour, and the tour waits for a launch that is back on your own notes.

- `/help` works in Birta Writer for Mac, and draws as a sheet on the window that asked. The feedback flow was reachable only from the VS Code command palette, which this app does not have, so there was no way to report anything from here at all. The four questions arrive one at a time, Escape at any of them leaves the note untouched, and the destinations are the same three: a prefilled GitHub issue, a prefilled mail draft, or the clipboard. What it reports about your setup is this app and macOS rather than an extension and a VS Code that was never running, and the settings it names are this app's own. It is never given the note, its filename, or the folder it is in.

### Fixed

- Birta Writer for Mac can be quit while the first-run screen is up. With Automatically save changes off, and only when the buffer had got ahead of the file behind that screen, a quit there put the Save, Discard Changes, Cancel question on a panel that was showing the first-run screen, and nothing behind that screen could ever answer it: the app writes nothing while it is up, so the buffer and the file could not be brought back into step, and the quit was left waiting on an answer that never came. An AppleScript quit never returned, a second one came back "User canceled", and a `kill` was ignored, which leaves Force Quit, and Force Quit is the one route that discards the buffer. The question is not asked there now, and the quit goes through.

- Birta Writer for Mac takes down a question left on screen when a quit arrives that cannot be refused. With Automatically save changes off, an unsaved note and that question waiting on the panel, a signal from an installer replacing the app, or from a logout, did nothing at all: the app was already quitting, so the signal had nothing to add and the question stayed up. Such a quit now answers it the way it would have answered it in the first place, by writing the buffer, and the app goes.

---

## [2026.824.0] - 2026, August 24

### Added

- A first launch opens on a short tour instead of an empty panel. It is a checklist that walks through ticking a box, the slash menu, a calculation that answers itself, a table, a diagram, some math, and the card a link on its own line becomes once you turn the network on. It is an ordinary note rather than a screen, so every gesture in it is the real one, nothing has to be dismissed, and selecting all and deleting is final.

- Birta Writer for Mac has a Format menu, and everything the panel's formatting row can do is in it bar one gesture: bold, italic, strikethrough, inline code, highlight and clear formatting, then Paragraph Style for the body, the six heading levels, blockquote and code block, Lists for the three list kinds with Toggle Task Done and Uncheck All Tasks, Indent and Outdent, and an Insert submenu holding links, tables, images, callouts, math, footnotes, rules and dates. The exception is turning a block you already have into a callout of a particular kind, which stays on the quote button's own picker because the kind is part of the gesture and a menu row carries a command and nothing else; Insert, Callout puts a fresh one in. Nearly all of it was already in the panel and none of it was on the keyboard: the app bound seven keys in total, so the heading, list and indent chords the extension ships did nothing here. They work now, and they are the same chords, which is checked by a test rather than by memory.

- A View menu: Zoom In, Zoom Out and Actual Size for the content font size, a Font submenu for sans-serif, serif and monospaced, Fold and Unfold with Fold All and Unfold All, and Focus Mode.

- A Help menu, holding Keyboard Shortcuts, which opens the same cheatsheet the panel has, and the three destinations the About window names. macOS puts its own search field at the top of a Help menu, and that field searches menu items, which is how you find a row now that most of them live in a submenu.

- The keyboard cheatsheet lists every key the app binds, under the menu each one lives in. It listed them as one flat run, which was fine for the seven keys the app used to bind and is not for a whole menu bar.

- A toolbar button's tooltip prints the key that runs it. The link button says ⌘K, and so do bold, italic, strikethrough, inline code and find, which are the toolbar buttons the app binds a key for. The slash menu and the block menu still print none. Birta Writer for VS Code prints a key too, including one you rebound yourself, which it works out by reading your own keybindings rather than assuming its defaults; where it cannot establish which file is in force it prints the plain label instead.

### Changed

- Breaking: the app is called Birta Writer now, everywhere it names itself. The menu bar, the settings window, the update offer and the copy in `/Applications` all drop "Jot", which is kept back as a name for a future quick-entry surface rather than retired. Nothing about the editor changed.
- Breaking: the default note moved with the name. It is `~/Documents/Birta Writer/Birta Writer.md` on this Mac, and the iCloud Drive folder is `Birta Writer` rather than `Birta Writer Jot`. An existing note is neither carried across nor deleted: it stays exactly where it was, under its old name, and opening or moving it is a manual job. Notes you make yourself are unaffected, and a new dated note is still called `Jot <date>.md`, because that word is a stem in front of a date rather than the app signing its work.
- Breaking: an already-installed `Birta Writer Jot.app` cannot update itself to this release. It looks inside the download for a bundle under its own old name and does not find one, so it stops rather than installing anything. Replace it by hand, and delete the old copy once you have: left alone it goes on claiming the summon hotkey, which is first come first served, and autosaving the note it was already bound to.
- The Window menu carries Minimize, Zoom and Bring All to Front. It had Minimize alone, and macOS adds Fill, Center, Move & Resize and Full Screen Tile to any app's Window menu, so those arrived with nothing above or below them and read as being in a strange order. Those rows are still the system's, with the system's own keys: what changed is the rows around them.

---

## [2026.822.0] - 2026, August 22

### Added

- Birta Writer Jot will not install a version this Mac cannot run. Before either update path replaces the copy you are using, it asks the download what macOS it needs and which processors it was built for, and stops with both numbers if this Mac is not one of them, leaving the working copy where it is. Jot needs macOS 14 or later, and the app attached to a release is built for Apple Silicon, so an Intel Mac has to build it from the source. Nothing here changed which Macs Jot runs on; what changed is that being told is no longer the same as losing the app, since macOS reports an app it cannot open only after the old one is gone.

- Birta Writer Jot has an About window: its mark, its name, the version you are running, and links to the Birta Labs website, the project's source, and the page for reporting something wrong with it. It opens from the menu-bar icon's menu, on a Control-click or a right-click, and from the app menu when Jot is showing a Dock icon. A copy that did not come from a release says Development build instead of a version number, so what you quote in a bug report is either a release or plainly not one.

---

## [2026.821.1] - 2026, August 21

### Added

- Changing where Birta Writer Jot keeps your notes now offers to bring them with you. Turning on Store in iCloud Drive, or choosing a folder, used to point Jot at the new place and move nothing: the notes stayed safe exactly where they were and left the panel without a word, which is indistinguishable from losing them. Jot now asks, naming how many notes are involved and the folder they are in, and Leave Them is a real answer that has already told you where to find them. It asks only when there is something to carry, so a folder with no notes in it changes silently as before, and renaming a note without changing its folder is not a move and is never asked about.

  Images travel with the notes that use them, which is the part that would otherwise break quietly: a note whose picture stayed behind still opens perfectly and shows nothing. Nothing is ever overwritten. A note whose name is already taken at the destination is numbered, and an image whose name is taken by a different file is left where it is and reported, because renaming that one would break every note pointing at it. Files that are not notes are not touched at all: the folder is one Jot shares rather than owns. Everything is copied and checked before the original is removed, so an interrupted move into iCloud Drive leaves you with a copy rather than a gap, and anything that could not be copied stays where it was and is named.

### Fixed

- Attaching a file to an `/ai-advanced` request in Birta Writer Jot works, and stops locking the composer when it did not. Jot never wrote the bytes anywhere and never answered to say so, and the composer holds Send disabled, reading Waiting for attachments, until every attachment reports back. So a single dropped or pasted file left the panel unable to send anything at all, the prompt you had already typed included, with no way out but removing the chip. Jot now writes the file to a per-session temporary folder and hands the agent its path, the way the extension does. A file too large, or one that cannot be written, marks that chip failed and gives you Send back rather than waiting forever.

- Insert Image in Birta Writer Jot opens on a tab it can fill. It opened on Browse Project, which read Loading for ten seconds and then showed an empty grid, because there is no project behind Jot to list images from and nothing ever answered. That tab is gone on Jot and the panel opens on URL; dragging a file in and pasting one both worked before and are unchanged. In VS Code, where there is a workspace to browse, nothing about the panel changes.

---

## [2026.821.0] - 2026, August 21

### Added

- A Test button beside Birta Writer Jot's agent command, in Settings, AI Agent. It runs the command once with a trivial request and shows you what came back: the tool's name and its answer if it worked, and its own error output if it did not. Everything else on that pane is a claim about a shell line nobody has run, so a command that is not installed, not authenticated, or simply mistyped looked exactly like one that works. The test runs in a folder of its own, which is removed afterwards, so a tool that decides to write a file while saying hello does not write it next to your notes.

- The tool your agent command names now links to its own documentation, on a line under the field. It follows the command rather than the last menu entry anybody picked, so editing the flags does not change where it points, and a command Jot does not recognise shows no link rather than one to somebody else's tool.

- Birta Writer Jot's status messages carry a small ring beside them that empties over the seconds the message has left. Nothing down there can be clicked or dismissed, so how long you have to read it was the one thing the corner could not tell you.

- Birta Writer Jot names a new note from a template you can change. Settings, General, File name, which starts as `Jot %Y-%m-%d.md` and gives you `Jot 2026-08-20.md`. The tokens are the standard `strftime` ones, the same spelling `date` uses in a terminal, so `%Y` `%m` `%d` `%H` `%M` `%S` all mean what they mean everywhere else and a link under the field goes to the full list. A line under it shows what today's note would be called, so a format you are halfway through typing is visible rather than a surprise the next time you make a note. It appears only when a summon opens a new note, since otherwise there is no name to choose. A template that cannot produce a usable name falls back to the default rather than failing, so nothing you type here can stop a new note being made.

- The close button in Birta Writer Jot's titlebar carries the dot macOS draws for a document with unwritten changes, next to the word Edited that was already there. Both come from the same answer, so they cannot disagree. Like the word, the dot appears only with Automatically save changes off: with Jot writing as you type there are no unwritten changes to warn about.

- Birta Writer Jot keeps itself up to date. About once a day, and at launch, it asks this project's release page whether there is a newer version, and says so if there is; downloading and installing are a click, and it restarts into the new one with your note written first. On by default, in Settings, General, with a Check Now beside it, and it is one of the questions the first run asks. The offer waits for a moment you are actually there: it appears as a sheet on the panel rather than over whatever else you are doing, it holds until the next time you summon Jot if the panel is hidden, and its buttons stay dead for a few seconds so a keystroke already on its way to the editor cannot answer it. Saying no to a version is remembered, so you are asked once per release rather than every day, and Check Now asks again whatever you said before. It does not ride the "Rich link previews and embeds" switch, because that one is about what happens to what you type and this one is about the app replacing itself: someone who wants no link previews should still get fixes. Nothing about you or your notes is sent, and the download is checked against the published checksum before anything is written; a release that published none is refused rather than installed unverified.

- A development build of Birta Writer Jot now installs beside the release instead of over it, under its own name with [DEV] on the end, so a change can be looked at without taking away the copy your notes are in. The two share nothing that would make them collide: separate settings, separate note, and a separate summon hotkey, which is Shift plus the usual one. The development build never updates itself, since replacing it would remove the thing it was installed to show. `pnpm run install:local` builds and installs that one.

- Birta Writer Jot asks a few questions the first time it runs, on the panel itself rather than in a window beside it: the summon hotkey, whether notes go in iCloud Drive, and whether it appears in the Dock, starts at login and keeps itself up to date. Those are the ones you cannot answer later without going looking; everything else has a default worth keeping and a row in Settings. The editor is not there yet, which is the point: there is nothing to type into until the questions that decide where your bytes go are answered, and nothing to dismiss twice. All Settings and Start Writing are under the rows. Every row is a live setting, written the moment you move it, so there is no Cancel. The window grows to fit the questions. There is no way back to the screen once it is answered, and it needs none: every question on it is a row in Settings, General, worded the same.

- Birta Writer Jot's agent command has a menu of the terminal agents people actually run: Claude Code, Codex CLI, Cursor CLI, Gemini CLI, GitHub Copilot CLI, OpenCode, Aider, Amp, Goose, Pi and Hermes. The menu names whichever of them your command is running, so you can see which tool it is without reading the flags, and it says Select AI when the command is something else of your own. Choosing an entry fills the command field below and is then done with: that field is where the setting lives, and it is yours to edit, including the flags, which do not change what the menu says. Settings, AI Agent.

- Reset all settings, in Birta Writer Jot's Advanced settings, as Reset to defaults. Everything goes back to its defaults, the hotkey included, after a confirmation. Your notes are not touched: the files stay exactly where they are, and Jot reopens the default one, so a note you had pointed it at is one Choose away rather than gone. The first-run screen does not come back, because a reset is not a reason to be asked again, and every question it asks is a row in General.

### Changed

- An `/ai` request that fails in Birta Writer Jot says why in the corner of the panel, naming the tool and the reason, and goes on its own after a few seconds; a click takes it away sooner. It used to leave a small red marker in the margin beside the block you asked from, with the reason only on hover and a click needed to clear it. There is nothing left to stop by then, the reason is a sentence that does not fit in a margin, and a marker that has to be dismissed is a chore left behind by something that already went wrong. The marker still shows while a request is running, where its click stops the run. In VS Code nothing appears in the corner, because the extension raises a real notification there and one event reported twice is worse than either.

- A setting Birta Writer Jot cannot honour now says so in one voice, on both Settings and the first-run screen. The row's name is drawn dimmed as well as its switch, so it reads as unavailable rather than as something you switched off, and the sentence under it is red, because it is reporting a problem rather than describing a setting. This is what you see for Automatically update in a development build, and for Start at login on a copy macOS will not register.

- Autosave is now Automatically save changes, and the paragraph under it is gone. What off means is what off means in every other Mac application: nothing is written until you ask, hiding the panel leaves your changes in it, and quitting asks. The behaviour is unchanged.

- What a new note would be called is drawn directly under the File name field and aligned with it, as the name itself rather than as a sentence with "Today" in front. The `strftime` shortlist and its link have moved below, into the column reference text belongs in, and the link now goes to a page that shows each token beside what it produces.

- Birta Writer Jot's first-run screen no longer writes the app's name under its own logo. The mark says it, in the app's own lettering; the heading said it again in the system font.

- The paragraphs on Settings, AI Agent say that enabling it is optional and speak of the one `/ai` command rather than several, and the line under the command field says plainly what it is: the terminal command `/ai` runs in Jot.

- Birta Writer Jot's find bar has room to work in and says what its controls do. The field is wider, Replace sits in a field of its own rather than in a box with no edges, and the two replace actions are a labelled pair, Replace and Replace All, instead of two icons of a page with arrows on it. The replace row is opened by a button that says Show Replace, in the bar's own row, replacing a chevron beside it that moved down half a row as the row it opened appeared and left its tooltip sitting over what it had just revealed. The search options are a menu now, with a row and an icon each.

- With Automatically save changes off, Birta Writer Jot behaves the way a Mac application behaves: it writes nothing you did not ask it to. Hiding the panel no longer writes, so a note you are not ready to keep stays in the panel with Edited in the titlebar until you press Command-S. Quitting asks, as a sheet on the panel, with Save, Discard Changes and Cancel; Cancel leaves Jot running. A quit nobody asked for, which is an installer replacing a running copy or Jot restarting into a new version, writes rather than asking, since there is no one there to answer and something is waiting on it to go. With the setting on, which is the default, nothing about any of this changes.

- The Editor pane in Birta Writer Jot's Settings is now AI Agent, holding the one subject it had left: the command `/ai` runs. Which note a summon opens and what a new one is called have moved to General, beside where your notes are kept, since both are about which file your typing ends up in. Three paragraphs above the switch say what an agent run needs, what it uses to authenticate, and who might charge you for it.

- The T that opens Birta Writer Jot's formatting row is drawn the same whether the row is open or not. It used to take a filled square when open, which was a second answer to a question the row below the bar had already answered, in the one place on that bar where a filled square sits in the window's titlebar band.

- Reset all settings in Birta Writer Jot says what it will and will not touch: it reverts Birta Writer Jot to default settings, and will not move, delete, or modify any of your files.

- Rich link previews and embeds, in Settings, General, says what it renders rather than only what it costs: some YouTube, Loom, Figma, Google Docs and other services' links become interactive embedded content, and it requires internet access. The switch and its name are unchanged.

- Settings, Advanced no longer offers to show the first-run screen again in a release build. Every question that screen asks is a row in General, worded the same, so the button was a slower way to reach settings you can already see.

- What a summon opens is now called New windows open with, in Settings, General, and its two answers are Last open file and New file. It is the same setting, named for what you get rather than for the policy behind it; it was Opens in Advanced, and before that Start with a blank note.

- `/ai` has a switch of its own, Enable /ai commands, in Settings, AI Agent, and it starts off. It runs a command on your Mac, and a capability that runs commands is one to turn on deliberately rather than one to find already running. This applies to an install you already have, not only to a new one: if you were using `/ai` before this version, it is off now and the switch is where you turn it back on. The command it would run is remembered either way, so turning it on does not ask you that question again. With it off, `/ai` is not offered anywhere, in the slash menu or the command palette.

- Birta Writer Jot's Settings is three panes, split by what the rows are about. General is Jot as an application on this Mac: how you summon it, where it puts your notes, which note a summon opens and what a new one is called, whether it writes as you type, appears in the Dock, starts at login and keeps itself current. AI Agent is the command `/ai` hands a prompt to, and says what that means before the first switch. Advanced holds the gestures that undo rather than set. Every question the first-run screen asks is in General, in the same order and worded the same, so a setting you answered on first run is found again by looking where you answered it. The headings over the groups are gone, since a card of switches is bounded by its own shape and a title over it named what the rows already said, and the window no longer slides between sizes when you change panes.

- Where Birta Writer Jot keeps your notes is one switch, Store in iCloud Drive, with a Location row that appears only when it is off. It used to be an iCloud toggle with a path row under it that silently outranked it: choosing a folder made the switch above decide nothing, and nothing said so. With iCloud Drive on there is one place the note can be and the row is gone; with it off the folder is a real choice and Choose is right there.

### Fixed

- Clicking the marker beside a running `/ai` request in Birta Writer Jot now stops it. The marker has always offered to cancel and the panel has always been able to, but the two were never connected: the page asked under one name and Jot listened for another, so the click did nothing and the agent carried on to the end. Stopping it also stops it from writing, which is the half that matters if you asked for the wrong thing.

- A finished `/ai` run in Birta Writer Jot no longer puts the agent's console output in your note. Everything the agent printed on its way to the answer was handed to the panel as if it were the file, and the panel took it as the note's new text, so a run that did exactly what you asked replaced what it had just written with a transcript of itself. Jot then wrote that back, within a beat with Automatically save changes on and at the latest when the panel hid or you quit, so the file went the same way. Jot now reads the file the agent edited, which is what it always meant to hand over.

- When an `/ai` run's changes overlap what you typed while it worked, Birta Writer Jot keeps the agent's own version in a file beside your note and says which one it is. The overlapping changes are left out of the note, as they are in the editor, but Jot writes as you type, so the version holding them would have been overwritten within about half a second of your next keystroke. A run whose changes all landed leaves no extra file.

- An edit you type into Birta Writer Jot while an `/ai` run is working is no longer discarded when the run finishes. Jot used to read the file back over the panel, so whatever you typed during the run was the losing side. It now folds the agent's changes around your edit, the way the extension does, and the run's marker says so when one of the agent's changes overlapped one of yours and was left out; the file on disk holds all of them in that case. A run you did not type during is unchanged: the file simply arrives in the panel.

- An `/ai` request in Birta Writer Jot no longer drops the model or effort it was given when your agent command names a longer flag starting with the same letters. A command carrying `--model-fallback` read as already carrying `--model`, so the request's model was silently left off. It affects only a command spelled that way; the menu's own presets are not.

- Birta Writer Jot notices when the note it is editing is deleted, and stops writing instead of putting it back. It wrote through a path that creates the file and every folder above it, so deleting the note in Finder and typing one more character recreated it a second later, and nothing said so. A bar along the bottom of the panel now says the note is gone and that nothing has been written since, with Save It Back, which writes what is in the panel to where it came from, and Discard and Start New. Nothing reaches disk until you pick one, no reload or settings change can quietly replace what is in the panel while you decide, and quitting with the bar up leaves the unwritten text in a file named after the note beside where it used to be.

- Renaming or moving Birta Writer Jot's note in Finder no longer leaves it editing a file that is not there. Jot follows the file and the titlebar follows with it, and the rename is written back to the setting the old path came from, so a note you had pointed Jot at stays pointed at and your scratchpad setting is not quietly repointed at it. Moving it to the Trash counts as deleting it, which is what Finder actually does, so that case gets the bar above rather than a panel bound to a file in the Trash.

- Birta Writer Jot's panel really does sit at the ordinary window level, so another application's window can cover it. The setting that made it float was removed a release ago and the level was not, which left the panel pinned above everything with nothing in Settings to say so or turn it off. It also stays put when you click into another app, which is the same default arriving from the same direction.

- The file name in Birta Writer Jot's titlebar is drawn whole, and ends in an ellipsis when the window is genuinely too narrow for it. It used to stop mid-letter in both cases, and `Birta Writer Jot.md` was losing the `d`. `Edited` is never what gets dropped to make room, because the state of the file is the half you are looking for.

- `/date` opens the macOS date picker at the caret in Birta Writer Jot, instead of mirrored to the opposite end of the panel: a caret near the top opened the picker near the bottom.

### Removed

- The switch in Birta Writer Jot's Advanced settings that pointed Jot at a document instead of your notes, and the path row beside it. A document you open is not a setting; the titlebar already names the file Jot is on, and Back to My Notes on the File menu is the way back off one.

- Birta Writer Jot's "hide when Jot is not in front" switch, which shipped one release ago as the answer to a panel that floated. The panel no longer floats, so there is nothing to answer: a window you can cover is a window you can leave on screen. Settings, General.

---

## [2026.820.0] - 2026, August 20

### Added

- Birta Writer Jot can keep its note in iCloud Drive, so it is the same note on every Mac you have. On by default, and off automatically when iCloud Drive is switched off in System Settings, where the row says so and the note stays on this Mac. Settings, Advanced. Switching it does not copy the note between the two places; the path under the row tells you where you landed.

- Without a Dock icon, Birta Writer Jot can hide itself whenever it is not the app in front, which makes it a true overlay: summon it, type, click back into your work, and it is gone with nothing to dismiss. Off by default. Settings, General, under Show in Dock; with a Dock icon it does not apply and the row says why.

- `/date` opens the macOS date picker in Birta Writer Jot, at the caret, instead of the calendar the editor draws for itself. It is the system calendar, with an Insert button under it. Choosing a day and confirming it are two steps on purpose: the control reports every change as you move through it, so committing on the first of them would write a date the moment you tried to move off today. The day it returns is written by the editor, in the same words and the same order the extension would use, so a date is spelled one way whichever surface you typed it on. Dismissing it without choosing writes nothing and leaves your cursor where it was. `/today`, `/tomorrow` and `/yesterday` open nothing here either, exactly as in the extension.

- The file name in Birta Writer Jot's titlebar shows a chevron when you point at it, the way a document window does on macOS, so the name reads as something you can open rather than as a label. Clicking it still opens the same Name, Tags and Where popover; the chevron only says that it will. It stays while the popover is open, and the space it occupies is reserved whether or not it is drawn, so the title never shifts as the pointer arrives.

- Birta Writer Jot names the file in its titlebar, beside the traffic lights, the way macOS names a document window, and centred on the window buttons where macOS puts a title. With autosave off it adds `Edited` while there are bytes the file does not have, which is your cue to press Cmd+S; with autosave on it does not, because a file that is always being written has no unwritten state worth a word, and the flag rises and falls several times a sentence.

- Clicking that title opens the document popover macOS opens from a document window's title: the file's Name, its Finder Tags, and Where it lives. Renaming it moves the file and keeps the editor on it, so a scratchpad that has become a real note can be named and filed without leaving the panel; the extension is kept when you edit only the stem, and a name already taken is refused rather than written over. The Where menu lists the folder and everything above it up to the volume, with Other… for one you choose. Cmd-click, Ctrl-click or right-click still opens the path popup, whose rows reveal themselves in Finder.

- Copy Reference for AI Agent works in Birta Writer Jot. It posted a message the app did not handle, so the button had never done anything at any selection level. It now writes the note's full path and the line reference (`/Users/you/Documents/Birta Writer/Birta Writer Jot.md#L12-L20`), and the selected lines quoted in a markdown fence when there is a selection, and says so along the bottom of the panel. The path is absolute where the extension's is relative to your workspace, because Jot's note is not in anybody's project and a relative path would name nothing. The note is written to disk first, whatever autosave says, since the line numbers have to mean something in the file an agent will open.

- Birta Writer Jot's window can be dragged by its titlebar, and double-clicking there does whatever you have set a double click on a title bar to do (System Settings, Desktop & Dock: zoom, minimise, or nothing). The panel draws its own toolbar in the titlebar band, and that had left the whole band unable to move the window: every click there went to the page. Dragging now works anywhere in the band that is not the file name or one of the toolbar's own controls, and it is the system's window drag, so it snaps and moves between Spaces like any other window.

- Birta Writer Jot can appear in the Dock. Off by default, which is what it has always been; on, it also joins Cmd+Tab, and clicking its Dock icon summons the panel. Settings, General.

### Changed

- Birta Jot is now called Birta Writer Jot, everywhere it names itself: the app in Applications, its window and menus, its Settings window, and the menu-bar item. The app icon and the menu-bar mark are redrawn to match. Nothing about your settings moves, so the hotkey, the network switch and the agent command all survive the rename; installing replaces the old `Birta Jot.app` rather than leaving two copies competing for the hotkey.

- Breaking: the note Birta Writer Jot starts with has moved out of Application Support, where you could not find it, and into a folder you can: `iCloud Drive/Birta Writer Jot/Birta Writer Jot.md` when iCloud Drive is on, and `~/Documents/Birta Writer/Birta Writer Jot.md` when it is not. Nothing is migrated, so a note you have already typed into stays at the old path and Jot will not open it: move it yourself, or point Settings at it under Advanced. A scratchpad you had already pointed somewhere is untouched.

- Birta Writer Jot has a new app icon and a new menu-bar mark, both redrawn for the new name. The app icon is the Writer Jot lockup; the menu-bar mark is the Writer letterform in a rounded square, and is still a template image, so it still inverts for a dark menu bar. The Birta Writer extension's icon is unchanged.

- Birta Writer Jot's search looks like a Mac search field: a rounded capsule with the magnifier inside it, the match count at its trailing end, and Done rather than an ✕. Match Case, Match Whole Word, Use Regular Expression and Find in Selection are all still there, now behind the ⋯ button rather than in a row of toggles beside the field. The extension's find bar is unchanged, and still matches VS Code's.

- The arrows at the ends of Birta Writer Jot's formatting row are buttons rather than full-height strips: the same size as the controls they sit over, centred on the row, held off the window edge, and each with a tooltip saying what pressing it does. The gradient under them is wider than the button now, so a control scrolling past fades out instead of being cut in half.

- Birta Writer Jot's panel no longer floats above other applications' windows, and the setting that made it is gone. A window that will not go behind anything is one you fight, and the hotkey already brings the panel back in a keystroke. What that setting was reaching for is the new "hide when Jot is not in front" switch, which takes the panel away instead of pinning it up.

- Birta Writer Jot's editing controls have moved out of the titlebar row onto a second row of the toolbar, directly below it and above the text, on the page's own ground with no rule between the two rows. The row is closed to start with, and the serif T that opens it sits in the toolbar itself next to search; the choice is remembered. Every control that changes the document is there, including the seven that used to ship hidden and needed a settings change to reach: Strikethrough, Highlight, Inline Code, Horizontal Rule, Inline Math, Footnote and Clear Formatting. It starts at the window's left edge, and the text moves down to make room for it rather than being covered. When the window is too narrow for the whole set, the row scrolls sideways and a chevron appears at whichever edge you can still move toward; clicking one scrolls the row. The titlebar row keeps search and the settings gear. This is Jot only; the extension's toolbar is unchanged.

- Birta Writer Jot's menus open when you click them, not when the pointer passes over them, and their buttons no longer carry a chevron. A menu that opens on hover needs the chevron to say that resting there will do something; where the click is what opens it, the click is the whole of the affordance. This is Jot only: the extension's toolbar menus still open on hover, with their chevrons.

- The hairline under Birta Writer Jot's toolbar is drawn only when the formatting row is open, and it sits below that row rather than between the two. One row of chrome over the text does not need a rule to say where it ends, and the line read as the top edge of a panel that was not there. Nothing below the bar moves as the row opens and closes.

- Birta Writer Jot's gear menu no longer offers Customize Toolbar or Hide Toolbar, and the commands do nothing there. The formatting row's contents and order are fixed, and the toolbar is the only route to search and settings, so neither question is Jot's to answer. Both are unchanged in the extension.

### Fixed

- Birta Writer Jot will not write over a note it could not read. It read the note with "give me the text, or nothing", which cannot tell a note that is not there from a note that is there and unavailable, so both mounted an empty panel and the next save wrote that empty panel to the file. Nothing could reach that before, because the note lived where only Jot touched it. Keeping it in iCloud Drive makes it routine: on a second Mac the note may not have downloaded yet, and macOS evicts a file it has not seen used for a while and leaves a placeholder in its place. Jot now says so along the bottom of the panel, saves nothing in either direction until the note arrives, and picks it up the next time you summon the panel.

- The messages along the bottom of Birta Writer Jot's panel can be read. "Saved.", "New note." and the rest were drawn in the faintest of the system's text colours, which does not clear the contrast floor for text that size on the panel's own paper, so on a light window the line was close to invisible. They are drawn in the full-strength text colour now, and a soft ground the colour of the page fades in behind them, so a message that lands on top of a paragraph is legible instead of sitting in the middle of it. There is still no box, border or pill around the message: it is news rather than a control, and it goes on saying so by not looking like one.

- Birta Writer Jot's toolbar menus close when you click anywhere else, including on another menu's button. Its menus open on a click rather than on hover, and nothing was listening for the click that should have dismissed one, so every menu you opened stayed on screen: the format menu, the list menu and the gear menu could all be showing at once, overlapping each other over the text. Only one is open at a time now, and a click on the page closes it. The extension's menus open on hover and were never affected.

- The file name in Birta Writer Jot's titlebar takes the room the window actually has. It was cut to a fixed width whatever the window's size, which was wrong in both directions at once: a wide window truncated a name it had room to draw in full, with most of the titlebar left empty beside it, and a window narrow enough for the title to reach the page's own controls drew the name underneath the typography, search and settings buttons and left no band to drag the window by. The name now grows and shrinks as you resize the window, always stops short of those controls with enough band left to grab, and ends in an ellipsis only when it genuinely does not fit.

- Birta Writer Jot's titlebar draws the whole file name. A label that is told to truncate is still free to wrap first, and it wraps at a space, so a name with one in it laid out on two lines inside a box one line tall: the first line drew, the rest was clipped away, and nothing said so. A note called `Birta Writer Jot.md` titled itself `Birta`, which reads as the name of the file rather than as damage. The previous release narrowed the gap without closing it. A name genuinely too long for the titlebar now ends in an ellipsis.

- A tooltip in Birta Writer Jot's toolbar sits under the button it names. With the formatting row open it was pushed below both rows and out over the text, pointing at nothing.

- The chevron beside the formatting bar's T is drawn all the time. It used to appear on hover and grow from nothing, which pushed every control in the row 4px sideways as the pointer crossed it, so the button you were reaching for moved as you arrived at it.

### Removed

- Birta Writer Jot's two Chrome settings, one for the formatting half of the toolbar and one for the file path, both shipped one release ago. The dock's own toggle answers the first, and the second named a row that no longer exists: the file is in the titlebar now, where a macOS window title is not something you switch off.

- Birta Writer Jot's ··· menu along the bottom of the panel. Save a Copy As, Copy Everything and Reveal Last Save in Finder were already on the File menu, and Share has moved there beside them.

---

## [2026.819.0] - 2026, August 19

### Added

- Birta Writer Jot: New Note (⌘N) starts a fresh file beside the scratchpad, and Settings can make that the launch behavior instead of reopening the last note. Nothing is asked before the switch because nothing is unsaved: the note is written first every time, whatever autosave says.

- Birta Writer Jot's Settings can hide the formatting half of the toolbar, and the file path along the bottom.

- Birta Writer Jot's keyboard cheatsheet lists the app's own shortcuts, which are fixed by its menu and so can be printed without the risk of naming a key that has been rebound.

- `/ai` works in Birta Writer Jot. Settings holds the command it runs, in the same shape as the extension's `birta.agent.command`, so one tuned there can be pasted in unchanged. Jot writes the note to disk before the run, whatever autosave says, because the agent edits the file and the reference has to name something real. One difference from the extension: there is no merge, so an edit typed in the panel while a run is in flight is replaced when the run finishes.

- Birta Writer Jot's Settings can be opened from the gear in its toolbar, not only from the menu bar and Cmd+Comma.

- Whether Birta Writer Jot floats above other applications' windows is now a setting, on by default.

- Birta Writer Jot can open at login, from a switch in Settings. macOS may hold the request until you allow Birta Jot under General and then Login Items in System Settings, and the switch says so with a button that opens that pane rather than leaving you to find it. Only the installed copy can register, so install it to Applications first.

- Birta Writer Jot has a way out for a finished note. A row along the bottom of the panel offers Copy and Delete (⌥⌘C), which puts the whole note on the clipboard, clears the panel and hides it so the paste lands in the app you were in, and Save (⌘S), which files it in the folder Settings names, under a name taken from the note's first heading or the date, and clears the panel the same way. Neither can lose the note: whichever acted last is offered back from the ··· menu as Restore Deleted Note or Reopen Last Saved, one note deep, and Save never writes over a file that is already there. The ··· menu also holds Save As, Save to a folder you used recently, Copy Everything, Share, Discard, and Reveal Last Save in Finder. When Settings have Jot editing a document instead of the scratchpad, nothing empties it: Copy and Delete becomes Copy and Discard is not offered.

- Where Save files a note is a setting, defaulting to a Jot folder in your Documents, which is created the first time a note lands in it.

- Birta Writer Jot is now a download. Every release carries the app, and `bash jot/scripts/update-jot.sh` on any Mac fetches the newest one, checks it against its published checksum, and installs it, quitting and relaunching a running copy. The app is ad-hoc signed rather than notarized, so the script clears the download quarantine macOS would otherwise stop it with: that is a reasonable trade on your own machines and not one to ask of anyone else, which is why Jot still is not offered to other people. `jot/README.md` says what changes that.

- Link cards and pasted-link titles in Birta Writer Jot, under its network preference along with embeds. A link alone on its own line can show the page's own title and description as a card, and pasting a bare URL offers you the page's title as the link text, which stays an offer until you take it. Still off by default, and with it off Jot makes no outbound request at all. Only the page a link names is contacted, and where it redirects, each hop checked the same way: http(s) only, never a private or local address, bounded in time and bytes. An embed card's caption is the one piece not fetched, because recognizing a provider needs a table that lives in the editor rather than the shell.

- Images in Birta Writer Jot. Paste or drop one and it is saved beside the document in an `Attachments` folder, named by a hash of its bytes so the same screenshot twice writes one file, and referenced relatively so the note stays portable and carries no path from your machine. Save As copies the images that note actually uses into an `Attachments` folder beside the file you chose, leaving the rest of the folder behind, and tells you if any could not be copied rather than saving a note of broken images quietly.

### Changed

- Birta Writer Jot's Settings is now three panes with a tab bar, in the shape macOS settings windows have, and it scrolls rather than growing past the screen. General holds login, floating, the hotkey, the blank-note choice and the network opt-in; Editor holds autosave and the toolbar and file-path switches; Advanced holds the file paths and the agent command, so the two panes anyone opens are short. Most rows lost their explanatory sentence, which was restating the label.

- Birta Writer Jot's font, size and width controls have moved into the gear menu, and the separate font button is gone from its toolbar. The controls, the commands and the slash-menu rows are unchanged, and so is the editor inside VS Code, where the font button stays where it was.

- Birta Writer Jot's upper-right toolbar controls, find included, now stay visible when the pointer leaves the window. Previously everything but the gear faded out.

- Breaking, in Birta Writer Jot: the panel no longer floats above other applications' windows by default. The setting is still there for anyone who wants it back.

- Breaking, in Birta Writer Jot: saving no longer empties the panel. Jot edits one file the way any editor does. Autosave (a new setting, on by default) writes as you type, Cmd+S writes on demand, and Shift+Cmd+S writes a copy somewhere you choose and leaves the note where it is. The old model, where Save filed the note under a generated name in a destination folder and cleared the buffer, is gone, along with that destination setting, Copy and Delete, Discard, and the one-deep Restore and Reopen items that existed to undo the clearing. Turning autosave off stops writing while you type and nothing else: hiding the panel and quitting still write.

- Birta Writer Jot defaults to a serif font and no longer offers the Editor font option, which named a VS Code editor font it has none of. Its font picker also had no effect at all before this: it moved the checkmark and left the document alone.

- Birta Writer Jot's text is always full width. The full and fixed control is gone there, because the panel is already its own reading measure. In the editor inside VS Code the control is unchanged, and Full Width and Fixed Width are now also in the command palette.

- The file being edited is named in Birta Writer Jot's bottom left only while its window has focus.

- Birta Writer Jot has its own icons: the Birta Writer Jot mark in the menu bar in place of the stock pencil, and an app icon in Finder, Login Items and the Settings window where it previously showed the blank default.

- Birta Writer Jot's panel is quiet until you point at it. The toolbar's buttons and the action row fade in while the pointer is over the window and back out when it leaves, leaving the page, the window buttons and the settings gear. The panel also has all three window buttons now instead of a lone close button, its toolbar no longer runs under them or draws a line beneath itself, and the file the note is being written to is named in the bottom left. Summoning and dismissing use the system's own window animation rather than a chosen one.

- Breaking, in Birta Writer Jot: Cmd+S is now Save, which files the note in your default destination without asking, and Save As moves to ⇧⌘S.

- Birta Writer Jot's menu-bar item now toggles the panel when you click it, the way the hotkey does; its menu is on Control-click or right-click. That menu is down to the panel toggle, Settings and Quit, with the toggle's shortcut drawn where a menu draws a shortcut. Where a note goes is a question about the note, so it is answered in the window that holds it and no longer from the menu bar.

- Birta Writer Jot's Preferences window is now Settings, laid out as grouped sections in the shape macOS uses, and its hotkey is set by pressing the combination rather than by typing `cmd+alt+ctrl+j` as text. The field shows the modifier keys lighting up as you hold them, and a clear button starts a new recording, so a stray keystroke cannot rebind the hotkey while the field happens to have focus.

- Birta Writer Jot's Settings window is titled for the app rather than for the pane you are on, so a window from an app with no Dock icon says which app it belongs to.

### Fixed

- Hiding Birta Writer Jot's formatting toolbar left the search and settings controls stranded in the middle of the bar instead of at its right edge.

- Hiding Birta Writer Jot left its Settings window open and floating, with no editor behind it to be the settings of.

- Birta Writer Jot's Settings drew every group on a ground the same colour as the window, so the sections ran together as one list. `windowBackgroundColor` and `controlBackgroundColor` are the same colour in both light and dark.

- In Birta Writer Jot, the toolbar slid away from the top edge when a scroll ran past either end of the document, and sprang back.

- In Birta Writer Jot, the minus key could not be used in the summon hotkey. Typing `cmd+-` into the old Preferences hotkey field was refused as naming no key, and the new Settings recorder registered nothing when that key was pressed, because the parser reads `-` as a separator between the parts of a combination and so never saw it as the key itself. Every other key was unaffected.

- In Birta Writer Jot, pressing Return at the end of a block left the caret in the block above, so the next thing typed joined the previous line instead of starting the new one. Splitting a block from the middle was unaffected. The editor inside VS Code never had this: it renders in a different engine, which tolerated the arrangement that caused it.

- Birta Writer Jot no longer rewrites a document you pointed it at when you changed nothing. Opening a file through Settings, summoning it, typing nothing and dismissing used to replace it: a new inode, a fresh timestamp, and permissions narrowed to 0600 whatever they had been, which also turned a symlink into a regular file. Jot now writes a file you already had the way an edit does, keeping its permissions, writing through a symlink to the file it points at, and not writing at all when the bytes on disk already match what it would write. A file Jot creates is still private by default. One part of this it cannot fix: a real edit still gives the file a new inode, so a hard link to it is still broken, which is the price of replacing a file atomically rather than writing over it in place.

---

## [2026.818.0] - 2026, August 18

### Added

- Birta Writer Jot, a macOS menu-bar scratchpad running this editor outside VS Code, in the repository as `jot/` and buildable from source (`pnpm jot:build`; macOS 14, Swift 6, no developer account needed, not yet distributed as a download). Press ⌘⌥⌃J from any app to summon a floating panel with the same editor, toolbar, slash commands, block drag, embeds and inline calc as the extension, minus what only means something inside VS Code (the raw markdown view, the settings gear's VS Code entries, proofreading, the read-only toggle, the table of contents, image upload); Esc twice or the hotkey hides it, and it follows the system light and dark appearance. It keeps one buffer, saved on every edit to a plain `Scratchpad.md` under `~/Library/Application Support/Birta Jot/` (Preferences can point it at another file), so hiding, quitting or a crash never loses bytes; Cmd+S is Save As, which writes the buffer to a chosen file and clears it, with Reopen Last Saved as the undo. Network is off by default and Preferences has the opt-in for link cards and embeds. `jot/README.md` has the build, the checklist and the measurement script.
