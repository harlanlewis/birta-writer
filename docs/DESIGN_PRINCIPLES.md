# Design principles

The rules of thumb this editor is built on. They exist so a change can be
checked against intent, not just "does it work" — when a new affordance fights
one of these, that's a signal to rethink the affordance, not the principle. This
is a living document; add to it when a decision turns out to be load-bearing.

Product intent and ordering ("Why this fork") live in `README.md`; agent/build
conventions live in `CLAUDE.md`. This file is specifically about **how the UI
communicates** and **how much it's allowed to interrupt**.

---

## Decorations mean one thing each

Every inline decoration carries a fixed meaning. A reader should be able to
learn the vocabulary once and trust it everywhere.

- **Strikethrough means "delete this."** Reserved for findings whose fix is
  removal — style hits you can read the sentence without (fillers,
  redundancies, clichés, wordiness, AI vocabulary/boilerplate, repeated words).
  A dimmed strike says *try it gone*. Never strike text you aren't suggesting be
  cut. (Implementation: `pf-style-hit`, `webview/plugins/proofread.ts`.)
- **A dotted underline means "reconsider this," not "remove it."** Used for
  judgment flags — passive voice, long sentences, rule-of-three, negative
  parallelism, em dash, non-ASCII punctuation. There's a decision to make, and
  the text may well be right. (`pf-style-hit--flag`.)
- **Color encodes the source, not the severity.** Spelling is the editor's
  warning color, grammar the info color, style the muted description color. Hue
  tells you *which engine* flagged it. This is the one place color carries
  meaning, so nothing else in the proofreading layer competes for it.

The corollary: **don't stack a second visual channel onto a decoration to say
the same thing.** iA Writer can lean on hue alone because its canvas is otherwise
undecorated; ours already spends color and underlines on links, highlights, and
marks, so proofreading gets exactly one treatment per meaning and no more.

## Annotation is advisory, reversible, and quiet

Proofreading (and anything like it) advises; it never acts on its own.

- **Every finding earns its interruption.** The popup copy must say *why* it's
  flagged and *what to do* — with a concrete before→after where one fits. Never
  restate the label back at the reader. "Passive voice → consider the active
  voice" is the anti-pattern: it added nothing the chip didn't already say.
  Compare "The doer is hidden or trailing — lead with who acts: 'mistakes were
  made' → 'we made mistakes'." (`styleAdvice`, `styleHitTitle`.)
- **Nothing changes the file without consent.** A finding offers a fix, a
  dictionary add, or Ignore. Suggestions apply on click, never automatically.
- **The user can always go quiet.** All checks ship on, but a single master
  **Proofreading** switch (the top row of the Checks menu, and the
  `toggleAllChecks` command) silences spelling, grammar, and style in one step,
  and restores the exact per-check config on the way back. Defaulting loud is
  only acceptable because going quiet is one action away. Name the domain in the
  control ("Proofreading", not "all checks") — the toolbar button is icon-only,
  so a bare "all" has no referent — and give the master a *switch*, distinct from
  the checkmark rows it governs, so its hierarchy reads at a glance.
- **A disabled feature costs nothing.** No scan, no decoration pass, no lazy
  dependency loaded. (See "Launch performance" in `CLAUDE.md`.)

## Analysis never blocks interactivity

Decoration and analysis settle in *after* first paint, on idle — never on the
mount path and never as a reaction to the user's first keystroke. The editor is
interactive before the first proofread pass runs. (Enforced by the deferred
first pass in `proofread.ts`; measured by `e2e/perf/`.)

## Chrome mirrors the source and stays out of the way

- **Gutter marks reflect the Markdown, dimmed.** Headings show their literal
  hashes (`#`, `##`, … `######`) in the monospace editor font at low opacity —
  a level cue that reads as source, not a custom badge. Chrome like this is
  non-interactive (`pointer-events: none`) except for deliberate controls (the
  fold chevron).
- **Theme tokens only.** All color comes from `--vscode-*` variables so light
  and dark themes both work; accents use `var(--vscode-focusBorder)` with no
  literal fallback. No custom hex. (See `CLAUDE.md` → Architecture constraints.)

## When these collide

If a feature seems to need to break one of these — strikethrough for something
you're *not* suggesting be deleted, a decoration that blocks paint, microcopy
that only names the problem — treat it as a design smell first. Usually the
feature wants a different treatment (a flag underline, an idle pass, a real
explanation), not an exception to the rule.
