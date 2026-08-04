# Footnote variants

A paragraph with a numeric reference[^1] and a non-numeric one[^note].

Here the same note is cited twice[^note] to check duplicate references.

[^before]: This definition appears before its reference in the file.

The reference to the above definition sits here[^before].

[^1]: A simple single-line definition.

[^note]: A longer footnote definition with two paragraphs.

    The second paragraph is an indented continuation of the same note.

[^unused]: This definition has no reference anywhere in the document.

A definition can hold a list, and that list can be loose[^list].

[^list]: A definition whose list is loose — a blank line between every item.

    - first item

    - second item

    - third item

An item in such a list can also carry a sublist of its own[^outline].

[^outline]: A loose list whose first item holds a tight sublist (MAR-302). The
    blank line belongs between the items, never between an item and its own
    sublist.

    - parent
      - child one
      - child two

    - sibling
