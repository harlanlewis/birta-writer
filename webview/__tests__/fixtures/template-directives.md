# Template directives

Spans that static-site generators and docs tools expand before Markdown, held to the round trip byte for byte. The editor draws them as source and never runs them.

## Hugo shortcodes

{{< shots >}}
![A box](years-on-a-box.webp)
![A paperclip](paperclip.webp)
{{< /shots >}}

{{% notice tip %}}
Markdown inside a percent shortcode is rendered by Hugo.
{{% /notice %}}

{{<figure src="elephant.png" title="An elephant">}}

{{< youtube id="w7Ft2ymGmfc" autoplay="true" >}}

An inline one {{< ref "other-page.md" >}} mid-sentence, and an escaped one {{</* ref "x" */>}}.

## Liquid, Jekyll, Eleventy

{% include note.html content="This is a note." %}

Welcome to {{ site.title | escape }}, last built {{ site.time | date: "%Y-%m-%d" }}.

{% if page.draft %}
This page is a draft.
{% endif %}

{%- comment -%} Whitespace-trimming tags keep their dashes. {%- endcomment -%}

{% raw %}{{ not expanded }}{% endraw %}

## Jinja and Nunjucks

{# a template comment #}

{% for item in items %}
- {{ item.name }}
{% endfor %}

## Mustache and Handlebars

{{#each people}}
{{{ this.bio }}} by {{> byline }}
{{/each}}

## Not directives

Code is left alone: `{{ code }}` and `{% tag %}` stay inline code.

```liquid
{% assign x = 1 %}
{{ x }}
```

Plain braces in prose: {a, b}, a set {{}}, a JSON object {"a": {"b": 1}}, and {% %} with nothing inside.

A heading can hold one too:

## {{ page.title }}

> A quote with {{ site.author }} in it.

| Key | Value |
| --- | --- |
| title | {{ page.title }} |
