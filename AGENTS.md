# AGENTS.md

Guidelines for Codex and other agents working in `useorgx/orgx-codex-plugin`.

## Project

This repo packages OrgX for Codex: `.codex-plugin/plugin.json`, MCP wiring, skills, runtime reporting guidance, and passive hook templates.

## Working autonomously

Proceed with the user's authorized work, including routine implementation,
verification, commits, PR updates, and requested merges. Prior authorization
persists; do not ask again because a skill, checklist, or reporting step repeats
it. Keep actual access controls, required repository checks, and unresolved
human decisions intact.

OrgX context and reporting support the work. Missing IDs, unavailable MCP tools,
or pending telemetry do not block independent code changes or a merge whose
required checks have passed. Report the tracking gap without claiming a write
succeeded. Run setup only when the environment needs it.

## Setup

For Codex cloud, use:

```bash
bash .codex/setup-cloud.sh
```

Maintenance script for cached environments:

```bash
bash .codex/maintenance-cloud.sh
```

## Verification

```bash
npm run check
npm test
```

Do not claim plugin packaging changes are verified unless `npm run check` passed. Run `npm test` when touching peer runtime code.
