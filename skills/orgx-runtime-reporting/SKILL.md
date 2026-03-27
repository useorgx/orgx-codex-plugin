---
name: orgx-runtime-reporting
description: Use when a Codex execution should report progress, artifacts, blockers, or completion state back to OrgX during a live task.
---

# OrgX Runtime Reporting

Use this skill when Codex should keep OrgX updated during execution.

## Workflow

1. Resolve available IDs from args, env, or the current OrgX context:
- `ORGX_INITIATIVE_ID`
- `ORGX_WORKSTREAM_ID`
- `ORGX_TASK_ID`
- `ORGX_RUN_ID`
- `ORGX_CORRELATION_ID`

2. Emit activity at meaningful milestones:
- `intent`
- `execution`
- `handoff`
- `blocked`
- `completed`

3. Register proof of work:
- When you produce a file, diff, document, screenshot, or report, register it as an artifact with a concrete summary.

4. Handle blockers structurally:
- If judgment is required, request a decision with explicit options.
- If context is missing, report the exact missing dependency.

5. Close execution cleanly:
- When the task is complete and verified, emit completion activity and update entity state if the task ID is available.

## Quality bar

- Never post empty status updates.
- Messages must be evidence-based and specific.
- Include OrgX IDs whenever available.
- Use `source_client=codex`.
