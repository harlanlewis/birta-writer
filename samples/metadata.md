---
title: Metadata panel sample
description: Every shape the metadata panel renders natively, in one block.
status: stable
tags: [reference, metadata]
contributors:
  - alice
  - bruno
sources:
  - id: ga4-schema
    resource: https://developers.google.com/analytics/bigquery/export-schema
    title: GA4 BigQuery Export schema
    author: team:ga4-docs
    usage_count: 5000
  - id: finance-handbook
    resource: references/finance.md
reviewers:
- id: ahormati
  role: owner
- id: nightly
  role: process
usage_window: { from: 2026-06-01T00:00:00Z, to: 2026-06-30T00:00:00Z }
verified:
  - { by: human:ahormati, at: 2026-06-25T09:00:00Z }
  - { by: process:finance-nightly, at: 2026-06-26T02:00:00Z }
executor:
  resource: references/skills/run-on-bq.md
  receipt: [job_id, executed_sql, result]
---

# Metadata panel sample

Open this file and look at the panel above. Everything in its frontmatter is
rendered as fields, not as a raw YAML box. Nothing below the fence matters; the
file exists for the block at the top of it.

## What each field is for

| Field | Shape | What it exercises |
|---|---|---|
| `title`, `description`, `status` | plain scalars | the ordinary key/value rows |
| `tags` | inline flow sequence | the chip list, on one line |
| `contributors` | block sequence of strings | the chip list, over several lines |
| `sources` | sequence of mappings, indented | labelled groups, one per entry |
| `reviewers` | sequence of mappings, at the key's own column | the other spelling of the same thing |
| `usage_window` | one-line flow mapping | a group whose pairs share the key's line |
| `verified` | sequence of flow mappings | one group per line |
| `executor` | nested mapping | a single group, no entry controls |

## What to try

Edit a value in one of the groups and save. Only that value's line changes;
every other byte of the block is the one that was there before, including the
two different indentations `sources` and `reviewers` are written in.

Use Add entry under `sources` to add a record. The draft is not written to the
file until every one of its fields has a value, and clicking away from a
half-filled one leaves the file untouched.

Type a colon and a space into any value, such as `Note: see below`. It is
written back quoted, because unquoted it would spell a second mapping and no
YAML parser would read the file.

Delete one of the `sources` entries with the button beside it. The field stays
where its author put it rather than moving to the bottom of the block.
