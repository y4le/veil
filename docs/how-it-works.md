# How Veil Works

Veil turns a directory of HTML into a directory of self-contained pages that
decrypt themselves in the browser. This page explains what happens at build
time, what ships in each page, and how unlock state behaves at runtime.

For the security boundary, read the [threat model](threat-model.md).

## The build

1. **Inline local CSS and JS.** Each page's `<link rel=stylesheet>` and
   `<script src>` references are replaced with the file's contents; relative and
   root-relative, quoted and unquoted references all resolve. Relative `url()`
   and `@import` paths inside inlined CSS are rewritten so they still resolve
   from the page. References Veil cannot inline (external URLs, module scripts,
   missing files) stay in the page and are reported as build warnings.
2. **Generate the site keys.** One random 256-bit master key (MK) per build,
   plus a random 128-bit salt. The passphrase is stretched into a key-encryption
   key (KEK) with PBKDF2-SHA256, 600,000 iterations by default, and the MK is
   wrapped with AES-256-GCM under that KEK.
3. **Encrypt each page.** Every page is encrypted with the MK under AES-256-GCM
   with its own random 96-bit IV.
4. **Write a wrapper.** Each encrypted page is replaced by a small HTML shell
   carrying the ciphertext and an unlock form.

Both encryptions carry authenticated additional data: the wrap uses
`["veil",2,"<site-id>","wrap"]`, each page uses
`["veil",2,"<site-id>","page","<output-relative-path>"]`. The domains are
separate, so a wrapped key cannot be replayed as page data, and a ciphertext and
IV moved into another page's payload fail to authenticate.

The limits are worth stating. The browser builds that tuple from the payload's
own `path` field, not from the URL the page was served at, so moving or
replaying a *whole* wrapper still decrypts; `veil verify` catches that
separately as `payload_path_mismatch`. Substituting a whole payload, or rolling
a site back to an earlier build, is out of scope. The `remember` field is a UI
default and is covered by neither tuple.

Non-HTML files are copied through byte-for-byte and stay public. Only HTML is
encrypted.

## Asset omission

Inlining shrinks the public surface, but only where Veil can prove it is safe:

- An inlined **CSS** file is omitted from the output when nothing public still
  references it.
- An inlined **JS** file is omitted only when the whole site is encrypted and no
  other JavaScript survives publicly; public pages and scripts can reach a file
  in ways no static scan sees.

Everything else is copied. Assume every non-HTML file you can still see in the
output is readable by anyone.

## What ships in a locked page

- The payload: ciphertext, IV, salt, wrapped MK, iteration count, site id, and
  the page's own output-relative path.
- A minimal unlock form and a small inline bootstrap script.
- A constant title, "Protected page", and a `noindex` robots meta; the real
  title only exists inside the ciphertext.
- A meta CSP that allows same-origin images, fonts, media, stylesheets and
  fetches plus inline scripts and styles, and blocks **every** `<script src>`,
  same-origin or not.

That CSP survives `document.write`, so it governs the decrypted page too.
Inlining is what keeps local scripts working under it; with `--no-inline`, local
JavaScript will not execute on protected pages.

Be precise about what it buys. It stops a protected page from *loading* an
external script file, but `script-src` is `'unsafe-inline'`, so any inline
script still runs: a third-party snippet pasted into the page, or third-party
code bundled into a local file Veil inlines, executes with access to the cached
key. Every script on a protected page is code you are trusting.

## Unlock at runtime

Web Crypto only exists in secure contexts, so a protected page needs HTTPS,
`localhost`, or `file:`; on plain HTTP the wrapper shows an error instead of a
prompt.

On load the wrapper looks for a cached master key, first in `sessionStorage`,
then in `localStorage`. A cached key that fails to decrypt the page is removed
from that tier and the next tier is tried; if none works, the passphrase prompt
appears. Unlocking derives the KEK, unwraps the MK, decrypts the page, caches
the MK, and writes the plaintext document.

The cached value is the master key, never the passphrase. It is stored under
`veil:v2:<site-id>:mk`:

- **Session** (default): cleared when the tab closes.
- **Remembered**: written to `localStorage` when the visitor ticks "Remember
  this device"; `--remember` makes that box checked by default.

Because the key is site-scoped rather than page-scoped, unlocking one page
unlocks every page in the same build. The `lock` button in the corner of a
decrypted page, and `?veil=logout`, clear both tiers.

## Site ids

`--id` scopes those storage keys. Browsers scope storage by origin, so two Veil
sites on one origin (`username.github.io/a` and `/b`) share a storage area and
need distinct ids. The default is the output directory's basename; Veil warns
when that is a generic name like `dist`, `public`, or `_site`, because two
unrelated sites would then collide. Pass `--id` explicitly.

## Rebuilds and passphrase rotation

Every build mints a fresh master key, so cached keys never survive a redeploy:
an old key fails to decrypt the new pages, is cleared, and the visitor is
prompted again. Rotating a passphrase therefore means rebuilding and
redeploying with the new one.

Rotation does not revoke anything already downloaded. Whoever had the old
passphrase could have kept the plaintext, and can still decrypt any copy of the
old artifact they saved.
