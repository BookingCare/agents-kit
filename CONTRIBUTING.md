# Contributing to Agents Kit

Thanks for helping improve Agents Kit! This guide explains how to open issues, propose changes, and get your work reviewed.

## TL;DR

- Bug fixes are welcome for any triaged issue. All confirmed bugs are implicitly `ready-to-implement`.
- Feature requests must be marked `ready-to-spec` or `ready-to-implement` before PRs are accepted.
- Specs are where technical and design discussion on larger features happen.

## How Contributing Works

### Issues are the starting point for everything

Discussion, scoping, and design happen on the issue before any PR is opened. Do not open a PR without a linked issue.

### Feature requests differ from bug fixes

- **Features** are gated by readiness labels — `ready-to-spec`, then `ready-to-implement` once the design is settled. Discussion alone is not approval to begin work.
- Feature work needs a written spec first: a _product spec_ + _tech spec_ committed under `specs/` before any code is written.
- **Bug fixes** skip both steps. Once triaged as a bug, the issue is implicitly `ready-to-implement`.

### Readiness labels

| Label                | Meaning                                     | Who can pick it up            |
| -------------------- | ------------------------------------------- | ----------------------------- |
| `ready-to-spec`      | Problem understood, design is open          | Contributors — open a spec PR |
| `ready-to-implement` | Design settled                              | Contributors — open a code PR |
| `needs-mocks`        | Design mocks required before implementation | Wait for maintainers          |

Anyone can pick up a ready issue — readiness labels are not assignments. If an issue has been sitting un-triaged, mention **@maintainers** in a comment.

## Contribution Flow

```
File an issue → Maintainers triage
  ├── ready-to-spec (features) → Open spec PR → Specs approved → Open code PR
  ├── needs-mocks → Design mocks produced → Open code PR
  └── ready-to-implement (incl. all triaged bugs) → Open code PR → Review → CI → merge
```

## Filing a Good Issue

Search [existing issues](https://github.com/BookingCare/agents-kit/issues) before filing to avoid duplicates. Use the issue templates.

### Bug reports

A good bug report includes:

- A clear title and one-paragraph summary of the problem.
- Steps to reproduce (minimal example where possible).
- Expected vs. actual behavior.
- Version and environment details.
- Logs, screenshots, or screen recordings when relevant.

Once triaged as a bug, it is implicitly **`ready-to-implement`** — pick it up and open a PR.

### Feature requests

A good feature request describes the user-facing problem before any proposed implementation. Include:

- The user need or pain point, and who experiences it.
- Current behavior and why it falls short.
- A sketch of the desired behavior or workflow.
- Any relevant constraints (compatibility, related features, prior art).

Feature requests go through the spec flow: a maintainer applies `ready-to-spec` when the problem is understood and the design is open.

## Opening a Spec PR

Issues labeled `ready-to-spec` need a spec before code begins. A spec consists of two documents under `specs/GH<issue-number>/`:

- **`product.md`** — The desired behavior from the user's perspective. The core is a numbered list of **testable behavior invariants** covering the happy path, edge cases, and error states. Optional sections: problem statement, goals / non-goals, open questions.
- **`tech.md`** — The implementation plan. Required sections: **Context** (current system and relevant files), **Proposed changes** (modules touched, new types / APIs, data flow, tradeoffs), and **Testing and validation** (how each invariant from the product spec will be verified).

To open a spec PR:

1. Add `specs/GH<issue-number>/product.md` and `specs/GH<issue-number>/tech.md`.
2. Use the PR as the home for product and technical discussion.
3. Once approved, implementation generally continues on the same PR.

## Opening a Code PR

For issues labeled `ready-to-implement` (includes any triaged bug):

1. Branch from `main` with a descriptive name (e.g. `your-handle/fix-parser`).
2. Implement the change and add tests.
3. Run `pnpm build && pnpm lint && pnpm test && pnpm type-check` and fix failures before pushing.
4. Open a PR and link the issue.
5. Keep the PR focused on a single logical change.

## Development Setup

```bash
pnpm install              # Install all dependencies
pnpm dev                  # Start all apps in dev mode
pnpm build                # Build all packages and apps
pnpm lint                 # Lint everything
pnpm test                 # Run all tests
pnpm type-check           # Type-check everything
pnpm clean                # Remove all build artifacts and node_modules
```

See [README.md](README.md) for the full guide.

## Testing

Tests are required for most code changes:

- **Bug fixes** should include a regression test that would have caught the bug.
- **Algorithmic or non-trivial logic** needs unit tests.
- **User-facing flows** should have integration tests when the behavior can be exercised that way.

## Code Style

- `pnpm lint` and `pnpm type-check` must pass.
- Follow existing patterns in the codebase.
- Commit messages should explain _what_ and _why_.

## Commit and Branch Conventions

- Branch names should be descriptive and scoped (e.g. `alice/fix-auth-flow`, `bob/add-user-types`).
- Commits should be atomic and self-contained.
- Keep PRs small and focused — one logical change per PR.

## Reporting Security Issues

Do not open public issues for security vulnerabilities. Report them privately to the maintainers.

## Getting Help

- Open a [GitHub issue](https://github.com/BookingCare/agents-kit/issues) for bugs or feature requests.
