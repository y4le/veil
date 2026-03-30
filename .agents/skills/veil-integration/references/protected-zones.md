# Protected Zones

Use this pattern when parts of a site stay public while one or more sections are individually protected — each with its own passphrase and independent unlock state.

Examples:

- A public landing page with a protected client portal
- A travel site with individually locked trip sections
- A docs site where some sections require different access levels

## How It Works

Veil's `--html-root` flag limits encryption to HTML files under a specific subdirectory. Files outside that directory pass through unmodified. Chain multiple Veil runs to create zones with different passphrases.

## Repository Layout

```
my-repo/
├── site/
│   ├── index.html            # Public
│   ├── about.html            # Public
│   ├── client-a/
│   │   ├── index.html        # Protected (zone: client-a)
│   │   └── report.html       # Protected (zone: client-a)
│   └── client-b/
│       └── index.html        # Protected (zone: client-b)
├── tools/
│   └── veil.js
└── .github/workflows/deploy.yml
```

## Single Protected Zone

One public site with one protected section:

```bash
node ./tools/veil.js ./site ./_encrypted \
  --passphrase-env VEIL_PASSPHRASE_CLIENTS \
  --id client-portal \
  --html-root client-a
```

- `index.html` and `about.html` pass through unencrypted
- Everything under `client-a/` gets encrypted
- `--html-root` is relative to the input directory

## Multiple Protected Zones

Chain Veil runs. Each stage's output becomes the next stage's input:

```bash
# Stage 1: encrypt client-a
node ./tools/veil.js ./site ./_stage1 \
  --passphrase-env VEIL_PASSPHRASE_A \
  --id client-a \
  --html-root client-a

# Stage 2: encrypt client-b
node ./tools/veil.js ./_stage1 ./_encrypted \
  --passphrase-env VEIL_PASSPHRASE_B \
  --id client-b \
  --html-root client-b
```

Each zone has its own `--id` (scopes browser storage independently), its own passphrase, and unlocks independently of other zones.

## GitHub Actions Workflow

```yaml
- name: Encrypt zone A
  run: |
    node ./tools/veil.js ./site ./_stage1 \
      --passphrase-env VEIL_PASSPHRASE_A \
      --id client-a \
      --html-root client-a
  env:
    VEIL_PASSPHRASE_A: ${{ secrets.VEIL_PASSPHRASE_A }}

- name: Encrypt zone B
  run: |
    node ./tools/veil.js ./_stage1 ./_encrypted \
      --passphrase-env VEIL_PASSPHRASE_B \
      --id client-b \
      --html-root client-b
  env:
    VEIL_PASSPHRASE_B: ${{ secrets.VEIL_PASSPHRASE_B }}

- uses: actions/upload-pages-artifact@v4
  with:
    path: ./_encrypted
```

Set one secret per zone:

```bash
gh secret set VEIL_PASSPHRASE_A --repo owner/repo
gh secret set VEIL_PASSPHRASE_B --repo owner/repo
```

## Shared Assets

If protected pages reference CSS, JS, or images outside their subtree, Veil needs the full site as input to resolve asset paths for inlining. `--html-root` only controls which HTML files get encrypted — Veil still sees the entire input directory for asset resolution.

Example: if `client-a/index.html` links to `../css/style.css`, passing the full `./site` directory as input (not just `./site/client-a`) lets Veil inline that stylesheet correctly.

## Verification

For each zone, verify:

- Public routes render without a passphrase prompt
- Protected routes show the prompt and unlock with the correct zone passphrase
- Zone A's passphrase does **not** unlock zone B
- Each zone's unlock state is independent
- Wrong passphrases show an error and stay locked
- Closing and reopening the tab returns protected routes to the locked state

## Naming Conventions

| Concept | Flag | Suggested pattern |
|---------|------|-------------------|
| Zone ID | `--id` | Descriptive and stable: `client-portal`, `trip-2026-japan` |
| Secret name | `--passphrase-env` | `VEIL_PASSPHRASE_<ZONE>` in uppercase |
| Subtree path | `--html-root` | Match the directory name in the site |
