---
name: veil-integration
description: Integrate Veil into an existing static site or GitHub Pages repo. Covers full-site encryption, protected zones, build/deploy wiring, secret management, and verification.
---

# Veil Integration

Use this skill when a project needs Veil added to its build and deploy pipeline.
It is the repo-local entry point; [AGENT.md](../../AGENT.md) is the portable one,
and works when only a raw GitHub URL or a pasted copy is available.

Documentation may be read from `main`. `veil.js` itself is vendored from
`https://raw.githubusercontent.com/y4le/veil/<COMMIT-SHA>/veil.js` with its
digest recorded, never from `main`.

## Pick the pattern

**Full site** (the common case): every HTML file behind one passphrase. No
`--html-root`, one `--id`, one secret, one run. Follow
[github-pages.md](references/github-pages.md).

**Protected zones**: some routes stay public, one or more subtrees are
protected. Each zone gets its own `--id` and secret; Veil takes the whole staged
site as input so shared assets still resolve, and `--html-root` limits what gets
encrypted. Zones with different passphrases chain through successive output
directories, one run each. Follow
[protected-zones.md](references/protected-zones.md).

## First pass

Inspect before changing anything: the build script that produces the publishable
site, the deploy workflow (usually `.github/workflows/`), which HTML routes must
stay public, and whether protected pages reference assets outside their own
subtree.

## Workflow

1. Identify the publishable site: a generator's output directory where there is
   a build step, the HTML tree itself where there is not. Veil never runs on
   files that still need processing.
2. Vendor `veil.js` from a pinned commit into e.g. `./tools/veil.js`, recording
   the SHA and `shasum -a 256 ./tools/veil.js | tee ./tools/veil.js.sha256`.
3. Add a Veil step after the build, writing to a separate output directory.
4. Point the deploy step at that directory.
5. Add one passphrase secret per zone.
6. Verify locally, then in the browser.
7. Optionally copy `.agents/` into the target repo for future agents.

## Guardrails

- Never `--passphrase` in CI; use `--passphrase-env`. Veil warns about it, and
  that warning is not noise to be suppressed.
- Never commit a passphrase or put one in workflow YAML.
- Never fetch `veil.js` from `main` at build time; it runs beside the secret.
  Treat an upgrade as a reviewed diff.
- Always pass `--id` explicitly, and never reuse one across unrelated protected
  areas.
- Never run two Veil invocations into one output directory. Chain through
  successive directories; `--force` there deletes the earlier zone's work and
  still exits 0. Use `--force` only where a build directory is deliberately
  reused between runs.
- Do not assume a subtree can be encrypted in isolation if its pages reference
  assets elsewhere in the staged site.
- The input tree must contain no symlinks, and encrypted HTML plus inlined
  CSS/JS must be valid UTF-8. Both are fatal.
- The deployed site must be HTTPS; Web Crypto does not exist in insecure
  contexts.
- Never add third-party JS to any page on an origin that hosts protected
  content, including the *public* pages of a selective deployment. Such a script
  can read the cached master key from browser storage and decrypt the protected
  pages.

## Completion criteria

The integration is done when all of these hold:

- The build ran into a fresh output directory and its counts match intent; the
  `encrypted N HTML file(s)` line equals the pages meant to be protected, and
  `leaving N HTML file(s) public` is absent for a full site or exactly the
  expected pages for a selective one.
- `veil verify` exits 0 against the output, with `--input`, `--id`, and a
  passphrase supplied:

  ```bash
  node ./tools/veil.js verify ./_encrypted \
    --input ./site --id my-project --passphrase-env VEIL_PASSPHRASE
  ```

- For a selective build, the same `--html-root` values were passed to verify,
  and its printed public-HTML list was compared against what the user wanted
  public and **restated in your report**.
- For chained zones, verify was run once per zone, with that zone's root, id,
  and passphrase; enforcement only exists inside an audited scope, so an
  unaudited zone is an unverified one.
- The browser check passed: protected routes prompt and unlock, public routes do
  not prompt, one zone's passphrase does not unlock another, wrong passphrases
  fail, and assets render after unlock.

Audit semantics, finding codes, and limits are in `docs/verify.md`; browser
checklists are in the deployment references.
