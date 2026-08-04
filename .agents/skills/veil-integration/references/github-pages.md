# GitHub Pages — Full-Site Encryption

Encrypt every HTML file in a GitHub Pages site behind a single passphrase. This is the most common Veil setup.

## Prerequisites

- A GitHub repo with static HTML content (source files or build output). The
  tree Veil reads must contain no symlinks, and every HTML file plus any CSS/JS
  it inlines must be valid UTF-8 — both are fatal errors, not warnings
- Node.js 18+ available in CI
- `veil.js` vendored into the repo (e.g., at `./tools/veil.js`) from a **pinned
  commit**, with its SHA and digest recorded — see
  [AGENT.md](../../../AGENT.md#acquiring-veil). Never fetch it from `main` at
  build time: it runs in the same job as the passphrase secret.

GitHub Pages serves over HTTPS, which Veil requires — Web Crypto only exists in
secure contexts. If you front the site with a custom domain, keep "Enforce
HTTPS" on; on plain HTTP the wrapper refuses to decrypt and says so.

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
│   ├── veil.js          # Vendored Veil CLI, pinned to a commit
│   └── veil.js.sha256   # Recorded digest, checked in CI
└── .github/
    └── workflows/
        └── deploy.yml
```

## Set the Passphrase Secret

```bash
gh secret set VEIL_PASSPHRASE --repo owner/repo
```

Enter the passphrase when prompted. This value never appears in logs or workflow files. Pass it to Veil with `--passphrase-env`, never `--passphrase` — Veil warns on stderr that a CLI-supplied passphrase is visible in process listings and shell history.

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

      # Vendored from raw.githubusercontent.com/y4le/veil/<COMMIT-SHA>/veil.js
      - name: Verify vendored Veil
        run: shasum -a 256 -c ./tools/veil.js.sha256

      - name: Encrypt site
        run: |
          node ./tools/veil.js ./site ./_encrypted \
            --passphrase-env VEIL_PASSPHRASE \
            --id ${{ github.event.repository.name }}
        env:
          VEIL_PASSPHRASE: ${{ secrets.VEIL_PASSPHRASE }}

      - name: Assert every page is encrypted
        # Uses Veil's own classifier and payload parser rather than a grep
        # marker: catches any-case extensions and invalid payloads alike.
        run: |
          node -e '
            const fs = require("fs"), path = require("path");
            const { isHtmlFile, extractPayload, validatePayload } = require("./tools/veil.js");
            const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) =>
              e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
            const bad = walk("./_encrypted").filter(isHtmlFile).filter((f) => {
              const p = extractPayload(fs.readFileSync(f, "utf8"));
              return !p || validatePayload(p).length > 0;
            });
            if (bad.length) { console.error("Unprotected or invalid HTML:", bad); process.exit(1); }
          '

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

Test locally before pushing to CI. Build into a fresh output directory — Veil
stages each build in a temporary sibling directory and moves it into place, and
it refuses a non-empty destination so a stale file from an earlier build can
never be deployed:

```bash
rm -rf ./_encrypted
VEIL_PASSPHRASE="testpass" node ./tools/veil.js ./site ./_encrypted \
  --passphrase-env VEIL_PASSPHRASE \
  --id my-project
```

Re-running without clearing the directory first gives:

```text
veil: output directory is not empty: /abs/path/_encrypted
Veil replaces the whole output directory so stale files from earlier
builds can never be deployed. Re-run with --force to replace it.
```

`rm -rf` or `--force` both fix it. Use `--force` in pipelines that reuse a build
directory between runs; there is no reason to add it to a fresh CI runner.

Read the build's combined output before opening a browser (warnings are on
stderr; the `encrypted N` / `omitting N` counts are on stdout):

```text
veil: copying 4 non-HTML file(s) unencrypted — these remain public
veil: encrypted 12 HTML file(s) → /abs/path/_encrypted
```

For a full-site build there must be **no** `veil: leaving N HTML file(s) public`
line — that line means HTML fell outside the encrypted roots. Then assert it
rather than trusting the count:

```bash
# must print nothing for a full-site build
grep -rL --include='*.[Hh][Tt][Mm][Ll]' --include='*.[Hh][Tt][Mm]' 'id="veil-payload"' ./_encrypted

# and check a few strings from different source pages
for s in "Acme Q3 Proposal" "internal-only" "Day 3 — Kyoto"; do
  grep -rq "$s" ./_encrypted && echo "LEAK: $s" || echo "ok: $s"
done
```

Then serve it:

```bash
python3 -m http.server 8765 --directory ./_encrypted
```

Open `http://127.0.0.1:8765` — a secure context, so Web Crypto works — and verify:

- Every page shows the Veil passphrase prompt
- Correct passphrase unlocks content, and the page's real title returns (the
  locked page is always titled "Protected page", with a `noindex` robots meta)
- Wrong passphrase shows an error and stays locked
- After unlocking one page, other pages auto-unlock within the same session
- Closing and reopening the tab returns to the locked state (unless `--remember` was used)
- Images, fonts, and styles render after unlock. If something is missing, check
  the console for CSP violations: the wrapper's CSP survives into the decrypted
  document and blocks every `<script src>`, same-origin or external. Inlining
  turns local scripts into inline ones so they still run; third-party scripts
  never will.

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

Understand the cost first. The wrapper CSP blocks every `<script src>`, so with
`--no-inline` local JS **will not execute** on decrypted pages — same-origin
stylesheets and images still load. Inlining is also what shrinks the public
surface: an inlined CSS file that nothing public references is dropped from the
output, and inlined JS is dropped when the whole site is encrypted and no JS
survives publicly. With `--no-inline`, every asset stays in the public output.

### Reusing a build directory

```bash
node ./tools/veil.js ./site ./_encrypted \
  --passphrase-env VEIL_PASSPHRASE \
  --id my-project \
  --force
```

### Checking vendored provenance

```bash
shasum -a 256 -c ./tools/veil.js.sha256
```

The recorded commit SHA plus this digest are the provenance check. Note
that `--version` reads a `package.json` next to `veil.js`, so a vendored
single file prints `veil unknown` — it verifies nothing about provenance.

## Next Steps

If parts of the site should stay public while other sections are individually protected, see [Protected Zones](protected-zones.md).
