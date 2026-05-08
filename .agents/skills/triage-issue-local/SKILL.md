---
name: triage-issue-local
specializes: triage-issue
description: Repo-specific triage guidance for agents-kit. Only the categories declared overridable by the core triage-issue skill may be specialized here.
---

# Repo-specific triage guidance for `agents-kit`

This file is a companion to the core `triage-issue` skill. It does not
redefine the triage output schema, safety rules, or follow-up-question
contract. It only specializes the override categories the core skill
marks as overridable.

## Project context

`agents-kit` is a pnpm/Turborepo monorepo at `BookingCare/agents-kit`
with shared TypeScript packages and applications. Issues may span
multiple workspaces or relate to shared configuration.

## Heuristics

- Distinguish observed symptoms from reporter hypotheses and proposed fixes.
- Before asking any follow-up question, first try to answer it yourself through code inspection, documentation lookup, or web search. Only ask questions that you cannot resolve on your own and that only the reporter would know.
- Ask targeted follow-up questions only for details the agent cannot derive itself and that materially improve triage confidence.
- Prefer issue-specific questions over generic "please share more info" requests.

## Label taxonomy

The label taxonomy for this repository is managed in `.github/issue-triage/config.json`. Prefer labels from that configuration, and avoid inventing new labels unless the prompt explicitly allows it.

## Recurring follow-up patterns

No repo-specific follow-up patterns have been captured for this repository yet. `agents-kit` is a monorepo build toolchain, so follow-up questions should focus on TypeScript/pnpm/Turborepo environment details, specific workspace behavior, and build configuration. The weekly `update-triage` loop will propose additions as maintainer overrides reveal recurring patterns that are actually specific to this repository.

## Owner-inference hints

No repo-specific owner-inference hints beyond `.github/STAKEHOLDERS` have been captured yet.
