# OrgX Codex Plugin

Codex plugin package for OrgX:

- OrgX MCP server wiring via `https://mcp.useorgx.com/`
- Initiative-aware Codex skills for OrgX execution
- Runtime reporting guidance for progress, artifacts, blockers, and completion
- Install-surface metadata for Codex plugin directories and local marketplaces

## Why this plugin exists

This repo packages the OrgX setup that Codex needs into the structure described
in the official Codex plugins docs:

- `.codex-plugin/plugin.json`
- `.mcp.json`
- `skills/**/SKILL.md`
- `assets/`

It is the Codex counterpart to the existing OrgX Claude Code and OpenClaw
plugin repos.

## Structure

```text
.codex-plugin/plugin.json   # Codex plugin manifest
.mcp.json                   # OrgX MCP configuration
skills/orgx-initiative-ops/SKILL.md
skills/orgx-runtime-reporting/SKILL.md
assets/icon.png
assets/logo.png
scripts/verify-plugin.mjs
```

## Included skills

### `orgx-initiative-ops`

Use OrgX MCP as the source of truth when a task is scoped to an OrgX initiative,
workstream, milestone, task, blocker, or decision.

### `orgx-runtime-reporting`

Keep OrgX updated during live Codex execution with progress, artifacts,
blockers, and completion events.

## Local verification

```bash
npm run check
```

## Install locally in Codex

The official docs recommend using the built-in `@plugin-creator` skill to
scaffold local plugins and marketplace entries. That skill was not available in
the environment used to create this repo, so this plugin was scaffolded
manually against the current published Codex plugin spec.

### Personal marketplace

1. Copy the plugin to your personal Codex plugins directory:

```bash
mkdir -p ~/.codex/plugins
cp -R /absolute/path/to/orgx-codex-plugin ~/.codex/plugins/orgx-codex-plugin
```

2. Add or update `~/.agents/plugins/marketplace.json`:

```json
{
  "name": "useorgx-local",
  "interface": {
    "displayName": "OrgX Local"
  },
  "plugins": [
    {
      "name": "orgx-codex-plugin",
      "source": {
        "source": "local",
        "path": "./plugins/orgx-codex-plugin"
      },
      "policy": {
        "installation": "AVAILABLE",
        "authentication": "ON_INSTALL"
      },
      "category": "Productivity"
    }
  ]
}
```

3. Restart Codex and open `/plugins`.

## MCP server behavior

The bundled `.mcp.json` config uses the hosted OrgX root URL:

```json
{
  "mcpServers": {
    "orgx": {
      "command": "npx",
      "args": ["mcp-remote", "https://mcp.useorgx.com/"]
    }
  }
}
```

This follows current OrgX MCP docs, which recommend the hosted root URL for
external clients and let OAuth happen in-browser on first use.

## Sources used

- Official Codex plugin docs:
  `https://developers.openai.com/codex/plugins`
- OrgX MCP docs:
  `https://docs.useorgx.com/docs/api/overview`
- Existing OrgX references:
  - `orgx-claude-code-plugin`
  - `orgx-openclaw-plugin`
