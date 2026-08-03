# Migration runbook

This fixture opens with a long, deliberately boring preamble, because real documents do. The subject — a dense thicket of reference-style links — starts well past the point a gate that only looks at the first handful of paragraphs would ever reach.

Before you begin, read the whole runbook end to end.

Schedule the window with the on-call rotation at least one business day ahead.

Announce the window in the operations channel when the window opens.

Take a snapshot before touching anything, and verify it restores.

Confirm the rollback path with a second engineer, out loud.

Check that the dashboards you plan to watch are actually reporting.

Silence the alerts that will fire by design, and only those.

Have the incident template open in another tab.

Decide in advance what "abort" looks like, in numbers.

Write the abort threshold down where someone else can see it.

Agree who calls the abort, and make sure that person is awake.

None of that is the subject of this file. This is.

## Reference-style links

A full reference: [the spec][spec]. A collapsed reference: [runbook][]. A
shortcut reference: [changelog]. All three resolve to definitions below.

Labels match case-insensitively with collapsed internal whitespace, so
[The Spec][SPEC] and [the   spec][spec] are the same link as the first one.

An unresolved reference stays literal text: [not defined][missing-label].

Literal brackets that are NOT a reference: \[bracketed\] and `[in code]`.

An inline link beside them all, for contrast: [inline](https://example.com/x).

An image reference: ![the diagram][diagram], and its collapsed twin:
![diagram][].

A definition can also be used as a footnote-shaped label without being one:
[^not-a-footnote] is a shortcut reference here, not a footnote call.

## Definitions

[spec]: https://example.com/spec "The Specification"
[runbook]: https://example.com/runbook 'Single quoted title'
[changelog]: <https://example.com/change log> (Parenthesized title)
[diagram]: images/diagram.png "Architecture diagram"
[^not-a-footnote]: https://example.com/not-a-footnote

[unused-definition]: https://example.com/unused "Never referenced, never dropped"
