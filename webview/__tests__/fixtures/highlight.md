# Highlight

Plain ==highlighted text== inline.

Adjacent==tight==highlights and **==inside bold==** marks.

Multiple ==first== and ==second== in one paragraph.

Unicode ==höhere Café ☕== survives.

Rejected forms stay plain text, one per line — adjacent rejected forms on a
single line can legitimately cross-match (the tail `==` of one pairs with the
head `==` of the next), same as any paired-delimiter syntax:

A spaced form == spaced == stays prose.

An equals-inside form ==a=b== stays prose.

A trailing-space form ==trailing == stays prose.

An equality 2==2 stays prose.

A lone == pair and an a == b comparison stay prose.

==Starts a line== and ends a ==line==

- A list item with ==highlight== inside.

> A blockquote with ==highlight== inside.

| cell ==one== | cell two |
| --- | --- |
| x | ==y== |

Escaped \==not a highlight== stays literal.

`==in code==` stays code.
