# Release identity

Pull requests and pushes to `main` run installation, plugin verification, tests,
manifest fingerprinting/signing, and tarball validation. They upload an Actions
artifact; they do not publish to npm or create/edit GitHub releases.

An intentional release requires a new package version, matching versions in
`plugin.manifest.json` and `.codex-plugin/plugin.json`, and a matching `v<VERSION>`
tag pushed at the reviewed commit. The tag push runs the same validation. Only
then can the release job publish the validated tarball with npm trusted publishing
and provenance, and create a GitHub release with generated notes. The existing
signing step, credentials, permissions, runners, and release concurrency remain
unchanged.

The release preflight is read-only. It verifies that the remote tag (including an
annotated tag) resolves to the validated commit and checks both npm and GitHub.
Only confirmed absence in both registries permits publication. Registry outages,
authentication/rate-limit errors, malformed responses, and tag/version mismatches
fail the job. A version already on npm, or any existing GitHub release for its
tag, skips all publication steps, including asset upload and note generation.

GitHub release creation uses `gh release create --verify-tag` rather than an
upsert. An existing release is never updated, its asset is never replaced, and a
missing tag is never created implicitly. The CLI creates a new draft, uploads
the new tarball, then publishes it; if that operation fails it may clean up only
the draft it just created. It cannot use an existing release as that draft.

If publication stops partway through, a rerun deliberately does not reconstruct
an existing version from a new build. Investigate the original validated artifact
and release state before deciding how to recover. Never force-move a published
tag or replace a published asset to make a retry succeed. Rerunning a historical
workflow run uses its historical workflow, so do not rerun old publication jobs
that predate this gate.

Changes to runner routing must retain the tag-only job condition, the positive
`publish == 'true'` step gates, remote tag verification, and create-only release
operation. Runner/signing-secret trust changes require their own review.

Regression checks run in `npm test`; the focused command is:

```bash
node --test scripts/release-gate.test.mjs
```
