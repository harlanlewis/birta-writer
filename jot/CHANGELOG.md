# Changelog: Birta Writer Jot

Birta Writer Jot is the macOS menu-bar scratchpad in `jot/`. It runs the same editor the Birta Writer extension does, out of the same `dist/webview.js`, so every editor change reaches it and those are recorded in [`../CHANGELOG.md`](../CHANGELOG.md) rather than repeated here. This file records the app AROUND that editor: its panel and window, menu bar, settings, file handling, packaging and install.

The two are separate because they have different readers and different ways in. The extension is installed from the VS Code Marketplace and Open VSX, both of which render `CHANGELOG.md` out of the VSIX; Jot is installable from neither, and arrives as an app attached to a GitHub Release. An entry a Marketplace reader cannot act on spends the attention the ones they can act on need.

Versions are shared. Both files are stamped with the same release version, and a version appears here only when something about the app changed in it.

---

## [Unreleased]

### Added

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
