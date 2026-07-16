## Introduction {#sec-intro}

Quarto documents mix prose with executable cells. As @knuth1984 argued,
literate programs read as essays [see also @wickham2015, pp. 33-35].

```{r}
#| label: fig-airquality
#| fig-cap: "Temperature and ozone level."
#| echo: false
library(ggplot2)
ggplot(airquality, aes(Temp, Ozone)) + geom_point()
```

@fig-airquality shows the relationship; the method is in @sec-methods.

::: {.callout-note}
Fenced divs with pandoc attribute syntax are not CommonMark; the braces and
classes must survive as written.
:::

::: {#fig-elephants layout-ncol=2}

![Surus](surus.png){#fig-surus}

![Hanno](hanno.png){#fig-hanno}

Famous elephants.
:::

## Methods {#sec-methods}

A shortcode embeds external content:

{{< video https://www.youtube.com/embed/wo9vZccmqwc >}}

And an include pulls in shared text: {{< include _setup.qmd >}}

```{python}
import matplotlib.pyplot as plt
plt.plot([1, 2, 3])
plt.show()
```

Inline code cells work too: the answer is `{r} 6 * 7`.
