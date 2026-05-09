# AGENTS.md

Guidelines for Codex and other agents working in `useorgx/orgx-codex-plugin`.

## Project

This repo packages OrgX for Codex: `.codex-plugin/plugin.json`, MCP wiring, skills, runtime reporting guidance, and passive hook templates.

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
