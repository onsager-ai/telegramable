# telegramable

## Specs

Specs live as GitHub issues labeled `spec` in [onsager-ai/telegramable](https://github.com/onsager-ai/telegramable/issues?q=label%3Aspec). No `specs/` folder, no spec files — the issue body is the spec; the comment thread is the audit trail; open/closed tracks lifecycle.

Use the `issue-spec` skill (from `onsager-ai/dev-skills`) to draft new specs. Title format: `spec(<area>): <description>`. Labels: `spec` + type (`feat`/`fix`/`refactor`/`perf`) + `area:<X>` + `priority:<level>`. Sub-issues link parent/child decomposition.

## Skills

This project uses the Agent Skills framework for domain-specific guidance.

### development - Monorepo Conventions

- **Location**: `.github/skills/development/SKILL.md`
- **Use when**: Installing dependencies, running builds, creating packages
- **Key principles**:
  - Use pnpm (never npm/yarn)
  - Node.js >=22 required
  - Packages use `@telegramable/` scope

## Project-Specific Rules

- **Package manager**: pnpm only, no package-lock.json
- **Monorepo**: apps/ for deployables, packages/ for shared libs
- **Naming**: All packages use `@telegramable/` scope
