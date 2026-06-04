#!/usr/bin/env node

/**
 * Syncs all workspace package dependency versions to match their current versions.
 * This ensures lockstep versioning across the monorepo.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

function getPackageJsonPaths() {
  const packagesDir = join(process.cwd(), "packages");

  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(packagesDir, entry.name, "package.json"))
    .filter((packageJsonPath) => existsSync(packageJsonPath));
}

function readPackage(packageJsonPath) {
  const data = JSON.parse(readFileSync(packageJsonPath, "utf8"));
  return { path: packageJsonPath, data };
}

function syncDependencySet(packageName, dependencies, dependencyType, versionMap) {
  if (!dependencies) {
    return 0;
  }

  let updates = 0;

  for (const [depName, currentVersion] of Object.entries(dependencies)) {
    const targetVersion = versionMap[depName];
    if (!targetVersion) {
      continue;
    }

    const newVersion = `^${targetVersion}`;
    if (currentVersion === newVersion) {
      continue;
    }

    const suffix = dependencyType === "devDependencies" ? " (devDependencies)" : "";
    console.log(`\n${packageName}:`);
    console.log(`  ${depName}: ${currentVersion} -> ${newVersion}${suffix}`);
    dependencies[depName] = newVersion;
    updates++;
  }

  return updates;
}

const packages = {};
const versionMap = {};

for (const packageJsonPath of getPackageJsonPaths()) {
  try {
    const pkg = readPackage(packageJsonPath);
    packages[pkg.data.name] = pkg;
    versionMap[pkg.data.name] = pkg.data.version;
  } catch (error) {
    console.error(`Failed to read ${packageJsonPath}:`, error.message);
  }
}

console.log("Current versions:");
for (const [name, version] of Object.entries(versionMap).sort()) {
  console.log(`  ${name}: ${version}`);
}

const versions = new Set(Object.values(versionMap));
if (versions.size > 1) {
  console.error("\nERROR: Not all packages have the same version.");
  console.error("Expected lockstep versioning. Run one of:");
  console.error("  pnpm release:patch");
  console.error("  pnpm release:minor");
  console.error("  pnpm release:major");
  process.exit(1);
}

console.log("\nAll packages at same version (lockstep)");

let totalUpdates = 0;
for (const pkg of Object.values(packages)) {
  const dependencyUpdates = syncDependencySet(
    pkg.data.name,
    pkg.data.dependencies,
    "dependencies",
    versionMap,
  );
  const devDependencyUpdates = syncDependencySet(
    pkg.data.name,
    pkg.data.devDependencies,
    "devDependencies",
    versionMap,
  );

  const packageUpdates = dependencyUpdates + devDependencyUpdates;
  if (packageUpdates > 0) {
    writeFileSync(pkg.path, JSON.stringify(pkg.data, null, "\t") + "\n");
  }

  totalUpdates += packageUpdates;
}

if (totalUpdates === 0) {
  console.log("\nAll inter-package dependencies already in sync.");
} else {
  console.log(`\nUpdated ${totalUpdates} dependency version(s)`);
}
