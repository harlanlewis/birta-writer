# List markers and autolinks

Marker style is part of the file, not a detail the editor gets to normalize
(MAR-218). Every list below is written in a form the serializer used to
canonicalize away, so an edit anywhere in this file used to rewrite lines
nobody touched.

## Plus bullets

+ first plus item
+ second plus item
+ third plus item

## Star bullets

* first star item
* second star item

## Paren-delimited ordered

1) first paren item
2) second paren item
3) third paren item

## Lazy numbering

Repeating one number is a deliberate authoring style: it survives reordering,
so the file never has to be renumbered by hand.

1. first lazy step
1. second lazy step
1. third lazy step

## Lazy numbering from a non-1 start

3. third overall
3. fourth overall
3. fifth overall

## Nested mixed markers

- dash at the top level
  * star one level in
  * another star
- back to a dash

## Adjacent lists split by a marker change

A marker change is the only way Markdown can write two adjacent lists, so the
split is the author's syntax and both markers have to survive.

- first list, first item
- first list, second item

* second list, first item
* second list, second item

## Autolink literals

A bare URL in prose: https://example.com/a/b?c=1 and text after it.

A bare email in prose: someone@example.com and text after it.

An angle autolink: <https://example.com/path> and text after it.

An angle autolink whose path ends in a backslash: <https://example.com/a\> —
backslash escapes are inert inside an autolink, so this must not grow one on
every save.

## Closed ATX headings ##

A closing hash run is legal ATX, and it is the author's choice.

### A deeper closed heading ###

Text under the deeper closed heading.
