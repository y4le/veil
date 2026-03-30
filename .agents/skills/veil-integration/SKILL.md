---
name: veil-integration
description: Integrate Veil into an existing static site or GitHub Pages repo. Covers full-site encryption, protected zones, build/deploy wiring, secret management, and verification.
---

# Veil Integration

Use this skill when a project needs Veil added to its build and deploy pipeline.

This skill is for **repo-local `.agents` discovery**. It works best when the current repo already contains `.agents/skills/veil-integration/`.

For the portable bootstrap flow outside this repo, start with [AGENT.md](../../AGENT.md). If you only have raw GitHub access, use:

- `https://raw.githubusercontent.com/y4le/veil/main/.agents/AGENT.md`
- `https://raw.githubusercontent.com/y4le/veil/main/.agents/skills/veil-integration/references/github-pages.md`
- `https://raw.githubusercontent.com/y4le/veil/main/.agents/skills/veil-integration/references/protected-zones.md`

If the target repo should auto-discover Veil integration guidance in future sessions, copy `.agents/` into that repo rather than relying on a raw URL every time.

## What Good Integration Looks Like

- Veil runs on **built output**, not on source files.
- Passphrases come from environment variables, never CLI args in CI.
- The deployed output is verified in a real browser.

### Full-Site Encryption (Default)

When every page is protected behind one passphrase:

- No `--html-root` needed — Veil encrypts all HTML in the input directory.
- One `--id`, one passphrase secret, one Veil run.
- Follow [github-pages.md](references/github-pages.md).

### Protected Zones (Advanced)

When some routes stay public and others are individually protected:

- Public and protected routes are explicit.
- Each zone has its own `--id` and passphrase secret.
- Veil receives the full staged site as input; `--html-root` limits which HTML gets encrypted.
- Follow [protected-zones.md](references/protected-zones.md).

## First Pass

Inspect these before changing anything:

- Build scripts that produce the publishable site.
- The deploy workflow, usually under `.github/workflows/`.
- Which HTML routes must stay public (if any).
- Whether protected pages reference shared CSS or JS outside their own subtree.

## Required Flags

### Full-site encryption

- `--passphrase-env <NAME>`: read passphrase from a secret-backed environment variable.
- `--id <site-id>`: scope browser storage keys.

### Protected zones (additional)

- `--html-root <dir>`: encrypt only HTML under this relative path (repeatable for multiple zones in a single run, or chain runs for separate passphrases).

Use `--remember` only if the target UX should default to "Remember this device."

## Integration Workflow

1. Identify the existing build step and its output directory.
2. Vendor `veil.js` into the repo (e.g., `./tools/veil.js`).
3. Add a Veil step after the build that writes encrypted output to a separate directory.
4. Point the deploy/upload step at the Veil output directory.
5. Add one passphrase secret per protected zone (or one for full-site).
6. Verify locally before relying on CI.
7. If useful, copy this `.agents/` setup into the target repo so future agents can discover it automatically.

## Guardrails

- Never pass the passphrase with `--passphrase` in CI — use `--passphrase-env`.
- Never commit passphrases or store them in workflow YAML.
- Do not reuse the same `--id` for unrelated protected areas.
- Do not assume a subtree can be encrypted in isolation if its pages reference shared assets elsewhere in the staged site.

## Verification Standard

Verify all of the following in a real browser:

- Every expected page either shows the prompt (if protected) or renders normally (if public).
- The correct passphrase unlocks content.
- A wrong passphrase shows an error and stays locked.
- After unlocking one protected page, other pages in the same zone auto-unlock.
- A second load uses stored unlock state when that behavior is intended.
- Closing and reopening the tab returns to the locked state (unless `--remember` was used).

If the prompt renders but Unlock appears inert, inspect the browser console and wrapper DOM — that usually means the bootstrap script failed before the submit handler attached.
