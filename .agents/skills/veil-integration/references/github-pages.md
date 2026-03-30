# GitHub Pages — Full-Site Encryption

Encrypt every HTML file in a GitHub Pages site behind a single passphrase. This is the most common Veil setup.

## Prerequisites

- A GitHub repo with static HTML content (source files or build output)
- Node.js 18+ available in CI
- `veil.js` vendored into the repo (e.g., at `./tools/veil.js`)

### Setting Up GitHub Pages (if not already enabled)

1. Go to **Settings > Pages** in the repo
2. Set **Source** to **GitHub Actions**
3. No need to select a branch — the workflow handles artifact upload directly

## Repository Layout

```
my-repo/
├── site/                # HTML content (source or build output)
│   ├── index.html
│   ├── about.html
│   └── css/style.css
├── tools/
│   └── veil.js          # Vendored Veil CLI
└── .github/
    └── workflows/
        └── deploy.yml
```

## Set the Passphrase Secret

```bash
gh secret set VEIL_PASSPHRASE --repo owner/repo
```

Enter the passphrase when prompted. This value never appears in logs or workflow files.

## GitHub Actions Workflow

```yaml
name: Deploy encrypted site

on:
  push:
    branches: [main]

permissions:
  contents: read
  pages: write
  id-token: write

concurrency:
  group: pages
  cancel-in-progress: false

jobs:
  deploy:
    environment:
      name: github-pages
      url: ${{ steps.deployment.outputs.page_url }}
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: '20'

      # If the site has a build step, run it here and point Veil
      # at the build output directory instead of ./site:
      #
      # - name: Build site
      #   run: npm run build
      #
      # Then change ./site below to your build output dir.

      - name: Encrypt site
        run: |
          node ./tools/veil.js ./site ./_encrypted \
            --passphrase-env VEIL_PASSPHRASE \
            --id ${{ github.event.repository.name }}
        env:
          VEIL_PASSPHRASE: ${{ secrets.VEIL_PASSPHRASE }}

      - uses: actions/configure-pages@v5
      - uses: actions/upload-pages-artifact@v4
        with:
          path: ./_encrypted
      - id: deployment
        uses: actions/deploy-pages@v4
```

## With a Build Step

If the site uses Jekyll, Hugo, Vite, or another generator, add the build before encryption:

```yaml
- name: Build site
  run: bundle exec jekyll build -d ./_site_plain

- name: Encrypt site
  run: |
    node ./tools/veil.js ./_site_plain ./_encrypted \
      --passphrase-env VEIL_PASSPHRASE \
      --id ${{ github.event.repository.name }}
  env:
    VEIL_PASSPHRASE: ${{ secrets.VEIL_PASSPHRASE }}
```

The key rule: Veil runs on **build output**, not on source files.

## Local Verification

Test locally before pushing to CI:

```bash
VEIL_PASSPHRASE="testpass" node ./tools/veil.js ./site ./_encrypted \
  --passphrase-env VEIL_PASSPHRASE \
  --id my-project

python3 -m http.server 8765 --directory ./_encrypted
```

Open `http://127.0.0.1:8765` and verify:

- Every page shows the Veil passphrase prompt
- Correct passphrase unlocks content
- Wrong passphrase shows an error and stays locked
- After unlocking one page, other pages auto-unlock within the same session
- Closing and reopening the tab returns to the locked state (unless `--remember` was used)

## Common Options

### Remember device by default

```bash
node ./tools/veil.js ./site ./_encrypted \
  --passphrase-env VEIL_PASSPHRASE \
  --id my-project \
  --remember
```

### Skip CSS/JS inlining

If auto-inlining causes issues with large bundles or complex asset paths:

```bash
node ./tools/veil.js ./site ./_encrypted \
  --passphrase-env VEIL_PASSPHRASE \
  --id my-project \
  --no-inline
```

## Next Steps

If parts of the site should stay public while other sections are individually protected, see [Protected Zones](protected-zones.md).
