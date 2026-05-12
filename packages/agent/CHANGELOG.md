# Changelog

## [Unreleased]

### Added

- `load_skill` tool for on-demand skill loading via `tool_result`
- `SkillLoader` class that scans a directory for `SKILL.md` files with YAML frontmatter
- Two-layer skill injection: names+descriptions in system prompt, full body on demand
- `skillsDir` option on `AgentLoopOptions` and `createToolDispatch()`
- `src/types.ts` — centralized type definitions
