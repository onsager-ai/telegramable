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

## Human decisions

When a concrete decision remains for a human, use the current harness's supported structured question tool, following its native instructions, tool contract and mode restrictions. Resolve tool names and mechanics through the matching harness-operations reference where available. Do not leave the decision only in a plain-text question, final response, or "Human decides" checklist. State the decision, relevant context, options and tradeoffs in the tool call; wait for an explicit answer before dependent work and reconcile it into the spec or decision record. Continue independent authorized work and do not re-ask settled decisions. If no permitted question tool is available, state that limitation and the unresolved decision, keep dependent work blocked, and use the repository's established human handoff channel. Silence, elapsed time and a recommended option are not approval.
