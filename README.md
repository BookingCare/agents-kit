# Agents Kit

Monorepo built with **pnpm** workspaces and **Turborepo**.

## Structure

```
agents-kit/
├── apps/           # Applications
├── packages/
│   └── tsconfig/   # Shared TypeScript configs (@repo/tsconfig)
├── turbo.json      # Turborepo pipeline configuration
├── pnpm-workspace.yaml
└── package.json
```

## Getting Started

```bash
pnpm install         # Install all dependencies
pnpm dev             # Start all apps in dev mode
pnpm build           # Build all packages and apps
pnpm lint            # Lint all packages and apps
pnpm test            # Run all tests
pnpm type-check      # Type-check all packages and apps
pnpm clean           # Remove all build artifacts and node_modules
```

## Adding a New App

```bash
mkdir -p apps/my-app
cd apps/my-app
# Add package.json, then:
pnpm install
```

## Adding a New Package

```bash
mkdir -p packages/my-package
cd packages/my-package
# Add package.json, then:
pnpm install
```

## Dependency Management

```bash
# Add dependency to a specific package
pnpm add <package> --filter <workspace-name>

# Add workspace dependency
pnpm add @repo/tsconfig --filter <workspace-name>

# Add dev dependency to root
pnpm add -Dw <package>
```
