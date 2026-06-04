# Releasing

Agents Kit uses lockstep package versions: every package under `packages/` ships with the same version.

## Version selection

- `patch`: bug fixes and additive changes
- `minor`: breaking changes
- No major releases are used

## Preflight

Before preparing a release, verify local auth and release state:

```bash
npm whoami
pnpm release:preflight
```

`pnpm release:preflight` is safe: it does not publish, push, tag, or create GitHub releases. It checks that package versions are lockstep, npm auth works, the target version is not already published, no matching git tag or GitHub release exists, and `pnpm build` / `pnpm check` pass.

For a quick non-build validation while iterating on release metadata:

```bash
pnpm release:preflight -- --skip-build --skip-check
```

## Prepare the release PR

Repository rules require changes to `main` through a pull request.

1. Create a release branch:

   ```bash
   git switch -c release/vX.Y.Z origin/main
   ```

2. Bump package versions:

   ```bash
   pnpm release:patch # fixes and additions
   pnpm release:minor # breaking changes
   ```

3. Update the lockfile after dependency ranges change:

   ```bash
   pnpm install --lockfile-only --link-workspace-packages=true
   ```

4. Move each package changelog's `## [Unreleased]` content into `## [X.Y.Z] - YYYY-MM-DD`, then add a new empty `## [Unreleased]` section above it.

5. Verify:

   ```bash
   pnpm build
   pnpm check
   node scripts/publish-packages.mjs --dry-run
   ```

6. Commit only the release files you changed and open a PR.

## Publish to npm

After the release PR is approved and merged, publish the packages from the merged release commit:

```bash
node scripts/publish-packages.mjs
```

If npm requires 2FA, either use an npm granular token with publish access and 2FA bypass or pass a current OTP to each `npm publish` command.

Verify published versions:

```bash
npm view @bookingcare/ai@X.Y.Z version
npm view @bookingcare/infra@X.Y.Z version
npm view @bookingcare/agent@X.Y.Z version
```

## Create the GitHub release

After npm publish succeeds and the release commit is on `main`:

```bash
git tag vX.Y.Z <release-commit>
git push origin vX.Y.Z
gh release create vX.Y.Z --title vX.Y.Z --generate-notes --verify-tag
```

Verify the release:

```bash
gh release view vX.Y.Z --json tagName,url,isDraft,isPrerelease,publishedAt
```
