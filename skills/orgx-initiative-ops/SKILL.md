---
name: orgx-initiative-ops
description: Use when Codex is working on a repo or task that is scoped to an OrgX initiative, workstream, milestone, task, blocker, or decision and needs to use OrgX MCP as the source of truth.
---

# OrgX Initiative Ops

Use this skill when the task is tied to OrgX execution state rather than just local code.

## Workflow

1. Orient before editing:
- Call the OrgX workspace or initiative summary tools first.
- If an initiative, workstream, task, blocker, or decision is named, treat OrgX as the source of truth for current status.

2. Reuse existing context before creating new structure:
- Query OrgX memory or list the relevant entities first.
- Only scaffold new work when no matching initiative structure already exists.

3. Work against the current slice:
- Prefer updating the current task or workstream instead of creating parallel duplicate work.
- Keep your local implementation aligned with the active OrgX entity state.

4. Report concrete progress:
- Use OrgX progress/activity tools for real execution milestones.
- Register artifacts when code, docs, plans, screenshots, or reports are produced.

5. Surface decisions explicitly:
- If work is blocked on judgment, request a decision with clear options and impact.
- Do not bury blockers in prose.

6. Close the loop:
- When a task is truly done, verify it first.
- Then update completion state in OrgX if the current task is known.

## Quality bar

- Never assume OrgX entity state from memory alone.
- Never mark work complete without verification.
- Prefer one verified task completion over broad unverified status claims.
- Use `source_client=codex` whenever the tool supports client attribution.
