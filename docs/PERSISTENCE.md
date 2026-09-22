# What a host owes the user's bytes

The editor is one page and one protocol; a host is whatever mounts it, and the host owns the file. This document is the contract between the two for persistence: what every host must honour before it may call itself a Birta Writer surface, and what each host is free to decide. It is written from the two hosts that ship, Birta Writer for VS Code and Birta Writer for Mac, and every row below names what keeps it, ours or the platform's. [`HOSTING.md`](HOSTING.md) is the sibling contract for what the editor needs from a page; this one is what the page needs from a file.

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
| External change: the document changed under the editor | Mechanism A in `src/externalChanges.ts`: `onDidChangeTextDocument`, debounced, with the version bumped synchronously at observe time so a racing page update is already stale; the page is re-based with a cursor-preserving minimal diff | `DiskDrift.judge` against a recorded baseline (the bytes last read or written, plus a stat as the filter), asked at every summon and immediately before every write. A buffer holding nothing the file lacks takes the file's bytes, and nothing is written. `presentedItemDidChange` asks the same question early, for the coordinated writes a presenter hears, and stands down while this window's own write is still in flight, so what it adds is promptness and never the guarantee |
| External change: the disk drifted from a dirty editor | Mechanism B, `src/diskDrift.ts`: a per-document watcher, an advisory badge, never a write | The same rule's other answer: the write is refused and the question is put, Reload from Disk against Keep My Changes, on the window whose file it is. A window going before anybody answers keeps its buffer beside the file rather than over it |
| A file that moves or goes | VS Code's own handling of a renamed or deleted document | `NoteWatcher.onMoved` rebinds to the new path; `onDeleted` stops writing and offers to put a trashed file back (`MissingFileScreen.swift`) |
| Crash safety | Hot exit backs up the `TextDocument`; how far it trails the editor is bounded by the sync scheduler's max wait, which is why that debounce may never be lengthened | The deferred write after an edit, re-held by each keystroke and capped by the coordinator's max wait under continuous typing, is the bound; with autosave off there is none, by the setting's own promise |
| Frontmatter | Split off on the host before the page sees the body (`shared/contentTransform.ts`), held as a mirror, put back on write | The same split, ported line for line (`Frontmatter.swift`), with `frontmatterPort.test.ts` holding the two patterns equal |
| Where the read root is | `localResourceRoots`, the workspace | `ResourceRoots`, rebased onto the bound file's folder |

## What the two answers say about the contract

The rows agree on the promises and disagree on the mechanism, which is what a contract should look like. Two things the table makes visible are worth stating outright.

The two external-change rows are answered by one rule on the Mac and by two mechanisms in VS Code, and the difference is the platform rather than the promise. The extension is handed a `TextDocument` VS Code already watches; the app owns a path, so it has to know what it is writing against, which is the third promise doing its work. What it keeps is the bytes it last read or wrote and a stat over them: the stat settles the ordinary case without reading anything, and only a stat that has moved costs a read. The app was built as a scratchpad nobody else touched, where reading once and letting the buffer win was right; directory windows, Open With and the `bwr` command made a file open here and open somewhere else the ordinary case, and until MAR-469 a file edited in another editor, then summoned and hidden here, was written over.

What neither host does is merge. Both name what changed and ask, which is promise 2 in its two shapes: VS Code's advisory badge, and the app's sheet with the two answers spelled out.

An `/ai` run in flight narrows the app's rule in one respect and is worth stating, because nothing about it is visible from the outside. The run edits the bound file at this window's request, and in the middle of it the app cannot tell the run's write from a third program's: both are bytes on disk that differ from what it last wrote, and what the run will produce is not known until it lands. So the check does not stand down for a run, and it does not ask during one either. A file that moved while a run works is treated as any file that moved, except for the question: a buffer holding nothing the file lacks takes the file's bytes, and a buffer that has diverged is never written over it, but the question is deferred to the landing rather than put mid-run, since asking there would be asking about the file the user just asked an agent to rewrite, and Keep would write the buffer over the agent's work. The landing (`AgentLandingPolicy`, `finishAgentRun`) is the answer for whichever writer it was: the file is re-read, a clean panel takes it, a panel with edits of its own has the file's bytes folded around them by the page, and anything the fold leaves out is kept in a copy beside the note. A run that ends without landing leaves the conflict standing, and the next write or summon asks as it would have. The cost of the narrowing is that a third program's change arriving during a run is brought in by the run's merge rather than by the question, under the consent given to the run. `mac/scripts/check-external-change.sh` drives all three arrangements against the running app.

The atomic-write row is where the Mac app made choices the contract should carry to any future host, because each is a decision and not an accident. The mode of a file the user made is theirs; 0600 is for a file the app named itself. A symlink stays a symlink because the person who made it meant it. Identical content is not written because a dismiss that changed nothing must leave the file's bytes, mtime and inode alone, which is the only way an unchanged file reads as unchanged to every other tool.

## Columns not yet written

A host that owns no file at all: an embedding host with a database row, a form field or nothing (MAR-447). The rows above assume a path; that column needs a version token that is not a stat and a definition of "written" that is the host's.

An iOS host on `UIDocument`, whose `contents(forType:)` is synchronous where the flush is an IPC hop away. The sketch is recorded on MAR-226, the closed design ticket this document answers, and is unrun. A web or cloud host has no sketch at all. The Tauri mapping that ticket once asked for is moot: the desktop host that shipped is native.

Credentials are a column of their own that no row above holds: a keychain, a callback route for sign-in, and a consent scope a workspace cannot flip are VS Code services today (`SecretStorage`, `registerUriHandler`, application-scoped settings), and [`NETWORK_POSTURE.md`](NETWORK_POSTURE.md) says what a host off VS Code would owe in their place. No ticket carries that column yet.

A sync backend with ancestry, where the admissibility predicate is a reachability check rather than equality and rejection has three outcomes (`rebase`, `defer`, `escalate`). The seam exists (MAR-346); no backend binds it yet (MAR-347).
