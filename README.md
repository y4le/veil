# Veil

Encrypt static HTML sites at build time. Veil wraps each HTML file in a
self-contained shell that prompts for a passphrase and decrypts client-side
using Web Crypto. No server, no dependencies, one file.

**Good for:** client previews, trip plans, proposal decks, private-ish docs,
prototypes on static hosting.

**Not for:** regulated data, identity-based access control, or protecting
against a compromised host.

> [!WARNING]
> **Veil is deterrence, not absolute security.** It protects against casual
> browsing and search indexing. It does **not** protect against a compromised
> host, weak passphrases, or any JavaScript running on the same origin; a script
> there can read the cached key out of browser storage and decrypt the site.
> **Only HTML is encrypted**; images, fonts, and data files stay public, and so
> do page count, file sizes, and directory structure. Read the
> [threat model](docs/threat-model.md) before publishing anything you care about.

## Quick start

```bash
read -rs VEIL_PASSPHRASE && export VEIL_PASSPHRASE   # typed, not in shell history

# Encrypt a site into a fresh output directory
node veil.js ./my-site ./encrypted --passphrase-env VEIL_PASSPHRASE --id my-project

# Audit what you are about to publish
node veil.js verify ./encrypted --input ./my-site --id my-project \
  --passphrase-env VEIL_PASSPHRASE

# Serve and test
python3 -m http.server 8765 --directory ./encrypted
```

Open `http://127.0.0.1:8765`; every page prompts for the passphrase, then
decrypts in the browser. Omitting both passphrase options prompts interactively
instead.

## Documentation

| Guide | What it covers |
|---|---|
| [Getting started](docs/getting-started.md) | First encrypt, audit, unlock, and troubleshooting |
| [How it works](docs/how-it-works.md) | Inlining, envelope encryption, the wrapper, unlock state |
| [CLI reference](docs/cli.md) | Every option for both commands, and build behavior |
| [Verifying a build](docs/verify.md) | What the audit proves, finding codes, chained zones |
| [Threat model](docs/threat-model.md) | The security boundary, in full |
| [Integration](docs/integration.md) | Vendoring, pinning, CI, deploying |

Host walkthroughs: [GitHub Pages](.agents/skills/veil-integration/references/github-pages.md)
for a full site, [protected zones](.agents/skills/veil-integration/references/protected-zones.md)
for a public site with individually locked sections. Coding agents should start
from [`.agents/AGENT.md`](.agents/AGENT.md).

## Alternatives

[StatiCrypt](https://github.com/robinmoisson/staticrypt) is the more established
tool in this space, with custom templates, share links, and configurable
remember-me expiry. Veil differs in being a single vendorable file with
authenticated encryption, a cached site key rather than a stored password hash,
automatic CSS/JS inlining, and subtree control.

## Requirements

Node.js 18+, and a host that serves over HTTPS. No runtime dependencies.

## Development

`npm test` runs the zero-dependency Node suite. The browser suite needs Node 20+
and Playwright (`npm install && npx playwright install chromium`), then
`npm run test:browser`; Playwright is a dev dependency only, and the shipped file
stays dependency-free. [`PLAN.md`](PLAN.md) is the product and engineering plan.
