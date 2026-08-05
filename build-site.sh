#!/usr/bin/env bash
# Build the Veil demo site: a public landing page plus two protected zones with
# different passphrases. Zones with different passphrases have to be chained
# through successive output directories, so this runs Veil twice and verifies
# after each stage.
#
#   VEIL_VAULT_PASSPHRASE=... ./build-site.sh
#
# The demo passphrase is published on the landing page, so it lives here in the
# clear. The vault passphrase does not; generate one for a local build with
#
#   export VEIL_VAULT_PASSPHRASE="$(openssl rand -base64 24)"
#
# and set it as the repository secret of the same name for the deployed site.

set -euo pipefail
cd "$(dirname "$0")"

SRC=./site
STAGE=./_stage1
OUT=./_site

DEMO_ID=y4le-veil-demo
VAULT_ID=y4le-veil-vault

# Disclosed by design; the landing page prints it.
export VEIL_DEMO_PASSPHRASE=open-sesame

if [ -z "${VEIL_VAULT_PASSPHRASE:-}" ]; then
  echo "build-site.sh: VEIL_VAULT_PASSPHRASE is not set" >&2
  echo "  export VEIL_VAULT_PASSPHRASE=\"\$(openssl rand -base64 24)\"" >&2
  exit 2
fi

# A passphrase the landing page does not actually print is a broken demo.
if ! grep -qF ">$VEIL_DEMO_PASSPHRASE<" "$SRC/index.html"; then
  echo "build-site.sh: $SRC/index.html does not publish the demo passphrase" >&2
  exit 2
fi

# --force replaces each stage's own output. It is safe because the two stages
# write to separate directories; pointing both at one directory and forcing it
# would silently discard the first zone.

echo "== stage 1: encrypt /demo/ =="
node veil.js "$SRC" "$STAGE" \
  --id "$DEMO_ID" \
  --html-root demo \
  --passphrase-env VEIL_DEMO_PASSPHRASE \
  --force

# Correspondence is checked against the directory this stage actually built
# from, which is why it happens now rather than at the end.
node veil.js verify "$STAGE" \
  --input "$SRC" \
  --id "$DEMO_ID" \
  --html-root demo \
  --passphrase-env VEIL_DEMO_PASSPHRASE

echo "== stage 2: encrypt /vault/ =="
node veil.js "$STAGE" "$OUT" \
  --id "$VAULT_ID" \
  --html-root vault \
  --passphrase-env VEIL_VAULT_PASSPHRASE \
  --force

echo "== audit the artifact, once per zone =="
# Stage 2 must not have damaged or replaced stage 1's wrappers; an audit scoped
# to the vault would report them as out of scope rather than failing.
node veil.js verify "$OUT" \
  --id "$DEMO_ID" \
  --html-root demo \
  --passphrase-env VEIL_DEMO_PASSPHRASE

node veil.js verify "$OUT" \
  --input "$STAGE" \
  --id "$VAULT_ID" \
  --html-root vault \
  --passphrase-env VEIL_VAULT_PASSPHRASE

echo
echo "built $OUT; serve it over a secure context to test:"
echo "  python3 -m http.server 8765 --directory $OUT"
