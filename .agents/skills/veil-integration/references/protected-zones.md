# Protected Zones

Use this pattern when parts of a site stay public while one or more sections are individually protected — each with its own passphrase and independent unlock state.

Examples:

- A public landing page with a protected client portal
- A travel site with individually locked trip sections
- A docs site where some sections require different access levels

## How It Works

Veil's `--html-root` flag limits encryption to HTML files under a specific subdirectory. Files outside that directory pass through unmodified. Repeat `--html-root` for several subtrees that share one passphrase; chain multiple Veil runs for zones that need **different** passphrases.

Chaining works because each run's output is the next run's input, through
**successive directories** — `site → _stage1 → _encrypted`. It has to be done
that way: Veil builds a fresh artifact, staging the build in a temporary sibling
directory and moving it into place, so a second run pointed at the same output
directory refuses the non-empty destination, and `--force` would delete the
first zone's work rather than add to it. Veil also rejects an output path that
is the same as, inside, or containing the input, so `veil ./_stage1 ./_stage1`
fails outright.

A later pass leaves earlier zones alone. Zone A's wrappers are `.html` files
outside zone B's `--html-root`, so they are passthrough-copied byte-for-byte,
already encrypted. They are never re-encrypted or double-wrapped.

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
│   ├── veil.js               # pinned to a commit
│   └── veil.js.sha256        # recorded digest
└── .github/workflows/deploy.yml
```

Veil is run twice against this tree, once per zone, through successive output
directories — never twice into one.

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
- `./_encrypted` must be absent or empty; add `--force` only if the pipeline
  deliberately reuses that directory between builds

## Multiple Protected Zones

Chain Veil runs through successive directories. Each stage's output becomes the
next stage's input, and only the **last** directory is deployed:

```bash
# Stage 1: encrypt client-a           ./site  -> ./_stage1
node ./tools/veil.js ./site ./_stage1 \
  --passphrase-env VEIL_PASSPHRASE_A \
  --id client-a \
  --html-root client-a

# Stage 2: encrypt client-b           ./_stage1 -> ./_encrypted
node ./tools/veil.js ./_stage1 ./_encrypted \
  --passphrase-env VEIL_PASSPHRASE_B \
  --id client-b \
  --html-root client-b

# deploy ./_encrypted
```

Each zone has its own `--id` (scopes browser storage independently), its own passphrase, and unlocks independently of other zones.

### Do not point two runs at one output directory

```bash
# WRONG — the second run refuses the non-empty destination
node ./tools/veil.js ./site ./_encrypted --id client-a --html-root client-a ...
node ./tools/veil.js ./site ./_encrypted --id client-b --html-root client-b ...
# veil: output directory is not empty: /abs/path/_encrypted
# Veil replaces the whole output directory so stale files from earlier
# builds can never be deployed. Re-run with --force to replace it.

# ALSO WRONG — --force "fixes" the error by discarding zone A entirely
node ./tools/veil.js ./site ./_encrypted --id client-b --html-root client-b --force ...
# _encrypted/client-a/index.html is now plaintext again
```

The `--force` variant exits 0 and looks fine in the log. Only the verification
step below catches it.

### What the chained build prints

Both runs report on stderr what they left public. Transcript from the layout
above (two public pages, two zone A pages, one zone B page, a shared
`css/style.css`, and a zone-private `client-a/a.css`):

```text
$ node ./tools/veil.js ./site ./_stage1 --id client-a --html-root client-a ...
veil: omitting 1 asset(s) that were inlined into encrypted pages and are not referenced by public files
veil: copying 1 non-HTML file(s) unencrypted — these remain public
veil: leaving 3 HTML file(s) public outside the encrypted roots
veil: encrypted 2 HTML file(s) → /abs/path/_stage1

$ node ./tools/veil.js ./_stage1 ./_encrypted --id client-b --html-root client-b ...
veil: copying 1 non-HTML file(s) unencrypted — these remain public
veil: leaving 4 HTML file(s) public outside the encrypted roots
veil: encrypted 1 HTML file(s) → /abs/path/_encrypted
```

Read the "leaving N HTML file(s) public" lines carefully — they are the ones
that surprise people:

- Stage 1 leaves **3**: `index.html`, `about.html`, and `client-b/index.html`,
  which really is still plaintext at that point. That is fine; stage 2 encrypts
  it. It is *not* fine if stage 2 never runs.
- Stage 2 leaves **4**: the same two public pages plus zone A's two wrappers.
  Those wrappers are HTML outside zone B's `--html-root`, so they are copied
  through byte-for-byte — still encrypted under zone A's passphrase, never
  re-encrypted or double-wrapped. The count going *up* is the chain working.

`veil: omitting 1 asset(s)` in stage 1 is `client-a/a.css`: inlined into zone
A's pages and referenced by nothing public, so it is dropped from the output.
The shared `css/style.css` is kept, because public pages still link it.

Because these counts mix "already encrypted" with "genuinely public", never
accept them as verification. Confirm the *identity* of every public file with
the step below.

## GitHub Actions Workflow

```yaml
# Vendored from https://raw.githubusercontent.com/y4le/veil/<COMMIT-SHA>/veil.js
- name: Verify vendored Veil
  run: shasum -a 256 -c ./tools/veil.js.sha256

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

A fresh GitHub Actions runner starts with no `_stage1` or `_encrypted`, so no
`--force` is needed. On a self-hosted or cached runner that keeps the workspace
between builds, add `--force` to **every** stage (or `rm -rf ./_stage1
./_encrypted` before the first one) — otherwise stage 1 fails on the leftover
directory. `--force` per stage is safe; `--force` into a *shared* output
directory is the destructive case described above.

Set one secret per zone:

```bash
gh secret set VEIL_PASSPHRASE_A --repo owner/repo
gh secret set VEIL_PASSPHRASE_B --repo owner/repo
```

Never pass a zone passphrase as `--passphrase` — Veil warns that it is visible
in process listings, and CI logs are not a good place to discover that.

## Shared Assets

If protected pages reference CSS, JS, or images outside their subtree, Veil needs the full site as input to resolve asset paths for inlining. `--html-root` only controls which HTML files get encrypted — Veil still sees the entire input directory for asset resolution.

Example: if `client-a/index.html` links to `../css/style.css`, passing the full `./site` directory as input (not just `./site/client-a`) lets Veil inline that stylesheet correctly.

Shared assets stay in the public output because public pages still reference
them. Only a stylesheet that was inlined into encrypted pages and is provably
referenced by nothing public gets omitted — a zone-private `client-a/a.css`, for
example. Inlined JS is never omitted in a protected-zones build, because public
HTML exists and can reach it in ways no scanner sees. Assume every non-HTML file
you can still see in the output is public, and never put secrets in one.

Two input rules bite here because the input is the whole staged site, most of
which only passes through:

- **No symlinks anywhere inside the tree.** Veil refuses them rather than
  skipping or following them, even in a directory it never encrypts. (The input
  directory path itself may be a symlink.) Generators that link shared assets
  into the output need `cp -L` or equivalent first.
- **UTF-8** is required for HTML Veil encrypts and for CSS/JS it inlines; those
  are fatal on bad bytes. Files that only pass through are copied byte-for-byte
  and are not validated — so a Latin-1 page in a *public* zone survives stage 1
  and then fails the build in a later stage if a subsequent `--html-root` starts
  encrypting it.

## Verification

Chained zones fail in ways a single spot-check misses, so check the artifact
before checking the browser.

**In `./_encrypted` (the final stage only):**

```bash
# 1. Which HTML is served in the clear? Every path printed must be intended.
#    Expect exactly the public pages — plus nothing else.
grep -rL --include='*.[Hh][Tt][Mm][Ll]' --include='*.[Hh][Tt][Mm]' 'id="veil-payload"' ./_encrypted

# 2. Which zone owns each protected page? Site ids must match the --id per zone.
node -e '
const fs = require("fs"), path = require("path");
const { extractPayload, isHtmlFile } = require("./tools/veil.js");
const walk = (d) => fs.readdirSync(d, { withFileTypes: true })
  .flatMap((e) => e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)]);
for (const f of walk(process.argv[1]).filter(isHtmlFile)) {
  const p = extractPayload(fs.readFileSync(f, "utf8"));
  console.log(f.padEnd(40), p ? `PROTECTED id=${p.siteId} path=${p.path}` : "PUBLIC");
}' ./_encrypted

# 3. Canaries: one per zone, from different source pages. All must print "ok".
for s in "Zone A heading" "Zone A report caption" "Zone B heading"; do
  grep -rq "$s" ./_encrypted && echo "LEAK: $s" || echo "ok: $s"
done

# 4. Control: a string from a public page must still be findable. If it is
#    not, grep is matching nothing and steps 1-3 proved nothing.
grep -rq "Public landing heading" ./_encrypted && echo "ok: control found"
```

Expected shape for the layout above: `index.html` and `about.html` print
`PUBLIC`; `client-a/*` print `id=client-a`; `client-b/*` print `id=client-b`.
If any `client-a/*` page comes back `PUBLIC`, the second stage overwrote the
first — check for a shared output directory and a stray `--force`.

**In a real browser** (`python3 -m http.server 8765 --directory ./_encrypted`,
or over HTTPS once deployed — Web Crypto needs a secure context):

- Public routes render without a passphrase prompt
- Protected routes show the prompt and unlock with the correct zone passphrase
- Zone A's passphrase does **not** unlock zone B
- Each zone's unlock state is independent
- Wrong passphrases show an error and stay locked
- Locked pages are titled "Protected page"; the real title returns on unlock
- Closing and reopening the tab returns protected routes to the locked state

One thing no build check can verify: any JavaScript on the **public** pages —
an analytics tag, a chat widget — can read the cached master keys for *every*
zone out of browser storage and decrypt those pages. A selective deployment
shares one origin. Keep third-party JS off it entirely.

## Naming Conventions

| Concept | Flag | Suggested pattern |
|---------|------|-------------------|
| Zone ID | `--id` | Descriptive and stable: `client-portal`, `trip-2026-japan` |
| Secret name | `--passphrase-env` | `VEIL_PASSPHRASE_<ZONE>` in uppercase |
| Subtree path | `--html-root` | Match the directory name in the site |
