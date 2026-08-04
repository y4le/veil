# Veil

Encrypt static HTML sites at build time. Veil wraps each HTML file in a self-contained shell that prompts for a passphrase and decrypts client-side using Web Crypto. No server, no dependencies, one file.

**Good for:** client previews, trip plans, proposal decks, private-ish docs, prototypes on static hosting.

**Not for:** regulated data, identity-based access control, or protecting against a compromised host.

> [!WARNING]
> **Veil is deterrence, not absolute security.** It protects against casual
> browsing and search indexing. It does **not** protect against a compromised
> host, weak passphrases, or any JavaScript running on the same origin — a
> script there can read the cached key out of browser storage and decrypt the
> site. **Only HTML files are encrypted.** Images, fonts, and data files are
> copied through and stay public; a CSS or JS file that was inlined into
> encrypted pages is dropped from the output only when nothing public can still
> reach it, and everything else is copied. Public wrappers carry a constant
> "Protected page" title, so titles do not leak, but page count, file sizes,
> and directory structure do.

## Quick Start

```bash
# Encrypt a site (omit --passphrase to be prompted, with confirmation)
node veil.js ./my-site ./encrypted --passphrase "secret" --id my-project

# Serve and test
python3 -m http.server 8765 --directory ./encrypted
```

Open `http://127.0.0.1:8765` — every page prompts for the passphrase, then decrypts in the browser.

`--passphrase` warns that it is visible in process listings and shell history;
use `--passphrase-env` or the interactive prompt for anything real. `./encrypted`
must be absent or empty — Veil builds a fresh artifact and will not write over
an existing one without `--force`.

## How It Works

1. Veil reads a directory of HTML files (pages being encrypted and assets
   being inlined must be UTF-8; passthrough files are copied byte-for-byte)
   and inlines local
   CSS/JS into each page — relative or root-relative, quoted or unquoted
   references. Relative `url()`/`@import` paths inside inlined CSS are
   rewritten so they still resolve from the page. Scripts and stylesheets it
   must leave in the page (external URLs, module scripts, missing files) are
   reported with a build warning; cross-origin images and fonts referenced
   from CSS are blocked by the page CSP too, but are not warned about
   individually.
2. It generates a random site master key, wraps it with a key derived from your passphrase (PBKDF2 + AES-256-GCM), and encrypts each HTML file with the master key.
3. Each encrypted file is replaced with a self-contained wrapper that carries the ciphertext and a minimal unlock UI.
4. In the browser, the wrapper derives the same key from the passphrase, unwraps the master key, decrypts the page, and caches the key for the session so other pages unlock automatically.

Non-HTML files (images, fonts, data) are copied as-is and remain public —
with one exception: a CSS/JS file that was inlined into encrypted pages and
is referenced by nothing else is omitted from the output, so inlining
actually shrinks the public surface. Inlined JS is only omitted when the
whole site is encrypted (no public HTML) and no other JS survives publicly,
since public pages and scripts can reach it in ways no scanner sees.

Runtime behavior worth knowing:

- **HTTPS required.** Web Crypto only exists in secure contexts (HTTPS,
  localhost, or `file:`). On plain HTTP the wrapper shows a clear error.
- **The wrapper CSP governs decrypted pages too.** It allows same-origin
  images, fonts, media, stylesheets, and fetches, plus inline scripts and
  styles. It blocks every `<script src>` — same-origin or external. Inlining
  (the default) converts local scripts to inline ones; external/third-party
  scripts never run on protected pages, which also protects the cached key
  in browser storage. With `--no-inline`, local JS will not execute.
- **Titles are not leaked.** The public wrapper always says "Protected page"
  (with a `noindex` robots meta); the real title appears after decryption.
- **Lock/logout.** The 🔒 button or `?veil=logout` clears cached keys.

## CLI

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

The output directory is a fresh artifact on every run: Veil builds into a
temporary sibling directory and moves it into place on success, so stale files
from earlier builds can never linger in (and be deployed from) the output. A
non-empty output directory is only replaced when you pass `--force`. Symlinks
inside the input tree are rejected rather than silently skipped or followed
(the input path itself may be a symlink).

### CI Usage

In CI, always use `--passphrase-env` to read from a secret — never pass the
passphrase as a CLI argument, where process listings and shell history can see
it. Veil warns on stderr whenever `--passphrase` is used:

```bash
node veil.js ./site ./_encrypted \
  --passphrase-env VEIL_PASSPHRASE \
  --id my-project
```

### Selective Encryption

Use `--html-root` to encrypt only part of a site while leaving other pages public:

```bash
node veil.js ./site ./_encrypted \
  --passphrase-env VEIL_PASSPHRASE \
  --id client-portal \
  --html-root clients/
```

Veil reports what it left public on stderr — `veil: leaving N HTML file(s)
public outside the encrypted roots` — so a mistake in `--html-root` is visible
in the build log. Because the output directory is a fresh artifact, several
zones with different passphrases are chained through **successive** output
directories, not repeated runs into one directory; see
[`protected-zones.md`](.agents/skills/veil-integration/references/protected-zones.md).
Note that any script on a public page can read the cached key for the protected
zones — see the threat model below.

## Integrate Into Your Project

### Option A: Let an agent do it

There are two clean ways to make Veil agent-friendly:

- **Portable bootstrap doc**: point the agent at `.agents/AGENT.md`.
- **Repo-local skill discovery**: copy `.agents/` into the target repo so agents that load project skills can discover it automatically.

A one-shot prompt for an agent is:

```
Read https://raw.githubusercontent.com/y4le/veil/main/.agents/AGENT.md
and use it to integrate Veil into this project end to end.
Inspect the repo first, vendor Veil, wire the build and deploy flow,
and only ask me questions if what stays public, the passphrase layout,
or secret handling is ambiguous.
```

If the agent can read the Veil repo, that bootstrap doc is the primary entry point. It tells the agent how to vendor a pinned `veil.js`, detect full-site versus protected-zone setups, wire CI, and verify the result.

That `main` URL is for the human-readable bootstrap doc only. The **executable**
— `veil.js` — should always be vendored from a specific commit and checked
against a recorded digest, because it later runs in CI beside the passphrase
secret. See the pinning recipe in Option B; it applies to agents too.

If the Veil repo is private or the agent does not have GitHub access, a raw GitHub URL will not work. In that case:

- give the agent local access to this repo checkout
- paste the contents of [`.agents/AGENT.md`](.agents/AGENT.md)
- or copy `.agents/` into the target repo so the skill is local

For the cleanest “give the agent one URL and let it handle the rest” workflow, Veil itself needs to be publicly readable or mirrored somewhere the agent can fetch without extra auth.

The repo-local skill lives at [`.agents/skills/veil-integration/SKILL.md`](.agents/skills/veil-integration/SKILL.md). That is the right path when you want future agents working inside the target repo to discover the integration guidance automatically.

### Option B: Manual setup

1. **Vendor a pinned `veil.js`** into your project (e.g., `./tools/veil.js`).
   Pin a specific commit, never `main`: the vendored file runs in CI with the
   passphrase secret in its environment, so an unreviewed upstream change is a
   change to code that can read that secret. There are no release tags yet, so
   a commit SHA is the immutable handle — get one with `git rev-parse HEAD` in
   a Veil checkout, or copy the full SHA from the commit page on GitHub.

   ```bash
   # run from the repo root
   COMMIT=<COMMIT-SHA>
   mkdir -p ./tools
   curl -fsSL "https://raw.githubusercontent.com/y4le/veil/$COMMIT/veil.js" -o ./tools/veil.js
   shasum -a 256 ./tools/veil.js | tee ./tools/veil.js.sha256
   ```

   Commit `./tools/veil.js`, its digest file, and the commit SHA (a comment in
   the workflow or a line in the README is enough). Verify the digest after any
   re-download, and in CI if you fetch rather than vendor:

   ```bash
   shasum -a 256 -c ./tools/veil.js.sha256
   ```

   Upgrading Veil means bumping the SHA, re-recording the digest, and reviewing
   the diff — the same bar as any other dependency bump.
2. **Add a build step** that runs Veil on your site output.
3. **Store the passphrase** as a CI secret (e.g., `VEIL_PASSPHRASE` in GitHub Actions).
4. **Deploy** the Veil output directory. Serve it over HTTPS — Web Crypto only
   exists in secure contexts, so pages served over plain HTTP cannot decrypt.

For a complete GitHub Pages walkthrough, see [`.agents/skills/veil-integration/references/github-pages.md`](.agents/skills/veil-integration/references/github-pages.md). For public-plus-protected subtree deployments, also see [`.agents/skills/veil-integration/references/protected-zones.md`](.agents/skills/veil-integration/references/protected-zones.md).

## Threat Model

Veil is deterrence on public static hosting, not strong access control. It protects against casual browsing, search indexing, and someone stumbling on the URL. It does **not** protect against:

- Weak passphrases and offline brute-force (the ciphertext is public)
- Host compromise (the host serves the wrapper JS)
- **Any JavaScript running on the origin.** This does not require an injection
  bug. Any script on the origin can read the cached master key from
  `sessionStorage`/`localStorage`, fetch the public wrappers, and decrypt them
  — including a third-party analytics tag or chat widget on a *public* page of
  a selective (`--html-root`) deployment, which never sees a passphrase prompt
  and may not feel like part of the protected site at all. A stored master key
  is password-equivalent access to that site. `sessionStorage` limits how long
  the key survives, not which scripts may read it. Give protected content its
  own origin — which means its own *hostname* (a dedicated custom domain or
  subdomain, which GitHub Pages supports per repository). A project site at
  the default `username.github.io/repo` location is not one: all of an
  owner's default-location project sites share the `username.github.io`
  origin and its storage. Run no third-party JS anywhere on the protected
  origin. Veil's CSP blocks `<script src>` on protected pages, but the
  public pages sharing the origin are yours to police.
- Metadata leakage: page count, file sizes, directory structure, public asset
  paths, and the payload's `path` field, which is the page's public URL path

The right mental model: the alternative was leaving it fully public.

## See Also

[StatiCrypt](https://github.com/robinmoisson/staticrypt) is a more established tool in this space with custom templates, share links, and a decrypt mode. Veil differs in a few ways:

- **Authenticated encryption** — Veil uses AES-256-GCM (detects tampered ciphertext); StatiCrypt uses AES-256-CBC (confidentiality only).
- **Envelope encryption** — Veil caches a site-specific master key in the browser, never the raw passphrase. StatiCrypt stores a salted password hash.
- **Auto-inlining** — Veil inlines local CSS/JS into each encrypted page automatically.
- **Selective encryption** — `--html-root` encrypts subtrees while leaving other pages public.
- **Zero dependencies** — Veil is a single file with no npm install.

If you need custom prompt templates, share links, or configurable remember-me expiry, StatiCrypt is the more mature choice. If you want authenticated encryption, auto-inlining, subtree control, or a single vendorable file, Veil is a better fit.

## Requirements

- Node.js 18+ (running `veil.js` itself)
- No runtime npm dependencies
- Development only: Node.js 20+ and Playwright (`npm install` +
  `npx playwright install chromium`) for the browser test suite
