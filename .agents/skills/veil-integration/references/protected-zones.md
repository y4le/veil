# Protected Zones

Use this pattern when parts of a site stay public while one or more sections are
individually protected, each with its own passphrase and independent unlock
state.

## How it works

`--html-root` limits encryption to HTML under a given input-relative directory;
files outside it pass through unmodified. Repeat the flag for several subtrees
that share one passphrase, and chain separate Veil runs for zones that need
**different** passphrases.

Chaining works because each run's output is the next run's input, through
**successive directories** (`site → _stage1 → _encrypted`). It has to be done
that way: Veil builds a fresh artifact, so a second run pointed at the same
output directory refuses the non-empty destination, and `--force` would delete
the first zone's work rather than add to it. An output path that is the same as,
inside, or containing the input is refused outright.

A later pass leaves earlier zones alone. Zone A's wrappers are `.html` files
outside zone B's `--html-root`, so they are copied byte-for-byte, already
encrypted; they are never re-encrypted or double-wrapped.

## Repository layout

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

## One protected zone

```bash
node ./tools/veil.js ./site ./_encrypted \
  --passphrase-env VEIL_PASSPHRASE_CLIENTS \
  --id client-portal \
  --html-root client-a
```

`index.html` and `about.html` pass through unencrypted; everything under
`client-a/` is encrypted. `--html-root` is relative to the input directory.

## Several protected zones

Chain the runs. Each stage's output is the next stage's input, and only the
**last** directory is deployed:

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

Each zone gets its own `--id` (so browser storage is scoped independently), its
own passphrase, and its own unlock state. Use stable, descriptive ids
(`client-portal`, `trip-2026-japan`) and one secret per zone
(`VEIL_PASSPHRASE_<ZONE>`).

### Never point two runs at one output directory

```bash
# WRONG — the second run refuses the non-empty destination
node ./tools/veil.js ./site ./_encrypted --id client-a --html-root client-a ...
node ./tools/veil.js ./site ./_encrypted --id client-b --html-root client-b ...

# ALSO WRONG — --force "fixes" the error by discarding zone A entirely
node ./tools/veil.js ./site ./_encrypted --id client-b --html-root client-b --force ...
# _encrypted/client-a/index.html is now plaintext again
```

The `--force` variant exits 0 and looks fine in the log. Only verification
catches it.

### Reading the build counts

Each stage reports on stderr what it left public, and those numbers are
confusing by design: stage 1 counts zone B's still-plaintext pages as public
(correct, and fine only because stage 2 follows), and stage 2 counts zone A's
wrappers as public HTML outside its roots (also correct; they are already
encrypted). The count going *up* between stages is the chain working.

Because the counts mix "already encrypted" with "genuinely public", never accept
them as verification. Confirm the identity of every public file below.

## GitHub Actions workflow

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

- name: Verify every zone
  run: |
    node ./tools/veil.js verify ./_encrypted \
      --html-root client-a --id client-a --passphrase-env VEIL_PASSPHRASE_A
    node ./tools/veil.js verify ./_encrypted --input ./_stage1 \
      --html-root client-b --id client-b --passphrase-env VEIL_PASSPHRASE_B
  env:
    VEIL_PASSPHRASE_A: ${{ secrets.VEIL_PASSPHRASE_A }}
    VEIL_PASSPHRASE_B: ${{ secrets.VEIL_PASSPHRASE_B }}

- uses: actions/upload-pages-artifact@fc324d3547104276b827a68afc52ff2a11cc49c9 # v5.0.0
  with:
    path: ./_encrypted
```

Set one secret per zone:

```bash
gh secret set VEIL_PASSPHRASE_A --repo owner/repo
gh secret set VEIL_PASSPHRASE_B --repo owner/repo
```

A fresh GitHub Actions runner starts with no `_stage1` or `_encrypted`, so no
`--force` is needed. On a self-hosted or cached runner that keeps the workspace,
add `--force` to **every** stage, or `rm -rf ./_stage1 ./_encrypted` first;
`--force` per stage is safe, `--force` into a *shared* output directory is the
destructive case above.

## Shared assets

If protected pages reference CSS, JS, or images outside their subtree, give Veil
the whole staged site as input. `--html-root` only controls which HTML gets
encrypted; Veil still sees the entire input tree for asset resolution, so
`client-a/index.html` linking `../css/style.css` inlines correctly.

Shared assets stay in the public output because public pages still reference
them. Only a stylesheet that was inlined into encrypted pages and is provably
referenced by nothing public is omitted, such as a zone-private
`client-a/a.css`. Inlined JS is never omitted in a protected-zones build, because
public HTML exists and can reach it in ways no scanner sees. Assume every
non-HTML file still visible in the output is public.

Because the input is the whole staged site, its rules apply to files that only
pass through: no symlinks anywhere in the tree, and UTF-8 for anything Veil
encrypts or inlines. A non-UTF-8 page in a public zone survives stage 1 and then
fails the build in a later stage that starts encrypting it. See
[docs/cli.md](https://github.com/y4le/veil/blob/main/docs/cli.md).

## Verification

Run `veil verify` against the **final** artifact, once per zone, naming that
zone's root, id, and passphrase. Wrappers belonging to the other zones are then
reported as out of scope rather than as failures:

```bash
node ./tools/veil.js verify ./_encrypted \
  --html-root client-a --id client-a --passphrase-env ZONE_A_PASS

node ./tools/veil.js verify ./_encrypted \
  --html-root client-b --id client-b --passphrase-env ZONE_B_PASS
```

Each run prints the HTML served in the clear:

```text
Public HTML (outside the audited roots — served as plaintext):
  about.html
  index.html
```

For the layout above that list must be exactly `index.html` and `about.html`. If
a `client-a/*` page appears there, the second stage overwrote the first; look for
a shared output directory and a stray `--force`.

**Run every zone.** Enforcement only exists inside an audited scope, so
verifying one zone of a chained artifact is not a complete audit. Correspondence
checks compare a stage against *its own* input, so `--input` takes the previous
stage's directory, not the original source tree:

```bash
node ./tools/veil.js verify ./_encrypted --input ./_stage1 \
  --html-root client-b --id client-b
```

Why out-of-scope pages are warned about rather than failed is explained in
[docs/verify.md](https://github.com/y4le/veil/blob/main/docs/verify.md).

**In a browser** (`python3 -m http.server 8765 --directory ./_encrypted`, or
over HTTPS once deployed): public routes render without a prompt; protected
routes prompt and unlock with the right zone passphrase; zone A's passphrase
does not unlock zone B; each zone's unlock state is independent; wrong
passphrases stay locked; locked pages are titled "Protected page"; reopening the
tab relocks.

One thing no build check can verify: any JavaScript on the **public** pages, an
analytics tag or a chat widget, can read the cached master keys for *every* zone
out of browser storage and decrypt those pages. A selective deployment shares one
origin. Keep third-party JS off it entirely.
