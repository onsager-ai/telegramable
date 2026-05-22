---
name: development
description: Development conventions and tooling for the telegramable monorepo. Use when working on code, dependencies, or builds.
compatibility: Requires pnpm >=9.0 and Node.js >=22
metadata:
  author: telegramable
  version: 0.1.0
---

# Development Skill

Standards and conventions for developing in the telegramable pnpm monorepo.

## When to Use This Skill

Activate this skill when:
- Installing, adding, or updating dependencies
- Running builds, tests, or development servers
- Creating new packages or apps
- Working with the monorepo structure

## Monorepo Structure

```
telegramable/
├── apps/           # Deployable applications
│   └── web/        # @telegramable/web - Next.js frontend
├── packages/       # Shared libraries
│   └── ui/         # @telegramable/ui - UI components
├── src/            # Root package source (core runtime)
└── tests/          # E2E and integration tests
```

## Package Naming

All workspace packages use the `@telegramable/` scope:
- `@telegramable/web` - Web application
- `@telegramable/ui` - UI component library

## Core Tooling

| Tool | Version | Purpose |
| --- | --- | --- |
| Node.js | >=22 | Runtime |
| pnpm | >=9.15 | Package manager |
| TypeScript | ^5.x | Type checking |

## Commands

### Root-level commands

```bash
# Install all dependencies
pnpm install

# Run root package in dev mode
pnpm dev

# Build root package
pnpm build

# Run E2E tests
pnpm test:e2e
```

### Workspace commands

```bash
# Run command in specific package
pnpm --filter @telegramable/web dev
pnpm --filter @telegramable/ui build

# Run command in all packages
pnpm -r build

# Add dependency to specific package
pnpm --filter @telegramable/web add <package>

# Add shared dependency to workspace root
pnpm add -w <package>

# Add dev dependency
pnpm add -D <package>
pnpm --filter @telegramable/web add -D <package>
```

## Dependency Management

### Rules

1. **Never use npm or yarn** - Always use pnpm
2. **No package-lock.json** - Only pnpm-lock.yaml is used
3. **Workspace dependencies** - Use `workspace:*` protocol for internal packages
4. **Shared dev dependencies** - Install at root when used across multiple packages

### Adding Internal Dependencies

To use `@telegramable/ui` in `@telegramable/web`:

```bash
pnpm --filter @telegramable/web add @telegramable/ui
```

This creates a `workspace:*` reference in package.json.

## Creating New Packages

### New app in apps/

```bash
mkdir apps/new-app
cd apps/new-app
pnpm init
```

Update package.json:
```json
{
  "name": "@telegramable/new-app",
  "private": true
}
```

### New library in packages/

```bash
mkdir packages/new-lib
cd packages/new-lib
pnpm init
```

Update package.json:
```json
{
  "name": "@telegramable/new-lib"
}
```

After creating, run `pnpm install` from root to link the new package.

## TypeScript

- Root tsconfig.json provides base configuration
- Each package can extend with its own tsconfig.json
- Use project references for cross-package type checking

## Best Practices

1. **Run from root** - Execute pnpm commands from the monorepo root
2. **Use filters** - Target specific packages with `--filter`
3. **Check lockfile** - Commit pnpm-lock.yaml changes
4. **Verify installation** - Run `pnpm ls -r` to see workspace structure
5. **Clean install** - Use `pnpm install --frozen-lockfile` in CI

## CI/CD Notes

The GitHub Actions workflow uses:
- Node.js 24
- pnpm with `--frozen-lockfile` for reproducible builds

See `.github/workflows/copilot-setup-steps.yml` for the setup configuration.
