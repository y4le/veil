# Veil

Encrypt static HTML sites at build time. Veil wraps each HTML file in a self-contained shell that prompts for a passphrase and decrypts client-side using Web Crypto. No server, no dependencies, one file.

**Good for:** client previews, trip plans, proposal decks, private-ish docs, prototypes on static hosting.

**Not for:** regulated data, identity-based access control, or protecting against a compromised host.

> [!WARNING]
> **Veil is deterrence, not absolute security.** It protects against casual browsing and search indexing. It does **not** protect against a compromised host or weak passphrases. **Only HTML files are encrypted;** images, CSS, and JS files remain public in the output directory.

## Quick Start

```bash
# Encrypt a site
node veil.js ./my-site ./encrypted --passphrase "secret" --id my-project

# Serve and test
python3 -m http.server 8765 --directory ./encrypted
```

Open `http://127.0.0.1:8765` — every page prompts for the passphrase, then decrypts in the browser.

## How It Works

1. Veil reads a directory of HTML files and inlines local CSS/JS into each page.
2. It generates a random site master key, wraps it with a key derived from your passphrase (PBKDF2 + AES-256-GCM), and encrypts each HTML file with the master key.
3. Each encrypted file is replaced with a self-contained wrapper that carries the ciphertext and a minimal unlock UI.
4. In the browser, the wrapper derives the same key from the passphrase, unwraps the master key, decrypts the page, and caches the key for the session so other pages unlock automatically.

Non-HTML files (images, fonts, data) are copied as-is. They remain public.

## CLI

```
Usage: veil <input-dir> <output-dir> [options]

Options:
  --passphrase <pass>   Set passphrase (omit to prompt interactively)
  --passphrase-env <n>  Read passphrase from environment variable <n>
  --id <site-id>        Storage key scope (default: output dir basename)
  --iterations <N>      PBKDF2 iteration count (default: 600000)
  --remember            Default "Remember this device" to checked
  --html-root <dir>     Encrypt only HTML under this relative dir (repeatable)
  --no-inline           Skip local CSS/JS inlining
  --help                Show this help
```

### CI Usage

In CI, always use `--passphrase-env` to read from a secret — never pass the passphrase as a CLI argument:

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

If the agent can read the Veil repo, that bootstrap doc is the primary entry point. It tells the agent how to fetch `veil.js`, detect full-site versus protected-zone setups, wire CI, and verify the result.

If the Veil repo is private or the agent does not have GitHub access, a raw GitHub URL will not work. In that case:

- give the agent local access to this repo checkout
- paste the contents of [`.agents/AGENT.md`](.agents/AGENT.md)
- or copy `.agents/` into the target repo so the skill is local

For the cleanest “give the agent one URL and let it handle the rest” workflow, Veil itself needs to be publicly readable or mirrored somewhere the agent can fetch without extra auth.

The repo-local skill lives at [`.agents/skills/veil-integration/SKILL.md`](.agents/skills/veil-integration/SKILL.md). That is the right path when you want future agents working inside the target repo to discover the integration guidance automatically.

### Option B: Manual setup

1. **Vendor `veil.js`** into your project (e.g., `./tools/veil.js`).
2. **Add a build step** that runs Veil on your site output.
3. **Store the passphrase** as a CI secret (e.g., `VEIL_PASSPHRASE` in GitHub Actions).
4. **Deploy** the Veil output directory.

For a complete GitHub Pages walkthrough, see [`.agents/skills/veil-integration/references/github-pages.md`](.agents/skills/veil-integration/references/github-pages.md). For public-plus-protected subtree deployments, also see [`.agents/skills/veil-integration/references/protected-zones.md`](.agents/skills/veil-integration/references/protected-zones.md).

## Threat Model

Veil is deterrence on public static hosting, not strong access control. It protects against casual browsing, search indexing, and someone stumbling on the URL. It does **not** protect against:

- Weak passphrases and offline brute-force (the ciphertext is public)
- Host compromise (the host serves the wrapper JS)
- Same-origin XSS (can read browser storage)
- Metadata leakage (page count, file sizes, directory structure)

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

- Node.js 18+
- No npm dependencies
