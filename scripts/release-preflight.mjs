#!/usr/bin/env node
/**
 * Safe release preflight checks. This script does not publish, push, tag, or
 * create GitHub releases.
 *
 * Usage:
 *   node scripts/release-preflight.mjs [--skip-build] [--skip-check]
 */

import { execFileSync } from "child_process";
import { existsSync, readFileSync, readdirSync } from "fs";
import { join } from "path";

const args = new Set(process.argv.slice(2));
const skipBuild = args.has("--skip-build");
const skipCheck = args.has("--skip-check");

const failures = [];

function run(command, commandArgs, options = {}) {
  const printable = [command, ...commandArgs].join(" ");
  if (!options.silent) {
    console.log(`$ ${printable}`);
  }

  try {
    return execFileSync(command, commandArgs, {
      encoding: "utf-8",
      stdio: options.silent ? "pipe" : "inherit",
    });
  } catch (error) {
    if (options.ignoreError) {
      return null;
    }
    throw error;
  }
}

function check(label, fn) {
  try {
    fn();
    console.log(`ok - ${label}`);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    failures.push(`${label}: ${message}`);
    console.error(`fail - ${label}`);
    console.error(`  ${message}`);
  }
}

function readPackageJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function getWorkspacePackages() {
  const packagesDir = join(process.cwd(), "packages");
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packageJsonPath = join(packagesDir, entry.name, "package.json");
      if (!existsSync(packageJsonPath)) {
        return null;
      }
      return {
        dir: join(packagesDir, entry.name),
        packageJsonPath,
        packageJson: readPackageJson(packageJsonPath),
      };
    })
    .filter((entry) => entry !== null);
}

function getReleaseVersion(packages) {
  const versions = new Set(packages.map((entry) => entry.packageJson.version));
  if (versions.size !== 1) {
    throw new Error(`Workspace packages are not lockstep: ${[...versions].sort().join(", ")}`);
  }
  return [...versions][0];
}

function assertCommandOutputEmpty(command, commandArgs, label) {
  const output = run(command, commandArgs, { silent: true });
  if (output.trim()) {
    throw new Error(`${label}: ${output.trim()}`);
  }
}

const packages = getWorkspacePackages();
const publishablePackages = packages.filter((entry) => !entry.packageJson.private);
let releaseVersion;

console.log("\n=== Release Preflight ===\n");

check("workspace package versions are lockstep", () => {
  releaseVersion = getReleaseVersion(packages);
  console.log(`release version: ${releaseVersion}`);
});

check("working tree is clean", () => {
  assertCommandOutputEmpty("git", ["status", "--porcelain"], "Uncommitted changes detected");
});

check("npm authentication is available", () => {
  const user = run("npm", ["whoami"], { silent: true }).trim();
  if (!user) {
    throw new Error("npm whoami returned no user");
  }
  console.log(`npm user: ${user}`);
});

check("publishable package versions are not already on npm", () => {
  for (const entry of publishablePackages) {
    const packageName = entry.packageJson.name;
    const publishedVersion = run("npm", ["view", `${packageName}@${releaseVersion}`, "version"], {
      silent: true,
      ignoreError: true,
    });
    if (publishedVersion?.trim() === releaseVersion) {
      throw new Error(`${packageName}@${releaseVersion} is already published`);
    }
    console.log(`not published: ${packageName}@${releaseVersion}`);
  }
});

check("release tag and GitHub release do not already exist", () => {
  const tag = `v${releaseVersion}`;
  const localTag = run("git", ["tag", "--list", tag], { silent: true }).trim();
  if (localTag) {
    throw new Error(`Local tag already exists: ${tag}`);
  }

  const remoteTag = run("git", ["ls-remote", "--tags", "origin", tag], { silent: true }).trim();
  if (remoteTag) {
    throw new Error(`Remote tag already exists: ${tag}`);
  }

  const release = run("gh", ["release", "view", tag, "--json", "url"], {
    silent: true,
    ignoreError: true,
  });
  if (release?.trim()) {
    throw new Error(`GitHub release already exists: ${tag}`);
  }
});

if (!skipBuild) {
  check("build passes", () => {
    run("pnpm", ["build"]);
  });
}

if (!skipCheck) {
  check("check passes", () => {
    run("pnpm", ["check"]);
  });
}

if (failures.length > 0) {
  console.error("\nRelease preflight failed:");
  for (const failure of failures) {
    console.error(`- ${failure}`);
  }
  process.exit(1);
}

console.log("\nRelease preflight passed.");
