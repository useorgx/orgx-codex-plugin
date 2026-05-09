# Codex Cloud Environment

Use these repo-local scripts when configuring the Codex cloud environment for `useorgx/orgx-codex-plugin`.

## Setup script

```bash
bash .codex/setup-cloud.sh
```

## Maintenance script

```bash
bash .codex/maintenance-cloud.sh
```

## Environment notes

- Node 22 or newer is safe for this repository.
- The package depends on `github:useorgx/orgx-gateway-sdk`; dependency install needs GitHub access during setup.
- No OrgX API secrets are required for static plugin verification.
- Keep internet access limited to the setup phase unless a task explicitly needs external services.

## Verification commands

```bash
npm run check
npm test
```
