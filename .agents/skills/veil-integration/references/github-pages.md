# GitHub Pages: Full-Site Encryption

Encrypt every HTML file in a GitHub Pages site behind a single passphrase. This
is the most common Veil setup.

## Prerequisites

- A GitHub repo with static HTML (source or build output). The tree Veil reads
  must contain no symlinks, and every HTML file plus any CSS/JS it inlines must
  be valid UTF-8; both are fatal errors, not warnings.
- Node.js 18+ in CI.
- `veil.js` vendored at e.g. `./tools/veil.js` from a **pinned commit**, with its
  SHA and digest recorded. See [AGENT.md](../../../AGENT.md#vendor-a-pinned-veiljs).
  Never fetch it from `main` at build time; it runs in the same job as the
  passphrase secret.

GitHub Pages serves over HTTPS, which Veil requires. With a custom domain, keep
"Enforce HTTPS" on; on plain HTTP the wrapper refuses to decrypt and says so.

If Pages is not enabled yet: **Settings > Pages**, set **Source** to **GitHub
Actions**. No branch selection needed; the workflow uploads the artifact.

## Repository layout

```
my-repo/
├── site/                # HTML content (source or build output)
│   ├── index.html
│   ├── about.html
│   └── css/style.css
├── tools/
│   ├── veil.js          # Vendored Veil CLI, pinned to a commit
│   └── veil.js.sha256   # Recorded digest, checked in CI
└── .github/workflows/deploy.yml
```

## Set the passphrase secret

```bash
gh secret set VEIL_PASSPHRASE --repo owner/repo
```

Pass it with `--passphrase-env`, never `--passphrase`; Veil warns on stderr that
a CLI-supplied passphrase is visible in process listings and shell history.

## Workflow

Every action is pinned to a full commit SHA, with the release tag in a comment.
A `@vN` tag is movable, and `checkout` and `setup-node` run *before* the step
that receives the passphrase; either could rewrite the workspace or the PATH and
capture it. Pinning `veil.js` and leaving the rest of the job movable protects
nothing. Refresh the SHAs the same way you refresh Veil's: read the diff, then
bump.

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
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: '24'

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

      - name: Verify the encrypted output
        # Fail-closed audit: every HTML file must be a valid, current-format
        # wrapper sealed for its own path, no unexpected or modified files, and
        # the ciphertext must actually decrypt. Exit 1 on findings, 2 if the
        # audit itself cannot run.
        run: |
          node ./tools/veil.js verify ./_encrypted \
            --input ./site \
            --id ${{ github.event.repository.name }} \
            --passphrase-env VEIL_PASSPHRASE
        env:
          VEIL_PASSPHRASE: ${{ secrets.VEIL_PASSPHRASE }}

      - uses: actions/configure-pages@45bfe0192ca1faeb007ade9deae92b16b8254a0d # v6.0.0
      - uses: actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0
        with:
          path: ./_encrypted
      - id: deployment
        uses: actions/deploy-pages@cd2ce8fcbc39b97be8ca5fce6e763baed58fa128 # v5.0.0
```

## With a build step

If the site uses Jekyll, Hugo, Vite, or another generator, build first and point
Veil at the output; its input must always be the publishable site. A repo whose
checked-in HTML *is* the deploy artifact needs no build step, and the workflow
above applies as written.

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

Pass the same directory to `verify --input`.

## Local verification

```bash
rm -rf ./_encrypted
export VEIL_PASSPHRASE=testpass   # throwaway; type a real one with: read -rs VEIL_PASSPHRASE

node ./tools/veil.js ./site ./_encrypted \
  --passphrase-env VEIL_PASSPHRASE --id my-project

node ./tools/veil.js verify ./_encrypted \
  --input ./site --id my-project --passphrase-env VEIL_PASSPHRASE

python3 -m http.server 8765 --directory ./_encrypted
```

Veil refuses a non-empty output directory, so clear it or pass `--force`; a
fresh CI runner needs neither.

Read the build's output before opening a browser (warnings on stderr, counts on
stdout):

```text
veil: copying 4 non-HTML file(s) unencrypted — these remain public
veil: encrypted 12 HTML file(s) → /abs/path/_encrypted
```

For a full-site build there must be **no** `veil: leaving N HTML file(s) public`
line; that line means HTML fell outside the encrypted roots. The counts are not
verification, though: `veil verify` is, and it exits non-zero on any
unencrypted, orphaned, or altered page. See
[docs/verify.md](https://github.com/y4le/veil/blob/main/docs/verify.md).

Then at `http://127.0.0.1:8765`, a secure context so Web Crypto works:

- every page shows the prompt, titled "Protected page"
- the correct passphrase unlocks and the real title returns
- a wrong passphrase shows an error and stays locked
- other pages auto-unlock within the session
- reopening the tab returns to the locked state, unless `--remember` was used
- images and styles render after unlock

If something is missing after unlock, check the console for CSP violations: the
wrapper's CSP survives into the decrypted document and blocks every
`<script src>`, same-origin or external. Inlining turns local scripts into inline
ones so they still run; `--no-inline` leaves local JavaScript unable to execute.

## Next steps

If parts of the site should stay public while other sections are individually
protected, see [Protected Zones](protected-zones.md).
