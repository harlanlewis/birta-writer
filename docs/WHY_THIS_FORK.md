# Why this fork

**North star: never leave WYSIWYG.** A user opens a `.md` file in WYSIWYG mode and never *needs* the raw text editor unless they genuinely prefer it. Every change is judged by one question: *does this remove a reason to pop out?* The pop-out itself stays polished and instant — even the most mature competitors ship a one-keystroke escape hatch as a first-class feature. It's a safety net, not a wall.

Investment follows an ordering the evidence made unambiguous — from a survey of this codebase, upstream, competing VS Code WYSIWYG extensions (vscode-markdown-editor, vscode-office, unotes), Milkdown's own tracker, and capability-diffing against Typora, Obsidian Live Preview, and MarkText:

1. **Fidelity and trust first — it's existential.** The #1 trust-killer in every competitor's tracker is round-trip infidelity: "it reformatted my file", "it lost content". One competitor was un-published from the Marketplace over exactly this ([unotes](https://github.com/ryanmcalister/unotes)); MarkText's most-reacted bug is "document is modified just by opening it" ([marktext#2189](https://github.com/marktext/marktext/issues/2189)); the project this one forked from carries a live corruption report of its own. One corruption event sends a user back to raw mode permanently. This fork's minimal-diff serializer, round-trip regression corpus, and destructive-diff save guard exist because of this.
2. **VS Code parity second.** The custom-editor API deliberately provides nothing — no find, no undo integration, no search reveal ("that's all intentionally left up to extensions", [microsoft/vscode#86802](https://github.com/microsoft/vscode/issues/86802)) — so parity users feel daily is hand-built here: find/replace, command palette and context-menu commands, Go-to-Symbol, user-rebindable keybindings, theme fidelity.
3. **Parser and syntax breadth third.** Math, footnotes, frontmatter, reference links — and anything the schema can't represent must degrade to *visible but safe*, never a silent deletion, so the editor is trustworthy on any file.
4. **Interaction patterns last.** The polish that makes the editor *preferred* rather than merely tolerated, invested in once the layers beneath it held: slash commands, a full block-interaction system (gutter grabbers on every block, a block menu, drag-to-move, marquee and keyboard block selection) — with smart paste still ahead.

That ordering is the **founding rationale**, and it is history as much as plan: layer 2 (VS Code parity) shipped in 0.2.3, and the live sequencing spine that replaced it is the `phase-*` roadmap in [`AGENTS.md`](../AGENTS.md) — fidelity → performance → syntax → interaction → differentiators. Use the phase spine as the tie-breaker when goals conflict; use this list to understand why the fork exists.

Where the project might go beyond the VS Code extension — surfaces, engine ownership, the AI posture, publishing — is under active exploration, and none of it is committed scope. That exploration is maintained privately and is deliberately kept out of this repository.

## Relationship to the original

Birta Writer began as a hard fork and is now developed fully independently. The divergence was deliberate and permanent, including a Chinese→English migration and the rebrand; the `upstream` git remote was removed on purpose and is never re-added.

The origin project is named only where attribution requires it — [`NOTICE`](../NOTICE) and [`LICENSE-MIT`](../LICENSE-MIT).
