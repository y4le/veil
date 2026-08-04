# CLI Reference

`veil.js` is a single file with no runtime dependencies; Node.js 18+ is the only
prerequisite. `node veil.js --help` is always the authoritative synopsis.

```
Usage: veil <input-dir> <output-dir> [options]
       veil verify <output-dir> [options]
```

## Encrypt

```bash
node veil.js ./site ./_encrypted --passphrase-env VEIL_PASSPHRASE --id my-project
```

| Option | Meaning |
|---|---|
| `--passphrase <pass>` | Passphrase on the command line. Visible in process listings and shell history; Veil warns when you use it. |
| `--passphrase-env <name>` | Read the passphrase from an environment variable. Use this in CI. |
| `--id <site-id>` | Browser-storage scope. Defaults to the output directory's basename; always set it explicitly. See [site ids](how-it-works.md#site-ids). |
| `--iterations <N>` | PBKDF2 iterations; default 600,000, minimum 100,000. Below the default Veil warns that it weakens offline guessing resistance. |
| `--remember` | Tick "Remember this device" by default, so unlock state persists in `localStorage` rather than for the session. |
| `--html-root <dir>` | Encrypt only HTML under this input-relative directory. Repeatable. |
| `--no-inline` | Skip CSS/JS inlining. Local JavaScript will then not run on protected pages; see [how it works](how-it-works.md#what-ships-in-a-locked-page). |
| `--force` | Replace a non-empty output directory. |
| `--version` | Print the version. |
| `--help` | Print the synopsis. |

Omitting both passphrase options prompts interactively: twice on a TTY, aborting
if the two entries differ. Piped stdin is read as a single line with no prompt
and no confirmation, which is what makes `echo "$PASS" | node veil.js …` work.

### Output

Counts go to stdout, warnings to stderr:

```text
veil: omitting 1 asset(s) that were inlined into encrypted pages and are not referenced by public files
veil: copying 4 non-HTML file(s) unencrypted — these remain public
veil: leaving 2 HTML file(s) public outside the encrypted roots
veil: encrypted 12 HTML file(s) → /abs/path/_encrypted
```

The `leaving N HTML file(s) public` line appears only when HTML fell outside
`--html-root`. For a full-site build it must not appear at all. These counts are
a sanity check, not verification; [`veil verify`](verify.md) is the audit.

### Selective encryption

`--html-root` limits which HTML gets encrypted while Veil still sees the whole
input tree, so shared assets outside the subtree still resolve for inlining.
Repeat the flag for several subtrees that share one passphrase. Subtrees that
need *different* passphrases are chained through successive output directories;
see [protected zones](../.agents/skills/veil-integration/references/protected-zones.md).

## Verify

```bash
node veil.js verify ./_encrypted --input ./site --id my-project \
  --passphrase-env VEIL_PASSPHRASE
```

| Option | Meaning |
|---|---|
| `--html-root <dir>` | Audit only this output-relative directory. Repeatable. |
| `--input <dir>` | Compare against the input directory this build was made from. |
| `--id <site-id>` | Require this exact site id. |
| `--passphrase <pass>` | Check decryption with this passphrase. |
| `--passphrase-env <name>` | Check decryption with the passphrase in this environment variable. |
| `--prompt-passphrase` | Check decryption with a passphrase typed at the terminal. |
| `--json` | Emit the report as JSON. |
| `--help` | Print the synopsis. |

Exit codes are `0` clean, `1` errors found, `2` the audit could not be performed.
What each stage actually proves is in [verifying a build](verify.md).

## Behavior worth knowing

- **Fresh artifact.** Veil stages every build in a temporary sibling directory
  and moves it into place on success, so the output never mixes files from two
  builds. A non-empty output directory is refused unless you pass `--force`.
- **Chaining.** Because of that, two runs cannot target one output directory;
  the second refuses the destination, and `--force` would discard the first
  run's work. Chain through successive directories instead.
- **Path rules.** An output directory that is the same as, inside, or containing
  the input is refused.
- **Symlinks** anywhere inside the input tree are rejected rather than skipped or
  followed. The input directory path itself may be a symlink.
- **UTF-8 only** for HTML Veil encrypts and CSS/JS it inlines; anything else is a
  fatal error rather than silent mangling. Passthrough files are copied
  byte-for-byte and never decoded, so a non-UTF-8 page in a public zone builds
  fine until a later run starts encrypting it.
- **Strict parsing.** Unknown options and options missing their value are fatal;
  `--id --force` is a forgotten argument, not a site id.
- **Startup warnings** cover `--passphrase` visibility, iteration counts below
  the default, and a generic inferred site id.
- **`--version` is not provenance.** It reads a `package.json` beside `veil.js`,
  so a vendored single file prints `veil unknown`. Provenance is the recorded
  commit SHA plus a digest; see [integration](integration.md).
