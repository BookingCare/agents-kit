---
name: review-pr-local
specializes: review-pr
description: Repo-specific review guidance for agents-kit. Only the categories declared overridable by the core review-pr skill may be specialized here.
---

# Repo-specific review guidance for `agents-kit`

This file is a companion to the core `review-pr` skill. It does not
redefine the review output schema, severity labels, safety rules, or
evidence rules. It only specializes the override categories the core
skill marks as overridable.

## Project context

`agents-kit` is a pnpm/Turborepo monorepo at `BookingCare/agents-kit`.
The project uses TypeScript, pnpm workspaces, and Turborepo for builds.
Reviewers should account for monorepo-specific concerns (workspace
dependencies, shared tsconfig, turbo pipeline caching).

## User-facing strings

- Flag interpolated text that would read unnaturally at runtime (e.g. wrong casing after a sentence fragment like "The triage concluded that {summary}").
- Link text should be descriptive and relevant to this project, not bare URLs or generic "click here" labels.
- Verify that terminology is consistent across related messages in the same PR.

## Monorepo-specific checks

- When a PR changes a shared package under `packages/`, verify that downstream consumers under `apps/` won't break.
- Changes to `packages/tsconfig/` affect all workspaces — flag any breaking config changes.
- Verify `turbo.json` pipeline changes don't break the build graph.
- Check that new workspace dependencies are added via `pnpm add --filter` rather than editing `package.json` manually.

## Build and validation

- Ensure `pnpm build`, `pnpm lint`, `pnpm type-check`, and `pnpm test` all pass.
- New packages or apps must be added to `pnpm-workspace.yaml` if they follow the standard structure.

## Graceful degradation

- When code renders optional dynamic data (URLs, metadata), flag cases where a missing value would produce empty or broken output. The fix is usually to omit the element entirely and show a short fallback message.
- Prefer starting with generic, user-safe error messages over exposing internal details.

## Debugging and observability

- Do not suggest removing debugging context from error paths. These are valuable for post-incident investigation even when the operation failed.
