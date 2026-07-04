# Math variants

A one-line block on its own: $$x$$

Currency stays text: it costs $5 and $10 total.

An escaped dollar sign \$ is literal, not math.

Inline `$x$` inside a code span stays code, and `$5 and $10` too.

A real inline formula $a^2 + b^2 = c^2$ sits in prose.

- A list item with $\alpha + \beta$ inline math.
- Another item.

> A blockquote with $\gamma$ inside it.

Empty block below:

$$

$$

Multi-line block math:

$$
\begin{aligned}
a &= b + c \\
d &= e - f
\end{aligned}
$$

End of file.
