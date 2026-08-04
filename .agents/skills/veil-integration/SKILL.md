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

Those are documentation and track `main` deliberately. `veil.js` itself is the
one file never fetched from `main`: vendor it from
`https://raw.githubusercontent.com/y4le/veil/<COMMIT-SHA>/veil.js` and record
its digest.

If the target repo should auto-discover Veil integration guidance in future sessions, copy `.agents/` into that repo rather than relying on a raw URL every time.

## What Good Integration Looks Like

- Veil runs on **built output**, not on source files.
- `veil.js` is vendored from a **specific commit**, with its SHA and a
  `sha256sum` recorded in the target repo — never pulled from `main`. It runs in
  CI beside the passphrase secret.
- Passphrases come from environment variables, never CLI args in CI.
- The build log is read, not just the exit code: Veil warns on stderr about
  what it copied unencrypted and what HTML it left public, and prints the
  encrypted-page count on stdout.
- Every output HTML file that should be protected is asserted to carry a
  payload — not spot-checked with one grep.
- The deployed output is verified in a real browser, over HTTPS.

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
- Zones with different passphrases chain through **successive** output
  directories (`site → _stage1 → _encrypted`), one run per zone. They cannot
  share an output directory: Veil builds a fresh artifact, so the second run
  refuses the non-empty destination and `--force` would discard the first zone.
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

- `--html-root <dir>`: encrypt only HTML under this input-relative path. Repeat
  the flag for several subtrees that share **one** passphrase; chain runs
  through successive output directories for zones that need **different**
  passphrases.
- `--force`: only where CI reuses a build directory between runs.

Use `--remember` only if the target UX should default to "Remember this device."

## Integration Workflow

1. Identify the existing build step and its output directory.
2. Vendor `veil.js` from a pinned commit into the repo (e.g., `./tools/veil.js`),
   recording the SHA and `shasum -a 256 ./tools/veil.js | tee ./tools/veil.js.sha256`.
   See [AGENT.md](../../AGENT.md) for the full recipe.
3. Add a Veil step after the build that writes encrypted output to a separate directory.
4. Point the deploy/upload step at the Veil output directory.
5. Add one passphrase secret per protected zone (or one for full-site).
6. Verify locally before relying on CI.
7. If useful, copy this `.agents/` setup into the target repo so future agents can discover it automatically.

## Guardrails

- Never pass the passphrase with `--passphrase` in CI — use `--passphrase-env`.
  Veil warns about it on stderr; do not teach anyone to ignore that warning.
- Never commit passphrases or store them in workflow YAML.
- Never fetch `veil.js` from `main` at build time. Vendor a pinned commit and
  verify the recorded digest; treat an upgrade as a reviewed diff.
- Always pass `--id` explicitly. An inferred id from an output directory named
  `dist`, `public`, or `_site` is generic enough to collide with another Veil
  site on the same origin, and Veil warns about exactly that.
- Do not reuse the same `--id` for unrelated protected areas.
- Do not run two Veil invocations into the same output directory. Chain through
  successive directories instead; `--force` there deletes the earlier zone.
- Use `--force` only where a build directory is deliberately reused between runs.
- Do not assume a subtree can be encrypted in isolation if its pages reference shared assets elsewhere in the staged site.
- The input tree must contain no symlinks, and the HTML Veil encrypts plus the
  CSS/JS it inlines must be valid UTF-8. Both are fatal, not warnings.
- The deployed site must be served over HTTPS — Web Crypto does not exist in
  insecure contexts, and the wrapper will refuse to decrypt.
- Never add third-party JS (analytics, chat, embeds) to any page on an origin
  that hosts protected content, including the *public* pages of a selective
  deployment. Such a script can read the cached master key out of browser
  storage and decrypt the protected pages.

## Verification Standard

### In the build output

- Build into a fresh, empty output directory (Veil refuses a non-empty one).
- Read the combined build output (warnings are stderr, counts are stdout):
  the "encrypted N HTML file(s)" count must match the number of pages you
  meant to protect, and the "copying N non-HTML file(s) unencrypted" /
  "leaving N HTML file(s) public" lines must be expected.
- Run `veil verify` on the output — it is the audit, not a spot check:

  ```bash
  node ./tools/veil.js verify ./_encrypted \
    --input ./site \
    --id my-project \
    --passphrase-env VEIL_PASSPHRASE
  ```

  Verify is fail-closed: with no `--html-root`, every HTML file in the output
  must be a valid, current-format wrapper sealed for the path it sits at. It
  also checks cross-page metadata consistency, IV uniqueness, and that each
  wrapper still byte-matches the one Veil generates for its own payload.
  `--input` adds stale-file, missing-file, and passthrough-integrity checks;
  a passphrase adds a real decryption pass. Exit 0 clean, 1 errors, 2 the
  audit could not run — `--json` gives a report with stable finding codes.
- For a selective build, pass the same `--html-root` values you built with.
  HTML outside them is then reported as public rather than failed, and verify
  prints the exact list. Confirm that list is what the user intended, and state
  it in your report — this is the check that catches a wrong `--html-root`.
- For chained zones, run verify once per zone against the final artifact with
  that zone's root, id, and passphrase — and run every zone. Outside the
  audited roots, only a byte-exact wrapper is treated as one; any other
  payload-looking page (a tampered wrapper from another zone, or public HTML
  quoting a payload) is warned about and listed as public, because Veil cannot
  separate those without a real HTML parser. Each zone's own run is what turns
  that warning into an error. With `--input`, compare each stage against the
  input to that Veil invocation, not the original tree.
- A warning that a non-HTML input file is absent from the output is expected
  when its contents were inlined into encrypted pages.

### In a real browser

- Every expected page either shows the prompt (if protected) or renders normally (if public).
- The correct passphrase unlocks content, and the real page title returns —
  the locked page always reads "Protected page".
- A wrong passphrase shows an error and stays locked.
- After unlocking one protected page, other pages in the same zone auto-unlock.
- One zone's passphrase does not unlock another zone.
- A second load uses stored unlock state when that behavior is intended.
- Closing and reopening the tab returns to the locked state (unless `--remember` was used).
- Images, fonts, and styles render on the decrypted page. If something is
  missing, check the console for CSP violations: the wrapper's CSP governs the
  decrypted document too, and it blocks every `<script src>` — same-origin or
  external. With `--no-inline`, local JS will not run at all.

If the prompt renders but Unlock appears inert, inspect the browser console and wrapper DOM — that usually means the bootstrap script failed before the submit handler attached.
