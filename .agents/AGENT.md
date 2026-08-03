# Veil — Agent Bootstrap

Veil is a zero-dependency Node.js CLI that encrypts static HTML sites at build time. It ships self-contained browser wrappers that prompt for a passphrase and decrypt client-side using Web Crypto. No server, no external libraries, one file.

Read this document when integrating Veil into a new project. It covers acquiring the tool, deciding what to protect, and wiring the build/deploy pipeline.

This file is the **portable entry point** for agents outside the Veil repo. It is written to work from either:

- a local checkout of the Veil repo
- a pasted copy of this file
- a readable raw GitHub URL

## Canonical URLs

Use these when you only have a raw GitHub bootstrap path instead of a local Veil checkout:

- Bootstrap: `https://raw.githubusercontent.com/y4le/veil/main/.agents/AGENT.md`
- CLI: `https://raw.githubusercontent.com/y4le/veil/main/veil.js`
- Repo-local skill: `https://raw.githubusercontent.com/y4le/veil/main/.agents/skills/veil-integration/SKILL.md`
- Full-site reference: `https://raw.githubusercontent.com/y4le/veil/main/.agents/skills/veil-integration/references/github-pages.md`
- Protected-zones reference: `https://raw.githubusercontent.com/y4le/veil/main/.agents/skills/veil-integration/references/protected-zones.md`

These URLs only work if the agent can read the Veil repo. If the repo is private and the agent lacks access, use a local checkout or paste the file contents instead.

For a true one-link bootstrap flow, the Veil repo or a mirror of these files needs to be publicly readable.

## Default Operating Mode

If the user gives you this bootstrap doc and a target repo, do the rest yourself:

1. Fetch or vendor `veil.js` into the target repo.
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

Veil is a single file (`veil.js`). Vendor it directly into the target project:

```bash
mkdir -p ./tools
curl -fsSL https://raw.githubusercontent.com/y4le/veil/main/veil.js -o ./tools/veil.js
```

Verify it works:

```bash
node ./tools/veil.js --help
```

If the raw GitHub URL is not readable because the Veil repo is private, copy `veil.js` from a local Veil checkout instead.

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

Always verify the integration by checking that the output directory does not contain raw source strings from the input HTML.

```bash
# Search for a known string from the source HTML in the encrypted output
grep -r "Your Source String" ./encrypted-output || echo "Verified: Source content not found in output."
```

### Generic CI Snippet

For non-GitHub CI (GitLab, Bitbucket, etc.), ensure the passphrase is provided via an environment variable:

```bash
# Example for a generic shell-based CI
node ./tools/veil.js ./dist ./public \
  --passphrase-env VEIL_PASSPHRASE \
  --id my-project
```

For integration guardrails and verification standards, read the [integration skill guide](skills/veil-integration/SKILL.md).

If you want future agents inside the target repo to auto-discover this guidance, copy `.agents/` into the target repo after integration.

## Quick Start (Full-Site, Local)

For a fast local test before wiring CI:

```bash
# Encrypt everything in ./site into ./encrypted
node ./tools/veil.js ./site ./encrypted \
  --passphrase "testpass" \
  --id my-project

# Serve locally
python3 -m http.server 8765 --directory ./encrypted
```

Then open `http://127.0.0.1:8765` — every page should show the passphrase prompt, unlock with "testpass", and stay unlocked across pages within the session.

## CLI Reference

```
Usage: veil <input-dir> <output-dir> [options]

Options:
  --passphrase <pass>   Set passphrase (omit to prompt interactively)
  --passphrase-env <n>  Read passphrase from environment variable <n>
  --id <site-id>        Storage key scope (default: output dir basename)
  --iterations <N>      PBKDF2 iteration count (default: 600000)
  --remember            Check "Remember this device" by default
  --html-root <dir>     Encrypt only HTML under this relative dir (repeatable)
  --no-inline           Skip local CSS/JS inlining
  --force               Replace a non-empty output directory
  --help                Show this help
```

The output directory is rebuilt from scratch on every run. A non-empty output
directory is only replaced with `--force` — use that in CI pipelines that
reuse a build directory. Symlinks inside the input tree are rejected.

## What Veil Does Not Do

- **Identity-based access control** — there are no user accounts; anyone with the passphrase can view the content.
- **Protect non-HTML assets** — CSS, JS, images, and other files are copied unencrypted. Only HTML is encrypted.
- **Protect against host compromise** — the host serves the wrapper JS; a compromised host could serve a modified wrapper.
- **Distribute passphrases** — sharing the passphrase is the site owner's responsibility.

This is the right tool when the alternative is "leave it public and hope nobody notices."
