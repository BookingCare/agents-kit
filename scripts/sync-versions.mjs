#!/usr/bin/env node

/**
 * Syncs all workspace package dependency versions to match their current versions.
 * This ensures lockstep versioning across the monorepo.
 */

import { existsSync, readFileSync, readdirSync, writeFileSync } from "fs";
import { join } from "path";

const packagesDir = join(process.cwd(), "packages");
const packageDirs = readdirSync(packagesDir, { withFileTypes: true })
  .filter((dirent) => dirent.isDirectory())
  .map((dirent) => ({
    name: dirent.name,
    packageJsonPath: join(packagesDir, dirent.name, "package.json"),
  }))
  .filter((entry) => existsSync(entry.packageJsonPath));

// Read all package.json files and build version map
const packages = {};
const versionMap = {};

for (const dir of packageDirs) {
  try {
    const pkg = JSON.parse(readFileSync(dir.packageJsonPath, "utf8"));
    packages[dir.name] = { path: dir.packageJsonPath, data: pkg };
    versionMap[pkg.name] = pkg.version;
  } catch (e) {
    console.error(`Failed to read ${dir.packageJsonPath}:`, e.message);
  }
}

console.log("Current versions:");
for (const [name, version] of Object.entries(versionMap).sort()) {
  console.log(`  ${name}: ${version}`);
}

// Verify all versions are the same (lockstep)
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

// Update all inter-package dependencies
let totalUpdates = 0;
for (const pkg of Object.values(packages)) {
  let updated = false;

  // Check dependencies
  if (pkg.data.dependencies) {
    for (const [depName, currentVersion] of Object.entries(pkg.data.dependencies)) {
      if (versionMap[depName]) {
        const newVersion = `^${versionMap[depName]}`;
        if (currentVersion !== newVersion) {
          console.log(`\n${pkg.data.name}:`);
          console.log(`  ${depName}: ${currentVersion} -> ${newVersion}`);
          pkg.data.dependencies[depName] = newVersion;
          updated = true;
          totalUpdates++;
        }
      }
    }
  }

  // Check devDependencies
  if (pkg.data.devDependencies) {
    for (const [depName, currentVersion] of Object.entries(pkg.data.devDependencies)) {
      if (versionMap[depName]) {
        const newVersion = `^${versionMap[depName]}`;
        if (currentVersion !== newVersion) {
          console.log(`\n${pkg.data.name}:`);
          console.log(`  ${depName}: ${currentVersion} -> ${newVersion} (devDependencies)`);
          pkg.data.devDependencies[depName] = newVersion;
          updated = true;
          totalUpdates++;
        }
      }
    }
  }

  // Write if updated
  if (updated) {
    writeFileSync(pkg.path, JSON.stringify(pkg.data, null, "\t") + "\n");
  }
}

if (totalUpdates === 0) {
  console.log("\nAll inter-package dependencies already in sync.");
} else {
  console.log(`\nUpdated ${totalUpdates} dependency version(s)`);
}
