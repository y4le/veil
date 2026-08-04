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
- Veil encrypts directories of HTML files and copies non-HTML assets through, minus the assets it can prove are unreachable (see Asset Strategy).
- Local CSS and JS are inlined by default so protected HTML wrappers can stand on their own. Encrypted HTML and inlined assets must be valid UTF-8; anything else fails the build rather than being silently mangled.
- The crypto model uses site-level envelope encryption: a random site master key `MK`, a passphrase-derived `KEK`, and `AES-256-GCM` for both wrapping and page encryption.
- Format v2: JSON-array AADs with separate `wrap`/`page` domains, and each page bound to its output-relative path (also carried as the payload's `path` field).
- The output directory is a fresh artifact. Veil builds into a temporary sibling directory and moves it into place on success; a non-empty destination is refused unless `--force` is passed, and symlinks inside the input tree are rejected outright.
- The runtime wrapper supports prompt-based unlock, shared site-wide unlock state, `sessionStorage` by default, optional persistent remember-device behavior, a lock button, and `?veil=logout`. It reports a clear error instead of hanging when Web Crypto is unavailable (non-secure context).
- Public wrappers carry a constant "Protected page" title and a `noindex` robots meta; the wrapper's meta CSP survives `document.write` and therefore governs decrypted pages, blocking every `<script src>`.
- The CLI supports `--passphrase-env`, `--id`, `--iterations`, `--remember`, `--html-root`, `--no-inline`, `--force`, `--version`, and `--help`. Parsing is strict (unknown options and missing values are fatal, not guessed), interactive passphrase entry is confirmed, and startup warnings cover `--passphrase` visibility, below-default iteration counts, and generic inferred site ids.
- `veil verify <output-dir>` audits a built artifact. It is fail-closed (every HTML file in the audited scope must be a valid, current-format wrapper sealed for its own path, byte-identical to the wrapper Veil would generate for its payload), checks site-metadata consistency and IV uniqueness across the scope, and optionally adds correspondence checks against the input tree (`--input`) and a real decryption pass (`--passphrase-env`, `--prompt-passphrase`). Exit codes are 0/1/2 and `--json` emits a report with stable finding codes.
- `veil.js` guards `main()` behind `require.main` and exports its pure/crypto/payload surface (`buildAad`, `generateSiteKeys`, `encryptPage`, `buildPayloadMeta`, `validatePayload`, `generateWrapper`, `extractPayload`, `decryptPayload`, the inlining helpers), so it can be required as a library and used for verification tooling.
- Two test suites: the zero-dependency Node suite (`npm test`) and a dev-only Playwright browser suite (`npm run test:browser`) that exercises the real runtime — Web Crypto, `document.write`, the CSP, storage tiers, logout, and the unlock form. Playwright is a dev dependency only; the shipped artifact stays zero-dependency.
- The tool has been exercised against a GitHub Pages-style subtree deployment.

### Current limits

- Non-HTML assets remain public unless handled separately; only provably-unreachable inlined CSS/JS is dropped.
- Multiple protected zones require chaining CLI invocations through successive output directories; there is no manifest/config mode yet.
- There is no built-in local dev server or decrypt command; `veil verify` audits an artifact but never writes plaintext out, and the browser half of verification stays manual.
- There is no published npm package; the exported library surface is a testability seam, not a committed public API.
- Persistent unlock state still relies on browser storage, so any JS on the origin remains a meaningful risk.
- Payload authentication binds a page to its path, but whole-tuple or whole-file substitution and rollback to an earlier build remain out of scope.

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
- any JavaScript running on the origin — not just injected XSS, but third-party
  tags on public pages of a selective deployment — reading the cached `MK` from
  browser storage and decrypting the public wrappers
- metadata leakage from page count, file sizes, public asset paths, directory
  structure, and each payload's `path` field (the page's public URL path)

This is the right tool when the alternative is “leave it public and hope nobody notices.”

## Why The Architecture Works

### Browser support is good enough

Modern browsers support `crypto.subtle` broadly, but only in secure contexts. That makes HTTPS mandatory, which static hosts already satisfy. The native primitives Veil needs are available:

- `PBKDF2` for passphrase-derived keys
- `AES-GCM` for authenticated encryption

### Static hosts are a carrier, not a trust boundary

GitHub Pages and similar hosts are a good way to publish encrypted artifacts, but they are not an enforcement boundary. The host can always serve modified wrapper code. Veil works because the content stays encrypted at rest on the public host, not because the host is trusted.

### The real tradeoff is browser storage

`localStorage` and `sessionStorage` are convenient, but any JS on the origin can read them — no injection bug required, and a third-party tag on a *public* page of a selective deployment counts. A cached `MK` is password-equivalent access to that site, and `sessionStorage` shortens its lifetime without narrowing which scripts may read it. That means “remember this device” is acceptable only as a convenience feature, not as real security. Veil defaults to `sessionStorage`, makes persistent storage opt-in, and the guidance is a dedicated origin for protected content with no third-party JS anywhere on it.

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

1. Reads the input directory, rejecting any symlink inside it. Files it encrypts or inlines must be valid UTF-8; passthrough files are copied byte-for-byte and not decoded.
2. Inlines local CSS and JS into each HTML file unless `--no-inline` is set.
3. Generates one random 256-bit site master key `MK`.
4. Derives a 256-bit `KEK` from the passphrase using `PBKDF2-HMAC-SHA256`, a random site salt, and a configurable iteration count.
5. Wraps `MK` with `KEK`.
6. Encrypts each HTML document using `AES-256-GCM` with `MK`, a fresh random IV per file, and an AAD binding the page to its output-relative path.
7. Emits one encrypted wrapper HTML per input HTML file, into a temporary staging directory.
8. Copies non-HTML assets, minus the ones inlining proved unreachable.
9. Publishes the staging directory over the output path on success — replacing a non-empty destination only with `--force` — and deletes it on failure, so a failed build never leaves a half-written artifact.

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
| Format version | integer (`2`) | Allows forward-compatible wrapper changes |
| AAD | `JSON.stringify(['veil', v, siteId, 'wrap'])` / `(['veil', v, siteId, 'page', path])` | Domain-separated; pages are bound to their output-relative path, so a ct/IV pair moved to another page's payload fails to authenticate. Whole-tuple/whole-file substitution and rollback remain out of scope. |

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

One key is used, built from the payload's own format version:

```text
veil:v2:<site-id>:mk
```

`<site-id>` defaults to the output directory basename, with `--id` to override it explicitly. Veil warns when an inferred id is a generic build-directory name (`dist`, `public`, `_site`, …), since those collide on a shared origin.

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
- require UTF-8 for HTML being encrypted and CSS/JS being inlined, failing the build otherwise; passthrough files are copied byte-for-byte and never decoded
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
  --force               Replace a non-empty output directory
  --version             Print the veil version
  --help                Show this help
```

Unknown options and options missing their value are fatal rather than guessed,
so `--id --force` is a forgotten argument, not a site id of `--force`.

Examples:

Interactive local run (the passphrase is typed twice and confirmed):

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
- multiple protected zones are handled by chaining Veil invocations through
  successive output directories (each run's output is the next run's input);
  two runs cannot share one output directory, because the second would refuse
  the non-empty destination and `--force` would discard the first zone
- pass `--force` in pipelines that reuse a build directory across runs

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
12. Audit a built artifact with `veil verify` before it is published.

## Near-Term Roadmap

1. Add a config or manifest mode so multiple protected zones can be declared in
   one run instead of chained through successive output directories.
2. Emit a build manifest recording every path Veil wrote and every asset it
   deliberately omitted, so `veil verify --input` can classify a missing asset
   exactly instead of warning that it might have been inlined.
3. Improve local verification ergonomics further with something like
   `veil serve` and/or `veil decrypt`.
4. Decide whether to publish a package in addition to the canonical single-file CLI.
5. Publish immutable, digest-verifiable artifacts (release tags or signed
   releases) so vendoring does not depend on commit-SHA pinning by hand.

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
