title:: Project Atlas
tags:: project, active, roadmap
type:: [[Project]]
alias:: Atlas, Project A

- # Project Atlas
  A top-level block whose content is a heading. In Logseq every block —
  headings included — is a bullet, and indentation encodes the block tree.
- A normal block with a [[Page Reference]], a #tag, and a #[[multi word tag]].
	- A nested child block, one tab deeper.
	- A child that carries block properties.
	  collapsed:: true
	  background-color:: green
		- A grandchild, two tabs deep.
- TODO Finish the round-trip fidelity analysis
  SCHEDULED: <2026-07-15 Wed>
- DOING Draft synthetic Logseq fixtures [#A]
  :LOGBOOK:
  CLOCK: [2026-07-12 Sun 10:00:00]
  :END:
- DONE Wire up graph detection
- LATER Review with maintainer
- A block referencing another block ((66a1b2c3-d4e5-6789-abcd-ef0123456789)).
- A query block: {{query (and [[project]] (task TODO DOING))}}
- An embed: {{embed [[Another Page]]}}
- Inline formatting: **bold**, *italic*, ==highlight==, ~~strike~~, and `code`.
	- > A blockquote nested inside a bullet.
	- A fenced code block inside a bullet:
	  ```js
	  console.log("hello from a nested block");
	  ```
