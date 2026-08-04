# Veil Plan

This document is the canonical product and engineering plan for Veil. It describes what exists today, the research-backed constraints that shape the tool, and the next work worth doing.

## What Veil Is

Veil is a lightweight build tool for **semi-private static sites**.

It encrypts HTML at build time, ships a thin browser-side wrapper, prompts once for a passphrase, and optionally remembers an unlock secret for later visits. The target hosts are static platforms like GitHub Pages, Netlify, Cloudflare Pages, and S3.

The right framing is:

- **yes**: client previews, trip plans, proposal decks, private-ish docs, prototypes
- **no**: real authentication, regulated data, identity-based access control, protection against a host serving malicious JS

## Product Thesis

There is a real gap between:

- tools like `staticrypt` and `pagecrypt`, which validate the pattern but skew toward single-page flows or different storage and crypto tradeoffs
- full auth systems, which are much heavier than needed for “share a URL and a passphrase”

Veil’s value is a cleaner opinionated middle ground:

- zero-dependency build tool
- single-file CLI
- browser-native crypto only
- multi-page static-site support
- auto-inlining of local CSS and JS
- shared unlock state across pages
- no raw passphrase persisted in browser storage

## Current State

### Implemented now

- `veil.js` is a working single-file Node CLI with no runtime dependencies.
- Veil encrypts directories of HTML files and copies non-HTML assets through unchanged.
- Local CSS and JS are inlined by default so protected HTML wrappers can stand on their own.
- The crypto model uses site-level envelope encryption: a random site master key `MK`, a passphrase-derived `KEK`, and `AES-256-GCM` for both wrapping and page encryption.
- The runtime wrapper supports prompt-based unlock, shared site-wide unlock state, `sessionStorage` by default, optional persistent remember-device behavior, a lock button, and `?veil=logout`.
- The CLI already supports `--passphrase-env`, `--id`, `--iterations`, `--remember`, `--html-root`, and `--no-inline`.
- A test suite exists, including regression coverage for wrapper payload encoding.
- The tool has been exercised against a GitHub Pages-style subtree deployment.

### Current limits

- Non-HTML assets remain public unless handled separately.
- Multiple protected zones require multiple CLI invocations; there is no manifest/config mode yet.
- There is no built-in local dev server or decrypt/inspect helper command.
- There is no published npm package or programmatic API yet.
- Persistent unlock state still relies on browser storage, so same-origin JS remains a meaningful risk.

## Design Principles

1. **Zero dependencies.** Node.js stdlib only at build time; no browser crypto libraries.
2. **Single-file CLI.** One `veil.js` can run directly with `node`.
3. **Browser-native crypto.** Web Crypto API in the browser, Node `crypto` at build time.
4. **Low friction.** Prompt once, then auto-unlock later using a cached site key.
5. **Multi-page first.** Encrypt directories of HTML, not just one landing page.
6. **Self-contained wrappers.** Encrypted HTML files carry their own runtime shell.
7. **No raw passphrase in storage.** Cache a site-specific key, not the user’s original secret.
8. **Honest threat model.** The docs describe this as deterrence on public static hosting, not strong access control.

## Threat Model

Veil protects against:

- casual browsing
- search indexing
- someone finding the public URL
- basic scraping

Veil does not protect against:

- weak passphrases and offline brute-force
- repo compromise
- host compromise serving modified JS
- same-origin XSS reading browser storage
- metadata leakage from page count, file sizes, public asset paths, and directory structure

This is the right tool when the alternative is “leave it public and hope nobody notices.”

## Why The Architecture Works

### Browser support is good enough

Modern browsers support `crypto.subtle` broadly, but only in secure contexts. That makes HTTPS mandatory, which static hosts already satisfy. The native primitives Veil needs are available:

- `PBKDF2` for passphrase-derived keys
- `AES-GCM` for authenticated encryption

### Static hosts are a carrier, not a trust boundary

GitHub Pages and similar hosts are a good way to publish encrypted artifacts, but they are not an enforcement boundary. The host can always serve modified wrapper code. Veil works because the content stays encrypted at rest on the public host, not because the host is trusted.

### The real tradeoff is browser storage

`localStorage` and `sessionStorage` are convenient, but same-origin JS can read them. That means “remember this device” is acceptable only as a convenience feature, not as real security. Veil defaults to `sessionStorage` and makes persistent storage opt-in.

## Core Architecture

### Summary

Veil uses **site-level envelope encryption**:

1. Generate one random site master key `MK`.
2. Derive a key-encryption key `KEK` from the passphrase.
3. Wrap `MK` with `KEK`.
4. Encrypt each page with `MK`.
5. Cache `MK` after unlock instead of storing the raw passphrase.

This keeps the UX simple while avoiding raw-passphrase persistence.

### Build-time flow

For each build, Veil:

1. Reads the input directory.
2. Inlines local CSS and JS into each HTML file unless `--no-inline` is set.
3. Generates one random 256-bit site master key `MK`.
4. Derives a 256-bit `KEK` from the passphrase using `PBKDF2-HMAC-SHA256`, a random site salt, and a configurable iteration count.
5. Wraps `MK` with `KEK`.
6. Encrypts each HTML document using `AES-256-GCM` with `MK` and a fresh random IV per file.
7. Emits one encrypted wrapper HTML per input HTML file.
8. Copies non-HTML assets unchanged.

### Runtime flow

When a protected page loads, Veil:

1. Checks for a cached `MK` in `sessionStorage`.
2. If not found, checks `localStorage`.
3. If found, tries decrypting immediately.
4. If decrypt succeeds, replaces the document using `document.open()`, `document.write()`, and `document.close()`.
5. If decrypt fails or no cached key exists, shows the passphrase prompt.
6. On successful prompt submission, derives `KEK`, unwraps `MK`, decrypts the page, and caches `MK`.
7. If the user checked “Remember this device,” persists `MK` to `localStorage`; otherwise keeps it in `sessionStorage` only.

### Why envelope encryption is the right choice

It is better than deriving a different content key directly from the passphrase for every page:

- the browser never needs to persist the raw passphrase
- all pages share one unlock state
- passphrase rotation is cleaner
- the cached secret is site-specific
- the crypto model matches standard KEK/DEK guidance more closely

## Crypto Design

### Key hierarchy

```text
passphrase
    |
    v  PBKDF2-HMAC-SHA256 (+ site salt, iterations)
   KEK
    |
    v  AES-256-GCM unwrap
   MK
    |
    v  AES-256-GCM (+ per-file IV)
  page content
```

### Defaults

| Parameter | Value | Notes |
|---|---|---|
| Page encryption | AES-256-GCM | Authenticated encryption |
| MK wrapping | AES-256-GCM | Reuse native primitives already available |
| KDF | PBKDF2-HMAC-SHA256 | Native in Node and browser |
| PBKDF2 iterations | `600000` default | Persisted in payload metadata (~500ms delay on modern hardware) |
| KEK salt | 16 random bytes per build | Shared across pages in the same build |
| Page IV | 12 random bytes per file | Never reused with same key |
| Wrap IV | 12 random bytes per build | Used to wrap `MK` |
| MK size | 32 bytes | Random 256-bit site key |
| Format version | integer | Allows forward-compatible wrapper changes |

### Iteration strategy

The static-host threat model means the ciphertext is public, so attackers can guess offline. Veil:

- defaults to `600000`
- allows `--iterations <N>`
- persists the iteration count in the payload
- trades stronger brute-force resistance against unlock latency

Longer term, Argon2id or scrypt via WASM can be offered as an opt-in stronger mode. PBKDF2 remains the right default because it is native everywhere Veil needs to run.

## Storage Model

### What gets stored

The browser stores **`MK`**, not the raw passphrase.

If storage is compromised, the attacker gains the ability to decrypt this site on this origin, but does not learn the user’s original passphrase for reuse elsewhere.

### Storage tiers

| Tier | Mechanism | Lifetime | Default |
|---|---|---|---|
| Fast unlock | `sessionStorage` | Current tab/session | Yes |
| Remember device | `localStorage` | Persistent | No |
| Future hardening | IndexedDB `CryptoKey` | Persistent | No |

### Key scoping

Storage keys must be site-scoped because project sites under `username.github.io` share the same origin.

Recommended keys:

```text
veil:v1:<site-id>:mk
veil:v1:<site-id>:meta
```

`<site-id>` defaults to the output directory basename, with a CLI flag to override it explicitly.

### Logout and recovery

Veil supports both:

- `?veil=logout`
- a small lock icon in the prompt or decrypted page

If decryption fails because the cached key is stale, corrupt, or from an older build, Veil clears cached state automatically and shows the prompt again.

## Wrapper Design

The wrapper is intentionally small:

- inline JS only
- inline CSS only
- no external scripts
- no external fonts
- minimal prompt UI

Expected prompt behavior:

- password input
- Enter-to-submit
- “Remember this device” checkbox
- decrypting state
- wrong-passphrase error state
- hidden by default so successful auto-unlock does not flash the prompt

The wrapper uses a constant title ("Protected page") plus a `noindex` robots meta so page titles never leak into the public artifact; the real title returns with the decrypted document. The wrapper emits a meta CSP that persists through `document.write` and therefore governs decrypted pages as well: same-origin passive assets and inline scripts are allowed, all `<script src>` loads are blocked.

## Asset Strategy

The HTML wrappers are self-contained, but the output directory is not necessarily fully self-contained unless assets are inlined too.

Policy:

- inline local CSS and JS by default (relative and root-relative, quoted and unquoted)
- rewrite relative `url()`/`@import` inside inlined CSS to stay page-resolvable
- leave external URLs untouched, with a build warning for the scripts and stylesheets the page CSP will block (cross-origin images and fonts referenced from CSS are blocked too, but are not individually reported)
- require UTF-8 for HTML and inlined assets; fail the build otherwise
- copy non-HTML assets as-is, except assets inlined everywhere and referenced by nothing public — those are omitted (inlined JS is omitted only when the whole site is encrypted (no public HTML) and no other JS survives publicly, since module graphs and inline event handlers are not scanned)
- warn clearly that copied assets remain public

This is the main place where the docs must stay precise. “Self-contained output” is true for encrypted HTML wrappers, but not for every file in the output directory unless image and data inlining are added later.

## Hardening Guidance

### CSP

Veil emits a baseline `<meta http-equiv="Content-Security-Policy">` for the wrapper shell. This is useful on static hosts, but it is not the same as a full header-based CSP and cannot use the ideal nonce pattern with a purely static file.

Practical guidance:

- wrapper shell: strict as possible
- decrypted pages: avoid third-party scripts entirely
- hosts with header control: prefer a real response-header CSP

### Third-party JS

Any JS that runs on the decrypted page can read `sessionStorage` and `localStorage`. Analytics tags, comments widgets, and runtime embeds directly weaken the entire storage model. The safe default is “none.”

### SRI

If external assets must remain, document Subresource Integrity as the baseline requirement.

## CLI Surface

```text
Usage: veil <input-dir> <output-dir> [options]

Options:
  --passphrase <pass>   Set passphrase (omit to prompt interactively)
  --passphrase-env <n>  Read passphrase from environment variable <n>
  --id <site-id>        Storage key scope (default: output dir basename)
  --iterations <N>      PBKDF2 iteration count (default: 600000)
  --remember            Check "Remember this device" by default
  --html-root <dir>     Encrypt only HTML under this input-relative dir (repeatable)
  --no-inline           Skip local CSS/JS inlining
  --help                Show help
```

Examples:

Interactive local run:

```bash
node veil.js ./site ./public --id my-project
```

CI-friendly subtree protection:

```bash
node veil.js ./_site_plain ./_site_secure \
  --passphrase-env VEIL_PASSPHRASE_CHINA \
  --id travel-2026-china \
  --html-root 2026-china/web
```

## Current Product Shape

Veil is currently a single-file CLI with a narrow, deliberate scope.

That is the right primary shape for now:

- easy to vendor into another repo
- easy to run in CI without packaging work
- low maintenance surface
- aligned with the “static hosting, low friction” use case

The design still leaves room for a slightly broader shape later:

- optional npm package
- future `@veil/core` programmatic API
- future Vite or SSG integration hooks

The differentiator is not “another password page.” It is “a clean multi-page static-site encryption workflow with low-friction unlock and sensible crypto and storage defaults.”

## GitHub Pages Workflow

The intended deployment model is:

1. keep source HTML in a private repo
2. build a normal staged site
3. run Veil on that staged output
4. publish only encrypted output to Pages
5. share the URL and passphrase separately

Minimal workflow shape:

```yaml
name: Deploy encrypted pages

on:
  push:
    branches: [main]

permissions:
  contents: read
  pages: write
  id-token: write

jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'
      - name: Build public site
        run: ./scripts/build-pages.sh ./_site_plain
      - name: Encrypt protected pages
        run: node ./tools/veil.js ./_site_plain ./_site_secure --passphrase-env VEIL_PASSPHRASE_CHINA --id travel-2026-china --html-root 2026-china/web
        env:
          VEIL_PASSPHRASE_CHINA: ${{ secrets.VEIL_PASSPHRASE_CHINA }}
      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v4
        with:
          path: ./_site_secure
      - uses: actions/deploy-pages@v4
```

Operational notes:

- store passphrases in GitHub Actions secrets
- use `--passphrase-env`, not `--passphrase`, in CI
- scope storage keys by repo or explicit site ID
- use `--html-root` when only part of the published site should be protected
- passphrase rotation is “change secret, rebuild, re-share passphrase”
- multiple protected zones can be handled by chaining Veil invocations

## Comparison With Existing Tools

| | StatiCrypt | Pagecrypt | Veil |
|---|---|---|---|
| Primary shape | Single-page/static wrapper | Single-file HTML / SPA | Multi-page static-site build tool |
| Browser crypto | Web Crypto / older AES-CBC lineage | Web Crypto | Web Crypto |
| Storage default | `localStorage` remember-me pattern | `sessionStorage` | `sessionStorage`, with opt-in `localStorage` |
| Raw passphrase stored? | Password-equivalent remember state | No | No |
| Asset handling | Manual | Recommends inlining | Auto-inline local CSS/JS |
| Unlock scope | Page-oriented | Single app/page | Shared site-wide unlock state |
| Dependencies | npm install path | npm install path | Zero-dependency single-file CLI |
| Crypto model | Direct password flow | Direct key flow | Envelope encryption with site `MK` |

The market gap is not raw capability. It is developer ergonomics plus better defaults for this exact use case.

## Current Scope

The current scope is intentionally narrow and opinionated:

1. Encrypt a directory of HTML files.
2. Inline local CSS and JS.
3. Use envelope encryption with one site `MK`.
4. Use AES-256-GCM everywhere.
5. Use PBKDF2-HMAC-SHA256 with a persisted iteration count.
6. Default to `sessionStorage`.
7. Offer opt-in persistent remember-device behavior via `localStorage`.
8. Cache `MK`, never the raw passphrase.
9. Support explicit logout.
10. Support HTML-subtree protection inside a larger staged site.
11. Ship as a zero-dependency single-file CLI.

## Near-Term Roadmap

1. Tighten docs and examples around GitHub Pages and other staged-output deploys.
2. Add a config or manifest mode so multiple protected zones can be declared in one run.
3. Improve local verification ergonomics with something like `veil serve` and/or `veil decrypt`.
4. Decide whether to publish a package in addition to the canonical single-file CLI.
5. Expand automated verification around real browser flows and end-to-end fixture sites.

## Future Work

Good future additions:

- image inlining as data URIs
- custom wrapper templates
- password hint text
- expiry and time-lock behavior
- multiple passphrases per zone
- Argon2id or scrypt via WASM
- IndexedDB `CryptoKey` persistence
- SRI generation helpers
- Vite or SSG plugin integration

## Sources

- GitHub Pages HTTPS and visibility: https://docs.github.com/en/enterprise-cloud%40latest/pages/getting-started-with-github-pages/securing-your-github-pages-site-with-https
- MDN `SubtleCrypto`: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto
- MDN `SubtleCrypto.deriveKey()`: https://developer.mozilla.org/en-US/docs/Web/API/SubtleCrypto/deriveKey
- MDN `AesGcmParams`: https://developer.mozilla.org/en-US/docs/Web/API/AesGcmParams
- MDN `Pbkdf2Params`: https://developer.mozilla.org/en-US/docs/Web/API/Pbkdf2Params
- MDN Content Security Policy guide: https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/CSP
- MDN `<meta http-equiv>` / meta CSP: https://developer.mozilla.org/en-US/docs/Web/HTML/Reference/Elements/meta/http-equiv
- MDN Subresource Integrity: https://developer.mozilla.org/en-US/docs/Web/Security/Defenses/Subresource_Integrity
- OWASP HTML5 Security Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/HTML5_Security_Cheat_Sheet.html
- OWASP Password Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- OWASP Cryptographic Storage Cheat Sheet: https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
- StatiCrypt: https://github.com/robinmoisson/staticrypt
- Pagecrypt (Greenheart): https://github.com/Greenheart/pagecrypt
- PageCrypt (original): https://github.com/lupine-dev/PageCrypt
