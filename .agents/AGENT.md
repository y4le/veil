# Veil — Agent Bootstrap

Veil is a zero-dependency Node.js CLI that encrypts static HTML sites at build time. It ships self-contained browser wrappers that prompt for a passphrase and decrypt client-side using Web Crypto. No server, no external libraries, one file.

Read this document when integrating Veil into a new project. It covers acquiring the tool, deciding what to protect, and wiring the build/deploy pipeline.

This file is the **portable entry point** for agents outside the Veil repo. It is written to work from either:

- a local checkout of the Veil repo
- a pasted copy of this file
- a readable raw GitHub URL

## Canonical URLs

**Documentation** — these track `main` on purpose, so you always read current guidance. Use them when you only have a raw GitHub bootstrap path instead of a local Veil checkout:

- Bootstrap: `https://raw.githubusercontent.com/y4le/veil/main/.agents/AGENT.md`
- Repo-local skill: `https://raw.githubusercontent.com/y4le/veil/main/.agents/skills/veil-integration/SKILL.md`
- Full-site reference: `https://raw.githubusercontent.com/y4le/veil/main/.agents/skills/veil-integration/references/github-pages.md`
- Protected-zones reference: `https://raw.githubusercontent.com/y4le/veil/main/.agents/skills/veil-integration/references/protected-zones.md`

**Executable** — never fetch `veil.js` from `main`. It is vendored from a specific commit and digest-verified:

```text
https://raw.githubusercontent.com/y4le/veil/<COMMIT-SHA>/veil.js
```

`veil.js` runs in CI with the passphrase secret in its environment. A moving `main` means an unreviewed upstream change becomes code that can read that secret. See [Acquiring Veil](#acquiring-veil).

These URLs only work if the agent can read the Veil repo. If the repo is private and the agent lacks access, use a local checkout or paste the file contents instead.

For a true one-link bootstrap flow, the Veil repo or a mirror of these files needs to be publicly readable.

## Default Operating Mode

If the user gives you this bootstrap doc and a target repo, do the rest yourself:

1. Vendor a commit-pinned, digest-recorded `veil.js` into the target repo.
2. Inspect the target repo to determine how the site is built and deployed.
3. Infer the simplest correct Veil shape from the repo before asking questions.
4. Patch the build and deploy flow.
5. Configure or at least name the required secret variables.
6. Verify the result locally when possible.

Only stop to ask the user when one of these choices is materially ambiguous:

- what stays public versus protected
- whether there should be one passphrase or multiple zones
- whether “Remember this device” should be default-on
- whether you have access to create CI secrets on their behalf

If you do not have access to set CI secrets, still finish the integration and tell the user the exact secret names that must be created.

## Acquiring Veil

Veil is a single file (`veil.js`). Vendor it into the target project from a **specific commit**, and record both the commit SHA and a digest of the file. Do not fetch it from `main`: the vendored copy later runs in CI beside the passphrase secret, so it deserves the same pinning you would give any other dependency with access to secrets.

There are no release tags yet, so a commit SHA is the immutable handle. Get one with `git rev-parse HEAD` in a Veil checkout, or copy the full SHA from the commit page on GitHub.

```bash
# run from the target repo root
COMMIT=<COMMIT-SHA>
mkdir -p ./tools
curl -fsSL "https://raw.githubusercontent.com/y4le/veil/$COMMIT/veil.js" -o ./tools/veil.js
shasum -a 256 ./tools/veil.js | tee ./tools/veil.js.sha256
```

Sanity-check that it runs:

```bash
node ./tools/veil.js --help
```

Provenance is the recorded commit SHA plus the digest file — `--version`
reads a `package.json` next to `veil.js` and prints `veil unknown` for a
vendored single file, so it is not a provenance check.

Commit `./tools/veil.js` and `./tools/veil.js.sha256`, and write the commit SHA somewhere durable in the target repo — a comment above the Veil step in the workflow is enough. Any later re-download is checked against the recorded digest:

```bash
shasum -a 256 -c ./tools/veil.js.sha256
```

Upgrading Veil is a reviewed change: bump the SHA, re-record the digest, read the diff. Never silently re-pull.

If the raw GitHub URL is not readable because the Veil repo is private, copy `veil.js` from a local Veil checkout instead — and still record the digest and the checkout's commit SHA.

No `npm install` required. Node.js 18+ is the only prerequisite.

## Resolve These Questions Before Implementing

Prefer discovering these answers from the repo first. Ask the user only if the answer is not evident and the choice changes behavior.

Resolve these in order. Skip any question where the answer is already obvious from the project context.

### 1. What are you protecting?

> "Should the entire site be password-protected, or do some pages need to stay public?"

- **Entire site** (most common): every HTML file gets encrypted behind one passphrase. This is the default pattern.
- **Selective protection**: some routes stay public (e.g., a landing page) while one or more sections are individually protected, possibly with different passphrases.

### 2. How is the site built?

> "Does the project have a build step (Jekyll, Hugo, Vite, etc.), or are the HTML files deployed directly?"

- **Has a build step**: Veil runs on build output, not source files. You need to know the output directory.
- **No build step**: the HTML files themselves are the deploy artifact. Veil reads them as input and writes encrypted output to a separate directory.

### 3. How is the site deployed?

> "How do you deploy — GitHub Pages, Netlify, Cloudflare Pages, S3, or something else?"

This determines where the passphrase secret is stored and how the pipeline is wired. GitHub Pages with Actions is the most common pattern.

### 4. What site ID should Veil use?

> "Veil scopes browser storage with a site ID. The repo name is usually fine — want to use that?"

The `--id` flag prevents storage collisions when multiple Veil sites share an origin (e.g., `username.github.io`). Default to the repo or project name.

### 5. Should visitors stay unlocked across sessions?

> "Should unlock persist after closing the browser, or require the passphrase each time?"

- **Session only** (default): cleared when the tab closes.
- **Remember device**: persists via `localStorage`. Pass `--remember` to default the checkbox to checked.

### 6. Passphrase delivery

> "How will authorized viewers receive the passphrase?"

Veil doesn't handle distribution. This is a prompt to confirm the user has a plan (direct message, shared password manager, etc.).

## Implementation

After resolving the questions above, follow the appropriate reference:

| Pattern | When to use | Local reference | Raw reference |
|---------|-------------|-----------------|---------------|
| Full-site encryption | Every page is protected behind one passphrase | [github-pages.md](skills/veil-integration/references/github-pages.md) | `https://raw.githubusercontent.com/y4le/veil/main/.agents/skills/veil-integration/references/github-pages.md` |
| Protected zones | Public landing page + individually protected sections | [protected-zones.md](skills/veil-integration/references/protected-zones.md) | `https://raw.githubusercontent.com/y4le/veil/main/.agents/skills/veil-integration/references/protected-zones.md` |

### Verification

A single grep for one canary string is not verification — it passes even when
most of the site was published in plaintext. A mis-typed `--html-root` produces
a clean exit code and a fully public site. Work through all three steps.

**(a) Build into a fresh, empty output directory.**

Veil refuses a non-empty destination, which is the point: a stale file from an
earlier build can never be deployed. Build clean, and only reach for `--force`
in pipelines that deliberately reuse a build directory.

```bash
rm -rf ./_encrypted
node ./tools/veil.js ./site ./_encrypted --passphrase-env VEIL_PASSPHRASE --id my-project
```

Read the combined build output. Veil tells you what it left public (the
warnings go to stderr; the `encrypted N` and `omitting N` counts to stdout):

```text
veil: omitting 1 asset(s) that were inlined into encrypted pages and are not referenced by public files
veil: copying 4 non-HTML file(s) unencrypted — these remain public
veil: leaving 2 HTML file(s) public outside the encrypted roots
veil: encrypted 12 HTML file(s) → /abs/path/_encrypted
```

The last count must match the number of HTML files you intended to protect. The
`leaving N HTML file(s) public` line appears only when HTML fell outside the
encrypted roots — for a full-site build it must not appear at all, and for a
selective build N must be exactly the public pages you expect.

**(b) Run `veil verify` on the output.**

This is the step that catches a wrong `--html-root`, a file left over from an
earlier build, and a wrapper that was mangled after Veil wrote it. It replaces
the hand-rolled greps that used to live here.

```bash
node ./tools/veil.js verify ./_encrypted \
  --input ./site \
  --id my-project \
  --passphrase-env VEIL_PASSPHRASE
```

Verify is **fail-closed**: with no `--html-root`, every HTML file in the output
must be a valid, current-format Veil wrapper sealed for the path it sits at, and
a single plaintext page fails the audit. Exit 0 means the audit ran clean, 1
means it found errors, 2 means it could not run at all (bad arguments, a missing
directory, an unusable passphrase source) — so `set -e` is enough in CI.

`--input` adds correspondence checks: output files with no input counterpart,
HTML that never made it to the output, and passthrough files that no longer
match their source. Note the limit: a wrapper left at the *same* path by an
earlier build of the same site is self-consistent, so verify cannot tell it
from a current one — rollback is out of scope (see PLAN.md), and a fresh output
directory is what prevents it.
`--passphrase-env` adds a real decryption pass (one PBKDF2 derivation for the
whole site). Add `--json` for a machine-readable report with stable finding
codes. A missing *non-HTML* input file is only a warning: an inlined CSS/JS file
that nothing public can reach is deliberately omitted from the output.

For a **selective** build, name the protected roots — the same ones you passed
to the build:

```bash
node ./tools/veil.js verify ./_encrypted --html-root clients --input ./site --id my-project
```

HTML outside those roots is then reported as public rather than failed, and
verify prints the exact list:

```text
Public HTML (outside the audited roots — served as plaintext):
  index.html
  about.html
```

Compare that list against what the user said should stay public, and state it
explicitly in your report. Do not skip it because the count in the build log
"looked about right".

For **chained protected zones**, run verify once per zone against the final
artifact, naming that zone's root, id, and passphrase; wrappers from the other
zones are reported as out-of-scope, not as failures. With `--input`, compare
each stage against the input to *that* Veil invocation, not the original tree.

**(c) Serve it locally and unlock in a real browser.**

```bash
python3 -m http.server 8765 --directory ./_encrypted
```

`http://127.0.0.1:8765` is a secure context, so Web Crypto works. Check that
the prompt appears, the correct passphrase unlocks, a wrong one shows an error,
and a sibling protected page unlocks without re-prompting. The deployed site
must be served over **HTTPS** for the same reason — on plain HTTP the wrapper
shows "Cannot decrypt: this page needs HTTPS (or localhost)."

### Generic CI Snippet

For non-GitHub CI (GitLab, Bitbucket, etc.), ensure the passphrase is provided via an environment variable:

```bash
# Example for a generic shell-based CI
node ./tools/veil.js ./dist ./public \
  --passphrase-env VEIL_PASSPHRASE \
  --id my-project \
  --force   # only if the runner reuses ./public between builds
```

Always pass `--id` explicitly here: with an output directory named `public`,
`dist`, `_site`, or similar, Veil would infer a generic site id and warn that it
can collide with another Veil site on the same origin.

For integration guardrails and verification standards, read the [integration skill guide](skills/veil-integration/SKILL.md).

If you want future agents inside the target repo to auto-discover this guidance, copy `.agents/` into the target repo after integration.

## Quick Start (Full-Site, Local)

For a fast local test before wiring CI:

```bash
# Encrypt everything in ./site into ./encrypted
rm -rf ./encrypted
VEIL_PASSPHRASE=testpass node ./tools/veil.js ./site ./encrypted \
  --passphrase-env VEIL_PASSPHRASE \
  --id my-project

# Serve locally
python3 -m http.server 8765 --directory ./encrypted
```

Then open `http://127.0.0.1:8765` — every page should show the passphrase prompt, unlock with "testpass", and stay unlocked across pages within the session. `127.0.0.1` counts as a secure context, so Web Crypto works.

`--passphrase testpass` would work too, but Veil warns that it is visible in
process listings and shell history — prefer the env var even for throwaway test
passphrases, so the warning-free run is the habit.

## CLI Reference

```
Usage: veil <input-dir> <output-dir> [options]

Options:
  --passphrase <pass>   Set passphrase (omit to prompt interactively)
  --passphrase-env <n>  Read passphrase from environment variable <n>
  --id <site-id>        Storage key scope (default: output dir basename)
  --iterations <N>      PBKDF2 iteration count (default: 600000)
  --remember            Check "Remember this device" by default
  --html-root <dir>     Encrypt only HTML under this input-relative dir (repeatable)
  --no-inline           Skip local CSS/JS inlining
  --force               Replace a non-empty output directory
  --version             Print the veil version
  --help                Show this help
```

```
Usage: veil verify <output-dir> [options]

Options:
  --html-root <dir>     Audit only this output-relative dir (repeatable)
  --input <dir>         Compare against the input directory this build was made from
  --id <site-id>        Require this exact site id
  --passphrase <pass>   Verify decryption with this passphrase
  --passphrase-env <n>  Verify decryption with the passphrase in env variable <n>
  --prompt-passphrase   Verify decryption with a passphrase typed at the terminal
  --json                Emit the report as JSON
  --help                Show this help

Exit codes: 0 clean, 1 errors found, 2 the audit could not be performed.
```

Behavior worth knowing before you wire a pipeline:

- **Fresh artifact.** Veil stages the build in a temporary sibling directory and
  moves it into place on success, so stale files from an earlier build can never
  linger in the deployed output. A non-empty output directory is only replaced
  with `--force` — use that in CI pipelines that reuse a build directory.
- **Chaining.** Because of the above, multiple protected zones chain through
  *successive* output directories (`site → _stage1 → _encrypted`). Two runs
  cannot target one output directory: the second refuses the non-empty
  destination, and `--force` would discard the first zone's work.
- **Strict parsing.** Unknown options and options missing their value are fatal.
  `--id --force` is a forgotten argument, not a site id.
- **Startup warnings** go to stderr: `--passphrase` being visible in process
  listings, an iteration count below the default, and a generic inferred site id
  (`dist`, `public`, `_site`, …) that would collide on a shared origin.
- **UTF-8 only.** HTML that Veil encrypts and CSS/JS it inlines must be valid
  UTF-8; anything else is a fatal error rather than silent mangling. Passthrough
  files are copied byte-for-byte and not decoded.
- **Symlinks** inside the input tree are rejected (the input path itself may be
  a symlink). Output paths that alias, contain, or sit inside the input are
  refused.
- **HTTPS required at runtime.** Web Crypto only exists in secure contexts, so
  the deployed site must be HTTPS (localhost and `file:` also qualify for local
  testing).
- **Interactive entry is confirmed.** Omitting both passphrase flags on a TTY
  prompts twice and aborts on a mismatch; piped stdin is read as a single line
  with no prompt, which is what makes `echo "$PASS" | node veil.js …` work.

## What Veil Does Not Do

- **Identity-based access control** — there are no user accounts; anyone with the passphrase can view the content.
- **Protect non-HTML assets** — images, fonts, and data files are copied unencrypted. Only HTML is encrypted. Inlining does shrink the public surface: a CSS file inlined into encrypted pages and provably referenced by nothing public is dropped from the output, and an inlined JS file is dropped only when the whole site is encrypted and no JavaScript survives publicly. Assume everything else in the output directory is readable.
- **Protect against host compromise** — the host serves the wrapper JS; a compromised host could serve a modified wrapper.
- **Protect against other JavaScript on the origin** — any script on the origin can read the cached master key from `sessionStorage`/`localStorage` and decrypt the public wrappers. No injection bug is needed: an analytics tag or chat widget on a *public* page of a selective deployment is enough, and a cached key is password-equivalent access to that site. `sessionStorage` limits the key's lifetime, not which scripts may read it. Recommend a dedicated origin for protected content, with no third-party JS anywhere on it. Veil's CSP blocks `<script src>` on protected pages, but public pages on the same origin are the integrator's responsibility.
- **Hide structure** — page count, file sizes, directory layout, public asset paths, and each payload's `path` field (the page's own public URL path) are all visible. Titles are not: every wrapper says "Protected page" and carries a `noindex` robots meta.
- **Distribute passphrases** — sharing the passphrase is the site owner's responsibility.

This is the right tool when the alternative is "leave it public and hope nobody notices."
