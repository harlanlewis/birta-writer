# Fence and rule edge shapes

Round-trip shapes from the MAR-161 adversarial review: constructs whose
bytes coincide across classes, and blank-sensitive glue.

~~~python
tilde = "fence"
~~~

| a | b |
| --- | --- |
| c | d |
---

> quoted line
---

- list item
---

```
fence content that looks like prose
```
    indented code glued to the fence close

A paragraph directly above a dash run makes a setext heading
------

Tail prose after every edge shape.
