# Changelog: Birta Jot

Birta Jot is the macOS menu-bar scratchpad in `jot/`. It runs the same editor the Birta Writer extension does, out of the same `dist/webview.js`, so every editor change reaches it and those are recorded in [`../CHANGELOG.md`](../CHANGELOG.md) rather than repeated here. This file records the app AROUND that editor: its panel and window, menu bar, settings, file handling, packaging and install.

The two are separate because they have different readers and different ways in. The extension is installed from the VS Code Marketplace and Open VSX, both of which render `CHANGELOG.md` out of the VSIX; Jot is installable from neither, and arrives as an app attached to a GitHub Release. An entry a Marketplace reader cannot act on spends the attention the ones they can act on need.

Versions are shared. Both files are stamped with the same release version, and a version appears here only when something about the app changed in it.

---

## [Unreleased]

### Changed

- The gear menu's row for Jot's settings, and the title of the window it opens, are called Birta Jot Settings again. One release called them Writer Jot Settings, which named the app by a name nothing else uses: the app in Applications and the folder it keeps notes in both say Birta Jot.
---

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

---

## [2026.818.0] - 2026, August 18

### Added

- Birta Writer Jot, a macOS menu-bar scratchpad running this editor outside VS Code, in the repository as `jot/` and buildable from source (`pnpm jot:build`; macOS 14, Swift 6, no developer account needed, not yet distributed as a download). Press ⌘⌥⌃J from any app to summon a floating panel with the same editor, toolbar, slash commands, block drag, embeds and inline calc as the extension, minus what only means something inside VS Code (the raw markdown view, the settings gear's VS Code entries, proofreading, the read-only toggle, the table of contents, image upload); Esc twice or the hotkey hides it, and it follows the system light and dark appearance. It keeps one buffer, saved on every edit to a plain `Scratchpad.md` under `~/Library/Application Support/Birta Jot/` (Preferences can point it at another file), so hiding, quitting or a crash never loses bytes; Cmd+S is Save As, which writes the buffer to a chosen file and clears it, with Reopen Last Saved as the undo. Network is off by default and Preferences has the opt-in for link cards and embeds. `jot/README.md` has the build, the checklist and the measurement script.
