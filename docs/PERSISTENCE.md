# What a host owes the user's bytes

The editor is one page and one protocol; a host is whatever mounts it, and the host owns the file. This document is the contract between the two for persistence: what every host must honour before it may call itself a Birta Writer surface, and what each host is free to decide. It is written from the two hosts that ship, Birta Writer for VS Code and Birta Writer for Mac, and every row below cites the code that keeps it. [`HOSTING.md`](HOSTING.md) is the sibling contract for what the editor needs from a page; this one is what the page needs from a file.

The split matters because a sync backend is a host too. [`NETWORK_POSTURE.md`](NETWORK_POSTURE.md) puts document content on rung 3 of its ladder, and the plan for pluggable sync backends (MAR-345) is built on the rule below that mechanism is pluggable and fidelity semantics are not. This is where that line is drawn.

## Fixed for every host

Three promises, and a host that cannot keep all three ships in advisory mode, never with the promise relaxed. Advisory mode is the `diskDrift` stance: notice, tell the user, write nothing.

1. Never write bytes the user did not cause. A write follows an edit, a save or a close, and carries the document as the editor holds it. Nothing on a timer, nothing on a poll, nothing on a merge the user was not shown. The page's own half of this is round-trip protection and the minimal diff (`webview/utils/minimalDiff.ts`, `packages/minimal-diff`): an untouched region of the file is never rewritten, on any host, because the host sends the file's own bytes as the document and the page merges against them.
2. Never auto-merge without consent. Where the file and the editor have both changed, the host does not pick a winner. It names what changed and asks, or it refuses to write. The VS Code host's `diskDrift` badge is the shape: an advisory, and the user's click is the only thing that reverts.
3. Always be able to say what changed. A host that writes must know what it wrote against: a version, a fingerprint, a stat. This is what makes the other two checkable rather than hoped for.

These are the principles MAR-345 fixed as non-negotiable across sync backends. They are restated here because they bind hosts that never sync at all.

## Defined per host

The rows every host answers differently, with the two shipped answers.

| Question | Birta Writer for VS Code | Birta Writer for Mac |
| -- | -- | -- |
| Who owns dirty state | VS Code's `TextDocument`; the custom editor is `CustomTextEditorProvider`-backed, so native dirty, hot exit and the tab's own chrome apply | The app's buffer, with the title's Edited mark drawn by `WindowTitle.swift` and the quit sheet's words in `UnsavedChanges.swift` |
| When the file is written | Never by the extension; VS Code writes on `files.autoSave` or Cmd+S, and the extension's job is to make the write carry the freshest bytes (below) | `AutosavePolicy.action`: an edit is deferred a beat, hiding the panel and quitting write at once, an explicit save always writes; with autosave off, hiding writes nothing and quitting asks |
| How the freshest bytes reach the write | `onWillSaveTextDocument` plus `waitUntil`: the provider asks the page to serialize now and returns the reply as the save's edits, bounded by a timeout so a wedged page degrades to "save what the document holds" (`shared/saveFlushController.ts`) | The page's sync posts the document to the host on the scheduler's cadence; `CoalescingWriter` keeps at most one write in flight plus the newest pending content, and `drain()` is what quit and the installer wait on |
| Atomic write | VS Code's | `AtomicFile.write`: a temp file beside the target, renamed over it; an existing file keeps its mode, a symlink is followed rather than replaced, and identical content is not written at all |
| Ordering across writers | `SaveFlushController`: every content message carries a `seq`, one high-water mark per `(document, writer)`, and a supplied admissibility predicate says whether content serialized against an older version may still land (MAR-346) | One writer, one buffer per bound file; two windows cannot bind one path, because `OpenRouting` fronts the open tab instead |
| External change: the document changed under the editor | Mechanism A in `src/externalChanges.ts`: `onDidChangeTextDocument`, debounced, with the version bumped synchronously at observe time so a racing page update is already stale; the page is re-based with a cursor-preserving minimal diff | Not observed. `NoteWatcher` follows a move and notices a delete through `NSFilePresenter`; a change to the bound file's CONTENTS while it is bound is not seen, and the buffer wins on the next write |
| External change: the disk drifted from a dirty editor | Mechanism B, `src/diskDrift.ts`: a per-document watcher, an advisory badge, never a write | Same gap as the row above |
| A file that moves or goes | VS Code's own handling of a renamed or deleted document | `NoteWatcher.onMoved` rebinds to the new path; `onDeleted` stops writing and offers to put a trashed file back (`MissingFileScreen.swift`) |
| Crash safety | Hot exit backs up the `TextDocument`; how far it trails the editor is bounded by the sync scheduler's max wait, which is why that debounce may never be lengthened | The deferred write after an edit is the whole bound; with autosave off there is none, by the setting's own promise |
| Frontmatter | Split off on the host before the page sees the body (`shared/contentTransform.ts`), held as a mirror, put back on write | The same split, ported line for line (`Frontmatter.swift`), with `frontmatterPort.test.ts` holding the two patterns equal |
| Where the read root is | `localResourceRoots`, the workspace | `ResourceRoots`, rebased onto the bound file's folder |

## What the two answers say about the contract

The rows agree on the promises and disagree on the mechanism, which is what a contract should look like. Two things the table makes visible are worth stating outright.

The Mac app has no answer for the sixth and seventh rows. It was built as a scratchpad nobody else touched, where reading once and letting the buffer win was right. Directory windows, Open With and the `bwr` command have since made a file open in the app and open somewhere else the ordinary case, and a file edited in another editor, then summoned and hidden here, is written over. That is the second promise broken by omission, and it is tracked as MAR-469; until it lands, the app is in advisory mode on that row without the advisory.

The fourth row is where the Mac app made choices the contract should carry to any future host, because each is a decision and not an accident. The mode of a file the user made is theirs; 0600 is for a file the app named itself. A symlink stays a symlink because the person who made it meant it. Identical content is not written because a dismiss that changed nothing must leave the file's bytes, mtime and inode alone, which is the only way an unchanged file reads as unchanged to every other tool.

## Columns not yet written

A host that owns no file at all: an embedding host with a database row, a form field or nothing (MAR-447). The rows above assume a path; that column needs a version token that is not a stat and a definition of "written" that is the host's.

An iOS host on `UIDocument`, whose `contents(forType:)` is synchronous where the flush is an IPC hop away, sketched on MAR-226 and unrun.

A sync backend with ancestry, where the admissibility predicate is a reachability check rather than equality and rejection has three outcomes (`rebase`, `defer`, `escalate`). The seam exists (MAR-346); no backend binds it yet (MAR-347).
