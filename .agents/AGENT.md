# Veil: Agent Bootstrap

Veil is a zero-dependency Node.js CLI that encrypts static HTML sites at build
time. It ships self-contained browser wrappers that prompt for a passphrase and
decrypt client-side using Web Crypto. One file, no server, no npm install.

Read this when integrating Veil into a project. It is the portable entry point:
it works from a local checkout, a pasted copy, or a raw GitHub URL, and every
step below can be done without reading anything else.

## Links

Documentation tracks `main` on purpose:

- This file: `https://raw.githubusercontent.com/y4le/veil/main/.agents/AGENT.md`
- Full-site how-to: [github-pages.md](skills/veil-integration/references/github-pages.md)
- Protected-zones how-to: [protected-zones.md](skills/veil-integration/references/protected-zones.md)
- Guardrails and completion criteria: [SKILL.md](skills/veil-integration/SKILL.md)
- Deeper reference, if you have the repo: `docs/cli.md`, `docs/verify.md`, `docs/threat-model.md`

The **executable is never fetched from `main`**. Vendor it from
`https://raw.githubusercontent.com/y4le/veil/<COMMIT-SHA>/veil.js`; it runs in CI
beside the passphrase secret.

If the repo is private and you lack access, work from a local checkout or a
pasted copy of these files.

## Default operating mode

Given this doc and a target repo, do the rest yourself: vendor a pinned
`veil.js`, work out how the site is built and deployed, infer the simplest
correct Veil shape from the repo, patch the build and deploy flow, name or
create the required secrets, and verify locally.

Stop to ask only when one of these is materially ambiguous: what stays public
versus protected; one passphrase or several zones; whether "Remember this
device" should default on; whether you may create CI secrets. If you cannot set
secrets, finish the integration anyway and report the exact names to create.

## Discovery checklist

Answer from the repo first; ask only if the answer changes what you build.

- **Scope**: whole site behind one passphrase (the common case), or some routes
  public and one or more subtrees protected.
- **Build**: Veil's input is the publishable site; find the generator's output
  directory, or use the HTML tree itself where there is no build step.
- **Deploy**: determines where the passphrase secret lives. GitHub Pages with
  Actions is the usual shape.
- **Site id**: `--id` scopes browser storage. The repo name is a good default;
  never leave it inferred from a directory called `dist`, `public`, or `_site`.
- **Persistence**: session-only by default; `--remember` defaults the
  "Remember this device" box to checked.
- **Passphrase delivery**: Veil does not distribute it; confirm the user has a
  plan.

## Vendor a pinned `veil.js`

```bash
# from the target repo root
COMMIT='<COMMIT-SHA>'
mkdir -p ./tools
curl -fsSL "https://raw.githubusercontent.com/y4le/veil/$COMMIT/veil.js" -o ./tools/veil.js
shasum -a 256 ./tools/veil.js | tee ./tools/veil.js.sha256
node ./tools/veil.js --help
```

There are no release tags yet, so a commit SHA is the immutable handle; get one
with `git rev-parse HEAD` in a Veil checkout. Commit the file, its digest, and
the SHA (a comment above the Veil step is enough), and check the digest in CI
with `shasum -a 256 -c ./tools/veil.js.sha256`. Upgrading means bumping the SHA,
re-recording the digest, and reading the diff.

`--version` is not provenance; a vendored single file prints `veil unknown`.

## Build and verify

Run `node ./tools/veil.js --help` and `node ./tools/veil.js verify --help` for
the full option lists. The integration-critical semantics:

- `--passphrase-env <NAME>` for the passphrase, backed by a CI secret. Never
  `--passphrase` in CI; Veil warns that it is visible in process listings.
- `--id <site-id>` always explicit.
- `--html-root <dir>` limits which HTML is encrypted; repeat it for subtrees
  sharing one passphrase.
- Output directories are **fresh artifacts**. A non-empty destination is refused
  without `--force`. Zones with different passphrases therefore chain through
  *successive* directories (`site → _stage1 → _encrypted`); two runs into one
  directory cannot work, and `--force` there silently discards the first zone.
- The input tree must contain no symlinks, and HTML plus inlined CSS/JS must be
  valid UTF-8. Both are fatal.

Then audit the artifact. This is the step that catches a mistyped `--html-root`,
a stale file, and a wrapper mangled after the build; a single canary grep is not
verification.

```bash
node ./tools/veil.js verify ./_encrypted \
  --input ./site --id my-project --passphrase-env VEIL_PASSPHRASE
```

- Fail-closed: with no `--html-root`, every HTML file in the output must be a
  canonical wrapper sealed for its own path. Exit 0 clean, 1 errors, 2 the audit
  could not run.
- With `--html-root`, verify prints the exact list of public HTML. **Compare it
  against what the user said should stay public and state it in your report.**
- For chained zones, run verify once per zone with that zone's root, id, and
  passphrase, and run *every* zone; enforcement only exists inside an audited
  scope. With `--input`, pass the input to *that* invocation, not the original
  tree.
- A missing non-HTML input file is only a warning: an inlined asset that nothing
  public can reach is deliberately omitted.
- Rollback is out of scope; a same-path wrapper from an earlier build of the
  same site is self-consistent. Fresh output directories stop stale files from
  mixing into a new artifact, not a deploy step from serving an old one whole.

Finally serve it (`python3 -m http.server 8765 --directory ./_encrypted`) and
check in a browser that the prompt appears, the right passphrase unlocks, a
wrong one does not, and a sibling protected page unlocks without re-prompting.
The deployed site must be **HTTPS**; Web Crypto does not exist in insecure
contexts.

## Non-negotiable warnings

- **Only HTML is encrypted.** Everything else in the output is public. Never put
  a secret in a non-HTML file.
- **Any JavaScript on the origin can decrypt the site.** It can read the cached
  master key from browser storage; that includes an analytics tag or chat widget
  on a *public* page of a selective deployment. Recommend a dedicated hostname
  for protected content, with no third-party JS anywhere on it.
- Veil is deterrence, not access control: no accounts, no revocation, and the
  ciphertext is public, so a weak passphrase can be attacked offline.

The full boundary is in `docs/threat-model.md`.

## Next

Pick the matching how-to:
[full-site](skills/veil-integration/references/github-pages.md) or
[protected zones](skills/veil-integration/references/protected-zones.md). Copy
`.agents/` into the target repo if future agents there should discover this
automatically.
