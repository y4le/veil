# Verifying a Build

`veil verify` audits a built output directory before you publish it. It answers
the question a build log cannot settle: *is every page that should be protected
actually protected?*

```bash
node veil.js verify ./_encrypted \
  --input ./site \
  --id my-project \
  --passphrase-env VEIL_PASSPHRASE
```

It reads a local directory. It never writes plaintext out, and it says nothing
about a deployed site; check the deployment in a browser over HTTPS as well.

## Scope

Verify is **fail-closed inside the audited scope**. With no `--html-root`, that
scope is every HTML file in the output, and a single plaintext page fails the
audit. With `--html-root`, HTML outside those roots is reported as public rather
than failed, and the exact list is printed so a mistyped root is visible:

```text
Public HTML (outside the audited roots — served as plaintext):
  about.html
  index.html
```

Compare that list against what you meant to leave public. Each root is checked
separately, so a second, mistyped root cannot hide behind a first one that
matched.

Outside the scope Veil deliberately does not guess. Only a page whose bytes
exactly equal a generated wrapper is certainly a wrapper. Anything else that
looks payload-shaped is equally a damaged wrapper or a public page quoting a
payload in a `<textarea>` or a code sample; separating those needs a real HTML
parser, and guessing would fail legitimate public pages. Such pages are warned
about and listed as public, and the zone that owns them is what turns that
warning into an error.

## What each stage proves

**Always.** Every HTML file in scope must be a canonical wrapper: a valid,
current-format payload, sealed for the path it actually sits at, wrapped in bytes
identical to what Veil generates for that payload. That catches a page edited,
minified, or re-CSP'd after the build, since the CSP and the runtime live in the
shell around the payload. The scope must also agree on its shared site metadata,
and every page IV must be unique under a given master key.

Note what this does not prove: a canonical wrapper regenerated around rewritten
payload data still matches. Only the decryption stage authenticates the
ciphertext and key metadata themselves.

**`--input`.** Stale files left in the output, input files that never made it
there, and passthrough files that no longer match their source. A missing
*non-HTML* file is only a warning; an inlined asset that nothing public can reach
is deliberately omitted. Wrappers are exempt from the byte comparison, since
their whole point is to differ from their input.

**A passphrase.** The master key is unwrapped once and every page in scope is
decrypted, so a wrong passphrase is reported once rather than as N page failures.
Supply it with `--passphrase-env` in CI or `--prompt-passphrase` locally; without
one the stage is skipped and the report says so.

## Exit codes and the report

`0` clean, `1` errors found, `2` the audit could not be performed (bad arguments,
a missing directory, an unusable passphrase source). Warnings alone exit 0, so
`set -e` is enough in CI.

`--json` emits a report with stable finding codes:

```bash
node veil.js verify ./_encrypted --json | jq '.findings[] | {code, path}'
```

The report carries `ok`, `scope`, `stats`, the `publicHtml` list, per-stage
`checks` (`passed`, `failed`, or `skipped` with a reason), `findings`, and
`counts`.

| Code | Severity | Meaning |
|---|---|---|
| `html_not_encrypted` | error | An HTML file in scope carries no payload; it is published as plaintext. |
| `payload_malformed`, `payload_invalid` | error in scope | The payload could not be parsed or failed schema validation. |
| `payload_version_unsupported` | error in scope | A different format version; re-encrypt the source, or upgrade `veil.js` to audit it. |
| `wrapper_modified` | error in scope | The page does not match the wrapper Veil generates for its own payload. |
| `payload_path_mismatch` | error | A wrapper sealed for a different path; it was moved or renamed after the build. |
| `site_id_mismatch` | error | Pages carry a site id other than the one `--id` required. |
| `site_inconsistent` | error | Pages in scope came from different builds. |
| `iv_reuse` | error | Two pages share an IV under one master key; AES-GCM would leak both plaintexts. |
| `html_root_unmatched` | error | A `--html-root` matched no HTML at all; usually a typo. |
| `no_encrypted_pages` | error | Nothing was in scope to verify, so the audit proved nothing. |
| `missing_output` | error | An input HTML file never reached the output. |
| `orphan` | error | An output file with no input counterpart; a stale file from an earlier build. |
| `passthrough_modified` | error | A copied file no longer matches its source. |
| `irregular_file`, `unreadable_file` | error | Something that is not a regular file, or could not be read. |
| `mk_unwrap_failed` | error | The master key did not unwrap; wrong passphrase, or tampered key metadata. |
| `page_decrypt_failed` | error | A page did not decrypt under the site master key. |
| `missing_asset` | warning | A non-HTML input file is absent from the output; expected when it was inlined and dropped. |
| `iterations_below_default` | warning | The build used fewer PBKDF2 iterations than the default. |

The four `payload_*` and `wrapper_modified` codes drop to warnings outside the
audited roots, for the reason described above.

## Chained zones

Run verify once per zone against the final artifact, naming that zone's root, id,
and passphrase; the other zones' wrappers are then reported as out of scope
rather than as failures.

```bash
node veil.js verify ./_encrypted --html-root client-a --id client-a --passphrase-env ZONE_A_PASS
node veil.js verify ./_encrypted --html-root client-b --id client-b --passphrase-env ZONE_B_PASS
```

**Run every zone.** Enforcement only exists inside an audited scope, so skipping
a zone skips its guarantee; a tampered wrapper is caught by its own zone's run
and by nothing else. With `--input`, compare each stage against the input to
*that* Veil invocation, not the original source tree.

## Limits

- Verify cannot detect a rollback: a wrapper from an earlier build of the same
  site, sitting at the same path, is internally consistent and decrypts
  correctly. Building into a fresh output directory keeps stale files from
  mixing into a new artifact; nothing here stops a host or a deploy step from
  serving an older artifact whole.
- It audits bytes on disk, not what a host serves.
- It says nothing about whether the passphrase is strong or who has it.
