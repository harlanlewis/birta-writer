# Partly-loose lists

mdast carries one `spread` boolean per list, so any list below with a blank
line anywhere between its items parses as fully loose. Each blank line must
nonetheless come back exactly where it was authored (MAR-194), and the uniform
lists at the end must keep their own character.

- foo
- bar
- baz

- bingo
- wingo

A blank early rather than late:

- alpha

- beta
- gamma

Ordered, with the gap before the last item:

1. one
2. two

3. three

Nested, with the gap inside the sub-list:

- parent
  - child one

  - child two
- sibling

A genuinely loose list, which must stay fully loose:

- spaced one

- spaced two

- spaced three

A genuinely tight list, which must stay fully tight:

- packed one
- packed two
- packed three

Tasks with an interior gap:

- [ ] open task
- [x] done task

- [ ] later task

An item with two paragraphs, whose interior blank is required:

- first paragraph

  second paragraph

- next item
