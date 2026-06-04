# Developement Rules

## Conversational Style

- Keep answers short and concise
- No emojis in commits, issues, PR comments, or code
- No fluff or cheerful filler text
- Technical prose only, be kind but direct (e.g., "Thanks @user" not "Thanks so much @user!")

## Code Quality

- Read files in full before making wide-ranging changes, before editing files you have not already fully inspected, and when the user asks you to investigate or audit something. Do not rely only on search snippets for broad changes.
- No `any` types unless absolutely necessary
- Check node_modules for external API type definitions instead guessing
- **NEVER use inline imports** - no `await import("./foo.js")`, no `import("pkg").Type` in type positions, no dynamic import of types. Always use standard top-level imports.
- NEVER remove or downgrade code to fix type errors from outdated dependencies; upgrade the dependency instead
- Always ask before remove functionality or code that appears to be intentional
- Do not preserve backward compatibility unless the user explicitly asks for it

## Commands

- After code changes (not documentation changes): `pnpm check` (get full output, no tail). fix all errors, warnings, and infos before committings.
- Note: `pnpm check` does not run tests.
- NEVER run: `pnpm dev`, `pnpm build`, `pnpm test`
- Only run specific tests if user instructs: `npx vitest run test/specific.test.ts` (from package root)
- Run tests from package root, not the repo root.
- If you create or modify a test file, you MUST run that test file and iterate until it passes.
- When writing tests, run them, indentify issues in either the test or implementation, and iterate until fixed.
- NEVER commit unless user asks

## Contribution Gate

When creating issues:

- Add `pkg:*` labels to indicate which package(s) the issue affects
  - Available labels: `pkg:agent`, `pkg:ai`, `pkg:ui`, etc...
- If an issue spans multiple packages, add all relevant labels

When posting issue/PR comments:

- Write the full comment to temp file and use `gh issue comment --body-file` or `gh pr comment --body-file`
- Never pass multi-line markdown directly via `--body` in shell commands
- Preview the axact comment text before posting
- Post exactly one final comment unless the user explicitly asks for multiple comments
- If a comment is malformed, delete it immediately, then post one corrected comment
- Keep comments concise, technical, and in the user's tone

When closing issues via commit:

- Include `fixes #<number>` or `closes #<number>` in the commit message
- This automatically closes the issue when the commit is merged

## Spec-Driven Implementation Workflow

When working on features that have product/tech specs, follow this lifecycle:

### Workflow Sequence

1. **Issue Opening** → Issue created with feature request
2. **Spec Creation** → Product spec (and tech spec if needed) created in `specs/`
3. **Spec Review** → Spec PR opened for review
4. **Spec Approval** → Spec merged, issue labeled `ready to implement`
5. **Implementation** → Implementation PR opened (issue **remains open**)
6. **Implementation Review** → Implementation reviewed and adjusted
7. **Implementation Merge** → Implementation merged into main
8. **Issue Closure** → Issue closed via `fixes #N` or `closes #N` in commit message

### Key Points

- **NEVER close the issue after spec approval** — the issue tracks implementation status
- **Label change, not issue closure** — When spec is approved, change issue label to `ready to implement`
- **Implementation PR targets feature branch** — Work on feature branch until user approves, then merge to main
- **Close issue via commit message** — The final implementation merge commit must include `fixes #N` or `closes #N`

### When to Use This Workflow

- Significant user-facing features
- Architecture changes
- Features requiring product and technical specification
- Any feature where the user explicitly requests a spec-first approach

## PR Workflow

- Analyze PRs without pulling locally first
- If the user approves: create a feature branch, pull PR, rebase on main, apply adjustments, commit, merge into main, pust, close PR, and leave a comment in the user's tone
- You never open PRs yourself. We work in feature branches until everything is according to the user's requirements, then merge into main, and push.

## Changelog

Location: `packages/*/CHANGELOG.md` (each package has its own)

### Format

Use these sections under `## [Unreleased]`:

- `### Breaking Changes` - API changes requiring migration
- `### Added` - New features
- `### Changed` - Changes to existing functionality
- `### Fixed` - Bug fixes
- `### Removed` - Removed features

### Rules

- Before adding entries, read the full `[Unreleased]` section to see which subsections already exist
- New entries ALWAYS go under `## [Unreleased]` section
- Append to existing subsections (e.g., `### Fixed`), do not create duplicates
- NEVER modify already-released version sections (e.g., `## [0.12.2]`)
- Each version section is immutable once released

### Attribution

- **Internal changes (from issues)**: `Fixed foo bar ([#123](https://github.com/BookingCare/agents-kit/issues/12))`
- **External contributions**: `Added feature X ([#456](https://github.com/BookingCare/agents-kit/pull/456)) by [@username](https://github.com/username)`

## Adding a New LLM provider (packages/ai)

### Architecture: Model-Context-Options Pattern

All public streaming functions follow the same 3-argument pattern:

```typescript
function stream<TApi extends Api>(
  model: Model<TApi>,
  context: Context, // { messages, tools? }
  options?: StreamOptions, // transport-level: temperature, maxTokens, signal, apiKey, etc.
): AssistantMessageEventStream;
```

- **`Model<TApi>`** — typed model object from the model registry. Carries API type, provider, base URL, pricing, and compat overrides. The provider is resolved from `model.api`.
- **`Context`** — content-level: `{ messages: Message[]; tools?: ToolDefinition[] }`. Separates what is being asked from how it is transported.
- **`StreamOptions`** — transport-level control: temperature, maxTokens, topP, stopSequences, signal, apiKey, transport, cacheRetention, sessionId, onPayload, onResponse, headers, timeoutMs, maxRetries, maxRetryDelayMs, metadata.

Providers implement the `ProviderApi` interface and are registered by API type (not provider name). One provider can serve multiple API types.

### 1. Core Types (`packages/ai/src/types.ts`)

- Add API identifier to `KnownApi` type union (e.g., `"bedrock-converse-stream"`)
- Create options interface extending `StreamOptions`
- Add mapping to `ApiOptionsMap`
- Add provider name to `knownProvider` type union

### 2. Provider Implementation (`packages/ai/src/providers/`)

Create provider file exporting a `ProviderApi` object:

```typescript
export const myProvider: ProviderApi = {
  stream<TApi extends Api>(model, context, options?) { ... },
  streamSimple<TApi extends Api>(model, context, options?) { ... },  // often delegates to stream
};
```

Include message/tool conversion functions and response parsing that emits standardized events (`text`, `tool_call`, `thinking`, `usage`, `stop`).

### 3. Provider Registration

- Register the provider in `packages/ai/src/providers/register-builtins.ts` by API type:
  ```typescript
  registerProvider("my-api-type", myProvider);
  ```
- Add credential detection in `packages/ai/src/utils/env-api-keys.ts`
- Add a package subpath export in `packages/ai/package.json` pointing at `./dist/providers/<provider>.js`

### 4. Model Generation (`packages/ai/scripts/generate-models.ts`)

- Add logic to fetch/parse models from provider source
- Map to standardized `Model` interface

### 5. Tests (`packages/ai/test/`)

- Always add the provider to `stream.test.ts` with at least one representative model, even if it reuses an existing API implementation such as `openai-completions`.
- Add the provider to the broader provider matrix where applicable: `tokens.test.ts`, `abort.test.ts`, `empty.test.ts`, `context-overflow.test.ts`, `image-limits.test.ts`, `unicode-surrogate.test.ts`, `tool-call-without-result.test.ts`, `image-tool-result.test.ts`, `total-tokens.test.ts`, `cross-provider-handoff.test.ts`.
- For `cross-provider-handoff.test.ts`, add at least one provider/model pair. If the provider exposes multiple model families (for example GPT and Claude), add at least one pair per family.
- For non-standard auth, create utility (e.g., `bedrock-utils.ts`) with credential detection.

### 6. Documentation

- `packages/ai/README.md`: Add to providers table, document options/auth, add env vars
- `packages/ai/CHANGELOG.md`: Add entry under `## [Unreleased]`

## Releasing

**Lockstep versioning**: All packages always share the same version number. Every release updates all packages together.

**Version semantics** (no major releases):

- `patch`: Bug fixes and new features
- `minor`: API breaking changes

Repository rules require release changes to reach `main` through a PR. Do not push release commits directly to `main`.

### Steps

1. **Preflight**: Run `npm whoami` and `pnpm release:preflight` before publishing. The preflight script is safe: it does not publish, push, tag, or create GitHub releases.

2. **Prepare release branch**: Create `release/vX.Y.Z` from `origin/main`.

3. **Bump versions**:

   ```
   pnpm release:patch # Fixes and additions
   pnpm release:minor # API breaking changes
   pnpm install --lockfile-only --link-workspace-packages=true
   ```

4. **Update CHANGELOGs**: Move each package's `[Unreleased]` content into `## [X.Y.Z] - YYYY-MM-DD`, then add a new empty `[Unreleased]` section above it.

5. **Verify and open PR**: Run `pnpm build`, `pnpm check`, and `node scripts/publish-packages.mjs --dry-run`, then open a release PR.

6. **Publish after merge**: After the PR is merged, publish from the merged release commit with `node scripts/publish-packages.mjs`.

7. **Create GitHub release**: Tag the release commit, push `vX.Y.Z`, then run `gh release create vX.Y.Z --title vX.Y.Z --generate-notes --verify-tag`.

See `docs/releasing.md` for the full maintainer checklist.

## **CRITICAL** Git Rules for Parallell Agents **CRITICAL**

Multiple agents may work on different files in the same worktree simultaneously. You MUST follow these rules:

### Committing

- **ONLY commit files YOU changed in THIS session**
- When creating a PR, commit to a feature branch — never commit directly to main if the target is a PR
- ALWAYS include `fixes #<number>` or `closes #<number>` in the commit message when there is a related issue or PR
- NEVER use `git add -A` or `git add .` - these sweep up changes from other agents
- ALWAYS use `git add <specific-file-paths>` listing only files you modified
- Before committing, run `git status` and verify you are only staging YOUR files
- Track which files you created/modified/deleted during the session
- It is always fine to include `packages/ai/src/models.generated.ts` in a commit alongside the actual files you want to commit

### Forbidden Git Operations

These commands can destroy other agents' work:

- `git reset --hard` - destroys uncommitted changes
- `git checkout .` - destroys uncommitted changes
- `git clean -fd` - deletes untracked files
- `git stash` - stashes ALL changes including other agents' work
- `git add -A` / `git add .` - stages other agents' uncommitted work
- `git commit --no-verify` - bypasses required checks and is never allowed

### Safe Workflow

```bash
# 1. Check status first
git status

# 2. Add ONLY your specific files
git add packages/ai/src/providers/transform-messages.ts
git add packages/ai/CHANGELOG.md

# 3. Commit
git commit -m "fix(ai): description"

# 4. Push (pull --rebase if needed, but NEVER reset/checkout)
git pull --rebase && git push
```

### If Rebase Conflicts Occur

- Resolve conflicts in YOUR files only
- If conflict is in a file you didn't modify, abort and ask the user
- NEVER force push

### User override

If the user instructions conflict with rules set out here, ask for confirmation that they want to override the rules. Only then execute their instructions.
