---
name: dedupe-issue-local
specializes: dedupe-issue
description: Repo-specific dedupe guidance for agents-kit. Only the categories declared overridable by the core dedupe-issue skill may be specialized here.
---

# Repo-specific dedupe guidance for `agents-kit`

This file is a companion to the core `dedupe-issue` skill. It does not
redefine the duplicate-detection algorithm, the similarity thresholds,
or the output contract. It only specializes the override categories the
core skill marks as overridable.

## Project context

`agents-kit` is a pnpm/Turborepo monorepo at `BookingCare/agents-kit`.
It contains shared TypeScript packages and applications. When evaluating
duplicate issues, consider that similar problems may manifest across
different packages or apps with the same root cause.

## Known-duplicate clusters

No known-duplicate clusters have been captured for this repository yet.
The weekly `update-dedupe` loop will propose additions here over time
when maintainers repeatedly close issues as duplicates of the same
canonical thread.
