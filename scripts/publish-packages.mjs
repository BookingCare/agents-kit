#!/usr/bin/env node

import { execSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const DRY_RUN = process.argv.includes("--dry-run");

function run(command, options = {}) {
  console.log(`$ ${command}`);
  return execSync(command, {
    encoding: "utf-8",
    stdio: options.silent ? "pipe" : "inherit",
    cwd: options.cwd,
    ...options,
  });
}

function readPackageJson(path) {
  return JSON.parse(readFileSync(path, "utf-8"));
}

function getWorkspacePackages() {
  const packagesDir = join(process.cwd(), "packages");
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => {
      const packageDir = join(packagesDir, entry.name);
      const packageJsonPath = join(packageDir, "package.json");
      if (!existsSync(packageJsonPath)) {
        return null;
      }

      return {
        dir: packageDir,
        packageJsonPath,
        packageJson: readPackageJson(packageJsonPath),
      };
    })
    .filter((entry) => entry !== null);
}

function getDependencyNames(packageJson) {
  const dependencySets = [
    packageJson.dependencies,
    packageJson.peerDependencies,
    packageJson.optionalDependencies,
  ];

  const names = new Set();
  for (const dependencies of dependencySets) {
    if (!dependencies) {
      continue;
    }

    for (const name of Object.keys(dependencies)) {
      names.add(name);
    }
  }

  return [...names];
}

function topologicallySortPackages(packages) {
  const packageByName = new Map(packages.map((entry) => [entry.packageJson.name, entry]));
  const state = new Map();
  const ordered = [];

  const visit = (entry) => {
    const currentState = state.get(entry.packageJson.name);
    if (currentState === "visiting") {
      throw new Error(`Dependency cycle detected while ordering ${entry.packageJson.name}`);
    }
    if (currentState === "visited") {
      return;
    }

    state.set(entry.packageJson.name, "visiting");
    for (const dependencyName of getDependencyNames(entry.packageJson)) {
      const dependency = packageByName.get(dependencyName);
      if (dependency) {
        visit(dependency);
      }
    }
    state.set(entry.packageJson.name, "visited");
    ordered.push(entry);
  };

  for (const entry of packages) {
    visit(entry);
  }

  return ordered;
}

function publishPackages() {
  const packages = getWorkspacePackages().filter((entry) => !entry.packageJson.private);
  const ordered = topologicallySortPackages(packages);

  console.log("Publishing packages in order:");
  for (const entry of ordered) {
    console.log(`  - ${entry.packageJson.name}@${entry.packageJson.version}`);
  }
  console.log();

  for (const entry of ordered) {
    const command = ["npm publish", "--access public", "--no-git-checks"];
    if (DRY_RUN) {
      command.push("--dry-run");
    }

    run(command.join(" "), { cwd: entry.dir });
  }
}

publishPackages();
