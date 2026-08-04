# Integrating Veil Into a Project

The pipeline is always the same shape:

```text
build → verify the vendored veil.js → encrypt → verify the output → deploy over HTTPS
```

Veil's input is the **publishable site**: the generator's output where there is
a build step, the HTML tree itself where there is not. It never runs on files
that still need processing.

Host-specific walkthroughs:

- [GitHub Pages, full site](../.agents/skills/veil-integration/references/github-pages.md)
- [Protected zones](../.agents/skills/veil-integration/references/protected-zones.md), for a public site with individually locked sections

## Vendor a pinned `veil.js`

Copy `veil.js` into the project (e.g. `./tools/veil.js`) from a **specific
commit**, and record both the commit SHA and a digest. Never fetch it from
`main`: the vendored copy runs in CI beside the passphrase secret, so an
unreviewed upstream change is a change to code that can read that secret.

There are no release tags yet, so a commit SHA is the immutable handle; get one
with `git rev-parse HEAD` in a Veil checkout.

```bash
# from the target repo root
COMMIT='<COMMIT-SHA>'
mkdir -p ./tools
curl -fsSL "https://raw.githubusercontent.com/y4le/veil/$COMMIT/veil.js" -o ./tools/veil.js
shasum -a 256 ./tools/veil.js | tee ./tools/veil.js.sha256
```

Commit `./tools/veil.js`, its digest file, and the commit SHA (a comment above
the Veil step in the workflow is enough). Check the digest in CI, or after any
re-download:

```bash
shasum -a 256 -c ./tools/veil.js.sha256
```

`--version` is not a provenance check; it reads a `package.json` beside
`veil.js`, so a vendored single file prints `veil unknown`.

### Upgrading

Bump the SHA, re-download, re-record the digest, and read the diff. Same bar as
any other dependency with access to secrets.

## Wire the build

```bash
node ./tools/veil.js ./dist ./_encrypted \
  --passphrase-env VEIL_PASSPHRASE \
  --id my-project \
  --force   # only where the runner reuses the output directory between builds
```

- **Always pass `--id`.** An id inferred from an output directory named `dist`,
  `public`, or `_site` is generic enough to collide with another Veil site on the
  same origin, and Veil warns about exactly that.
- **Always use `--passphrase-env`**, backed by a CI secret. `--passphrase` is
  visible in process listings and shell history.
- **Never point two runs at one output directory.** Chain zones through
  successive directories; `--force` into a shared one deletes the first zone's
  work and still exits 0.

## Verify before deploying

```bash
node ./tools/veil.js verify ./_encrypted \
  --input ./dist \
  --id my-project \
  --passphrase-env VEIL_PASSPHRASE
```

Exit 0 clean, 1 errors, 2 the audit could not run, so `set -e` is enough. Run it
once per zone for chained builds, with that zone's root, id, and passphrase. Full
semantics are in [verifying a build](verify.md).

## Deploy

Point the deploy step at Veil's output directory, and serve it over **HTTPS**;
Web Crypto only exists in secure contexts, so pages served over plain HTTP cannot
decrypt.

Then load the deployed site once: the prompt appears, the correct passphrase
unlocks, a wrong one does not, and a sibling protected page unlocks without
re-prompting.

## Passphrase lifecycle

Distribution is out of scope; share it through a password manager, never the
repo. Rotation means changing the secret and rebuilding: every build mints a new
master key, so cached keys from the old build fail, clear themselves, and
visitors are prompted again. Nothing already decrypted is revoked.

## Letting an agent do it

`.agents/AGENT.md` is a portable bootstrap for coding agents; it covers
vendoring, discovering the site's shape, wiring CI, and verifying the result.
Point an agent at it:

```text
Read https://raw.githubusercontent.com/y4le/veil/main/.agents/AGENT.md
and use it to integrate Veil into this project end to end.
```

That URL tracks `main` on purpose, because it is documentation. The executable is
the one file that is always pinned to a commit. If the agent cannot reach the
repo, paste the file or copy `.agents/` into the target repo, which also lets
future agents there discover the skill automatically.
