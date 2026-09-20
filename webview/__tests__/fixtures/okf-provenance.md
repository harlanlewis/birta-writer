---
type: reference
title: GA4 dimension catalogue
description: What each exported dimension means, and where it came from.
resource: https://example.com/catalogues/ga4-dimensions
tags: [analytics, ga4, reference]
status: stable
stale_after: 2026-03-12T00:00:00Z
generated:
  by: gemini/2.5-pro
  at: 2026-02-01T09:00:00Z
verified:
  - { by: human:ahormati, at: 2026-02-10T09:00:00Z }
  - { by: process:finance-nightly, at: 2026-02-11T02:00:00Z }
sources:
  - id: ga4-schema
    resource: https://developers.google.com/analytics/bigquery/export-schema
    title: GA4 BigQuery Export schema
    author: team:ga4-docs
    usage_count: 5000
    last_modified: 2026-01-30T00:00:00Z
  - id: finance-handbook
    resource: references/finance.md
not_in_the_spec: a field no version of OKF defines, kept because nothing may reject it
---

# GA4 dimension catalogue

Every field above belongs to the Open Knowledge Format, apart from the last
one, which is here because the spec forbids rejecting a document over a field
a reader does not know.

Nothing in this editor writes to that block. The body is ordinary Markdown, so
the corpus invariants read it the way they read any other document.

| Dimension | Scope | Notes |
| --- | --- | --- |
| `session_source` | session | First non-direct source |
| `item_brand` | item | Empty on non-commerce events |
