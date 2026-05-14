---
name: publish-release
description: Use when the user asks to ship, publish, release, or cut a new version of the glancer-vscode (Glance for Claude Code) VS Code extension.
---

# Publish a glancer-vscode release

## Overview

Releases ship to the VS Code Marketplace through a tag-triggered GitHub Actions workflow at `.github/workflows/release.yml`. Each `v*` tag pushed to GitHub fans out a 6-platform build matrix that publishes per-platform `.vsix` files using the repo's `VSCE_PAT` secret. **The tag push is the only thing that ships** — branch pushes do nothing, and manual `workflow_dispatch` builds artifacts but skips publish.

## When to use

The user says ship / publish / release / "cut v0.0.X" / "send this to marketplace" / "bump and publish" for this repo. Don't infer release intent from unrelated commits — the user must ask.

## Permission gate

Never bump, tag, or create a release without an explicit user instruction in the current or just-prior turn — see the `feedback_publish_consent` memory. "Publish" / "ship it" / "release" / "cut vX.Y.Z" all count. A version bump left committed for the user to ship later is fine; just don't create tags or Releases on your own.

## The flow

1. **Pre-flight check.** `git status` must be clean of anything that shouldn't ship. `git diff` the staged work. Confirm `package.json`'s current version with the user — `npx -y @vscode/vsce show hamzawaleed.glance-claude-code --json` reveals what's already on marketplace.
2. **Bump the version** in `package.json` (patch for fixes, minor for features). Don't skip numbers.
3. **Commit + push `main`:**
   ```bash
   git add -A
   git commit -m "v0.0.X: <short release summary>"
   git push origin main
   ```
4. **Create the GitHub Release** — this is the canonical path (creates the tag + surfaces changelog to users):
   ```bash
   gh release create v0.0.X --target main \
     --title "v0.0.X" \
     --notes "$(cat <<'EOF'
   ## Highlights

   - <bullet>
   - <bullet>
   EOF
   )"
   ```
   Plain `git push origin v0.0.X` also triggers the workflow but skips the user-visible changelog.
5. **Watch the run:**
   ```bash
   gh run list --workflow=release.yml --limit 1
   gh run watch <run-id>
   ```
6. **Verify marketplace coverage** once complete:
   ```bash
   npx -y @vscode/vsce show hamzawaleed.glance-claude-code --json \
     | jq -r '.versions[] | "\(.version) \(.targetPlatform // "universal")"' \
     | sort -u | head -12
   ```
   Expect 6 rows for the new version: `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64`, `win32-arm64`, `win32-x64`.

## Known issues

| Symptom | Cause | Fix |
|---|---|---|
| `darwin-x64` job stuck in queue for hours | `macos-13` is the last GitHub-hosted Intel Mac image, heavily backed up | Wait it out, cancel and accept the gap (Apple Silicon is most users), or publish locally: `node scripts/package-platforms.mjs darwin-x64 && npx vsce publish --packagePath dist/<file>` |
| `ERROR onlyBuiltDependencies?.sort is not a function` in "Set up pnpm" step | `pnpm/action-setup@v4` chokes on stringified-JSON in `.npmrc` | Don't add `only-built-dependencies` to `.npmrc`. The canonical place is `package.json` → `pnpm.onlyBuiltDependencies` as a real array. |
| `linux-x64` / `linux-arm64` job fails at Build VSIX with `no matching prebuild` | node-pty has no Linux prebuild in its npm tarball, so node-gyp builds into `build/Release/`, not `prebuilds/<target>/` | The workflow's "Stage Linux native build into prebuilds dir" step copies `pty.node` over. Don't delete it. |
| Linux stage step fails on `cp ... spawn-helper` | Linux node-pty uses plain fork+exec; no spawn-helper is built on that platform | Don't `cp spawn-helper` in the Linux stage step — only `pty.node`. |
| Matrix job publishes succeed with "already exists (409)" | A `.vsix` for that platform+version was shipped locally before CI ran | Tolerated — the publish step treats `already exists` / `409` as success so re-runs are idempotent. |

## Re-runs and partial publishes

`fail-fast: false` keeps one platform's failure from blocking the rest. If only one or two jobs fail, `gh run rerun <run-id> --failed`.

If the fix requires a code change, **prefer bumping to a new version** over force-retagging — non-destructive, no risk to in-flight runs. Only re-tag (delete + recreate) when:
- No platform has shipped the version yet, **or**
- The user explicitly wants to avoid a version bump (e.g., for a CI-only fix that doesn't deserve a user-visible re-prompt).

## References

- `.github/workflows/release.yml` — the workflow definition
- `scripts/package-platforms.mjs` — per-platform `.vsix` builder used by CI and local
- `package.json` → `pnpm.onlyBuiltDependencies` — canonical install-script allowlist
- Memory: `feedback_publish_consent` — consent gate
- Memory: `feedback_publish_workflow` — package-platforms.mjs is canonical
- Memory: `feedback_release_workflow` — push code, then `gh release create v<X.Y.Z>`
