# Getting Started

You need Node.js 18+ and a directory of HTML. Nothing to install.

## 1. Encrypt a site

Pass the *name* of an environment variable rather than the passphrase itself;
that keeps it out of process listings, and lets the audit in step 2 reuse it.
Type it in rather than assigning it inline, so it stays out of shell history
too:

```bash
read -rs VEIL_PASSPHRASE && export VEIL_PASSPHRASE

node veil.js ./my-site ./encrypted \
  --passphrase-env VEIL_PASSPHRASE \
  --id my-project
```

Omitting both passphrase options prompts instead, twice, and aborts if the
entries differ.

Read the output before going further:

```text
veil: copying 4 non-HTML file(s) unencrypted — these remain public
veil: encrypted 12 HTML file(s) → /abs/path/encrypted
```

The encrypted count must match the number of pages you meant to protect. For a
full-site build there must be no `leaving N HTML file(s) public` line at all.

`./encrypted` must be absent or empty; Veil builds a fresh artifact and will not
write over an existing one without `--force`.

## 2. Audit the output

The counts above are a sanity check, not proof. `verify` is the audit:

```bash
node veil.js verify ./encrypted \
  --input ./my-site \
  --id my-project \
  --passphrase-env VEIL_PASSPHRASE
```

It is fail-closed: every HTML file in the output must be a canonical wrapper
sealed for its own path, nothing may be stale or missing, and with a passphrase
supplied it decrypts every page for real. Exit 0 clean, 1 errors, 2 the audit
could not run. See [verifying a build](verify.md).

## 3. Serve it and unlock

```bash
python3 -m http.server 8765 --directory ./encrypted
```

Open `http://127.0.0.1:8765`. `127.0.0.1` is a secure context, so Web Crypto
works, the same as the HTTPS your host will serve.

Check that:

- every page shows the passphrase prompt, titled "Protected page"
- the correct passphrase unlocks it and the real title comes back
- a wrong passphrase shows an error and stays locked
- a second protected page opens without prompting again
- the `lock` button in the corner locks the site again
- images and styles render after unlock

Then read [how it works](how-it-works.md) and the
[threat model](threat-model.md) before you publish anything you care about, and
[integration](integration.md) to wire it into a build.

## Troubleshooting

**"Cannot decrypt: this page needs HTTPS (or localhost)."** Web Crypto only
exists in secure contexts. Use `localhost`, `127.0.0.1`, `file:`, or HTTPS.

**`output directory is not empty`.** Veil replaces the whole output directory so
files from an earlier build can never be deployed. Delete it, or pass `--force`.

**Local JavaScript does not run after unlock.** The wrapper's CSP blocks every
`<script src>`, same-origin included, and it survives into the decrypted page.
Inlining (the default) converts local scripts to inline ones; under
`--no-inline` they will not execute. External script *files* never load on a
protected page, but inline scripts always run, so treat anything inlined as
trusted code.

**Something is missing after unlock.** Check the console for CSP violations.
Cross-origin images, fonts, and stylesheets are blocked; same-origin ones are
fine.

**A build warning names a script or stylesheet.** Veil could not inline it
(external URL, module script, missing file) and left the reference in the page.
External ones will be blocked at runtime.

**Unlock does nothing.** The bootstrap script failed before the submit handler
attached; check the browser console.

**A page fails with "Passphrase accepted, but this page failed to decrypt."**
That page is from a different build than the one that issued the key. Rebuild
into a fresh output directory and redeploy the whole thing.
