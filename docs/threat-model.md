# Threat Model

Veil is deterrence on public static hosting, not access control. The right
mental model is that the alternative was leaving the content fully public.

## What it protects against

- Casual browsing and someone stumbling on the URL
- Search-engine indexing; every locked page is titled "Protected page" and
  carries a `noindex` robots meta
- Tampering with the contents of an encrypted page; AES-256-GCM is
  authenticated, so altered ciphertext fails to decrypt rather than rendering.
  Substituting or rolling back whole files is another matter; see
  [what the AAD does and does not bind](how-it-works.md#the-build)

## What it does not protect against

**Weak passphrases.** The ciphertext is public, so guessing is offline and
unlimited. PBKDF2 at 600,000 iterations raises the cost per guess; it does not
save a bad passphrase.

**Host compromise.** The host serves the wrapper JavaScript. A compromised host
can serve a modified wrapper that captures the passphrase.

**Any JavaScript running on the origin.** This does not require an injection
bug. Any script on the origin can read the cached master key out of
`sessionStorage` or `localStorage`, fetch the public wrappers, and decrypt them.
That includes a third-party analytics tag or chat widget on a *public* page of a
selective deployment, which never sees a passphrase prompt and may not feel like
part of the protected site at all. A stored master key is password-equivalent
access to that site; `sessionStorage` limits how long it survives, not which
scripts may read it.

The mitigation is a dedicated origin, which means a dedicated *hostname*: a
custom domain or subdomain, which GitHub Pages supports per repository. A project
site at the default `username.github.io/repo` location is not one; all of an
owner's default-location project sites share the `username.github.io` origin and
its storage. Run no third-party JavaScript anywhere on the protected origin.
Veil's CSP blocks `<script src>` on protected pages, but the public pages sharing
the origin are yours to police.

**Non-HTML assets.** Only HTML is encrypted. Images, fonts, and data files are
copied through and stay public. Inlining shrinks that surface where Veil can
prove it is safe; see [asset omission](how-it-works.md#asset-omission). Assume
every file you can still see in the output is readable, and never put a secret in
one.

**Metadata.** Page count, file sizes, directory structure, public asset paths,
and each payload's `path` field (the page's own public URL path) are all visible.
Titles are not.

**Identity.** There are no accounts and no revocation; anyone with the passphrase
can view the content, and rotating it does not reach a copy someone already
decrypted. See [rebuilds and rotation](how-it-works.md#rebuilds-and-passphrase-rotation).

**Distribution.** Getting the passphrase to the right people is your problem;
use a shared password manager or a direct message, not the repo.

## Good fit / bad fit

**Yes:** client previews, trip plans, proposal decks, private-ish docs,
prototypes on static hosting.

**No:** regulated data, identity-based access control, anything where a
compromised host or a leaked passphrase is more than an inconvenience.
