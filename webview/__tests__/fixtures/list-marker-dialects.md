# List marker dialects

CommonMark starts a NEW list whenever the bullet character or the ordered
delimiter changes, so the marker byte is structure, not style. A blank line
between two markers of the SAME kind at the SAME column is instead the list's
spread — which is why the two cases must never be confused (MAR-293).

- dash one
- dash two

* star one
* star two

+ plus one
+ plus two

The delimiter switch, which also splits the list:

1. period one
2. period two

1) paren one
2) paren two

An ordered list that does not start at 1, and does not renumber from 1:

5. five
6. six
7. seven

A `)` list with the gap before its last item — loose by mdast's one-per-list
`spread`, but only that one gap was authored:

1) first
2) second

3) third

A `+` list with the gap before its last item:

+ alpha
+ beta

+ gamma

Nested markers that differ from their parent's:

- parent dash
  * child star
  * child star two
    + grandchild plus
- parent dash two

A marker change at the same column with no blank between the two lists:

* star tail
- dash head

Tasks with a `+` marker, and one interior gap:

+ [ ] open task
+ [x] done task

+ [ ] later task
