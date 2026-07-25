# Tilde fences beside canonicalized lines

A line the serializer rewrites, immediately before a tilde fence, used to make
the fence's protection region stand down while its closing twin repaired — a
mismatched pair that swallowed the rest of the document on reopen (2026-07-25).

a * b

~~~
tilde fenced content
~~~

tail paragraph after the fence.

Two canonicalized lines and two fences in one run:

x * y

~~~
first block
~~~

p * q

~~~js
second block
~~~

closing paragraph.

An indented tilde fence inside a list:

- item with a fence

  ~~~
  nested tilde content
  ~~~

- sibling item

A tilde fence in a blockquote after a canonicalized line:

> m * n
>
> ~~~
> quoted tilde content
> ~~~

Final paragraph.
