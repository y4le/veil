#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const readline = require('readline');
const crypto = require('crypto');

// ---------------------------------------------------------------------------
// Argument parsing
// ---------------------------------------------------------------------------

function printHelp() {
  const usage = `
Usage: veil <input-dir> <output-dir> [options]
       veil verify <output-dir> [options]

Encrypt a directory of HTML files for static hosting.
Run "veil verify --help" for the audit subcommand.

Options:
  --passphrase <pass>   Set passphrase (omit to prompt interactively)
  --passphrase-env <n>  Read passphrase from environment variable <n>
  --id <site-id>        Storage key scope (default: output dir basename)
  --iterations <N>      PBKDF2 iteration count (default: 600000)
  --remember            Check "Remember this device" by default
  --html-root <dir>     Encrypt only HTML under this input-relative dir (repeatable)
  --no-inline           Skip local CSS/JS inlining
  --force               Replace a non-empty output directory
  --version             Print the veil version
  --help                Show this help

The output directory is built fresh on every run: Veil stages the build in a
temporary sibling directory and moves it into place, so the output never mixes
files from different builds. A non-empty output directory is only replaced
with --force.
`.trim();
  console.log(usage);
}

function readVersion() {
  // veil.js is often vendored on its own, without the package it ships in.
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'));
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

/**
 * Read the value that follows an option. A value that looks like another
 * option is treated as missing: `--id --force` is a forgotten argument, not a
 * site id of "--force".
 */
function takeValue(args, i, flag) {
  const val = args[i];
  if (val === undefined || val.startsWith('-')) throw new Error(`${flag} requires a value`);
  return val;
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    inputDir: null,
    outputDir: null,
    passphrase: null,
    passphraseEnv: null,
    siteId: null,
    siteIdInferred: false,
    iterations: DEFAULT_ITERATIONS,
    remember: false,
    inline: true,
    force: false,
    htmlRoots: [],
  };
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printHelp();
      process.exit(0);
    } else if (arg === '--version') {
      console.log(`veil ${readVersion()}`);
      process.exit(0);
    } else if (arg === '--passphrase') {
      opts.passphrase = takeValue(args, ++i, '--passphrase');
    } else if (arg === '--passphrase-env') {
      opts.passphraseEnv = takeValue(args, ++i, '--passphrase-env');
    } else if (arg === '--id') {
      opts.siteId = takeValue(args, ++i, '--id');
      // An empty id would collapse every such site into one storage
      // namespace and violate the payload schema.
      if (opts.siteId === '') fatal('--id must not be empty');
    } else if (arg === '--iterations') {
      const raw = takeValue(args, ++i, '--iterations');
      // A full decimal integer only: "100000junk", "1e6" and "" are typos, and
      // silently taking the leading digits would weaken the derivation.
      if (!/^\d+$/.test(raw) || Number(raw) < 1) {
        fatal('--iterations must be a positive integer');
      }
      opts.iterations = Number(raw);
    } else if (arg === '--remember') {
      opts.remember = true;
    } else if (arg === '--html-root') {
      opts.htmlRoots.push(normalizeHtmlRoot(takeValue(args, ++i, '--html-root')));
    } else if (arg === '--no-inline') {
      opts.inline = false;
    } else if (arg === '--force') {
      opts.force = true;
    } else if (arg.startsWith('-')) {
      fatal(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length < 2) {
    printHelp();
    process.exit(1);
  }
  if (positional.length > 2) {
    fatal(`Unexpected argument: ${positional[2]}`);
  }

  opts.inputDir = path.resolve(positional[0]);
  opts.outputDir = path.resolve(positional[1]);

  if (opts.siteId === null) {
    opts.siteId = path.basename(opts.outputDir);
    opts.siteIdInferred = true;
  }

  return opts;
}

// Output directory names common enough that two different sites on one origin
// would share storage keys if the id were inferred from them.
const GENERIC_SITE_IDS = new Set([
  'dist', 'build', 'public', 'out', 'output', 'site',
  '_site', 'encrypted', '_encrypted', 'www', 'html',
]);

/**
 * Non-fatal advice about choices that weaken or surprise. Emitted from main()
 * so --help and --version stay clean, and before any filesystem work so the
 * warning is visible even when the build fails later.
 */
function emitStartupWarnings(opts) {
  if (opts.passphrase) {
    warn('--passphrase is visible in process listings and shell history — prefer --passphrase-env or the interactive prompt');
  }
  if (opts.iterations < DEFAULT_ITERATIONS) {
    warn(`${opts.iterations} PBKDF2 iterations is below the default ${DEFAULT_ITERATIONS} — weaker against offline guessing`);
  }
  if (opts.siteIdInferred && GENERIC_SITE_IDS.has(opts.siteId.toLowerCase())) {
    warn(`inferred site id "${opts.siteId}" is generic — pass --id to avoid storage collisions on shared origins`);
  }
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function fatal(msg) {
  console.error(`veil: ${msg}`);
  process.exit(1);
}

function warn(msg) {
  console.error(`veil: warning: ${msg}`);
}

// Raw-mode control keys, by code point: comparing against escape literals is
// the same thing, but these read as the keys they are.
const KEY_ETX = 3; // Ctrl-C
const KEY_EOT = 4; // Ctrl-D
const KEY_BACKSPACE = 8;
const KEY_DEL = 127;

/**
 * Read one line from a TTY without echoing it.
 *
 * Raw mode hands over whatever the terminal has buffered, so one data event is
 * not one keystroke: a pasted passphrase arrives as "secret\n" in a single
 * chunk, and comparing the whole chunk to '\n' would bury the newline inside
 * the passphrase. Every chunk is walked per code point, which also keeps
 * backspace from cutting an astral character (emoji, some CJK) in half.
 */
function readHidden(promptText, out = process.stdout) {
  return new Promise((resolve) => {
    out.write(promptText);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');

    let input = '';
    // Escape-sequence state, kept across chunks: an arrow key arrives as
    // ESC [ D — dropping only the ESC byte would append the printable
    // "[D" to the passphrase. 'esc' has seen ESC, 'csi' is inside ESC [ ...
    // (ends at a final byte 0x40-0x7E), 'ss3' is ESC O awaiting one byte.
    let escState = null;
    const finish = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('data', onData);
      out.write('\n');
      resolve(input);
    };
    const onData = (chunk) => {
      for (const ch of Array.from(chunk)) {
        const code = ch.codePointAt(0);
        // Abort and line terminators come first — an incomplete escape
        // sequence must never trap Ctrl-C or swallow Enter.
        if (code === KEY_ETX) {
          // Ctrl-C: hand the terminal back before dying, or the shell that
          // follows inherits a raw, echo-less tty.
          process.stdin.setRawMode(false);
          out.write('\n');
          process.exit(1);
        }
        if (ch === '\n' || ch === '\r' || code === KEY_EOT) {
          // End of entry — anything after it in this chunk is not ours.
          finish();
          return;
        }
        if (escState === 'esc') {
          if (ch === '[') { escState = 'csi'; continue; }
          if (ch === 'O') { escState = 'ss3'; continue; }
          escState = null; // lone ESC + one char: discard both
          continue;
        }
        if (escState === 'csi') {
          if (code >= 0x40 && code <= 0x7e) escState = null; // final byte
          continue;
        }
        if (escState === 'ss3') {
          escState = null;
          continue;
        }
        if (code === 0x1b) {
          escState = 'esc';
          continue;
        }
        if (code === KEY_DEL || code === KEY_BACKSPACE) {
          const chars = Array.from(input);
          chars.pop();
          input = chars.join('');
          continue;
        }
        // Any remaining control character is not passphrase material.
        if (code < 0x20) continue;
        input += ch;
      }
    };
    process.stdin.on('data', onData);
  });
}

/** Read one line from a pipe, printing nothing: scripts own that stdout. */
function readPipedLine() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin });
    let settled = false;
    const done = (value) => {
      if (settled) return;
      settled = true;
      rl.close();
      // rl.close() does not release the stream, and pause() still leaves
      // the pipe handle holding the event loop: a caller that keeps its
      // write end open would wait forever for this process to exit. The
      // line is read and stdin is never touched again, so close it.
      process.stdin.destroy();
      resolve(value);
    };
    rl.once('line', done);
    // Handle closed stdin (e.g., </dev/null) — 'close' fires with no 'line'
    rl.once('close', () => done(''));
  });
}

async function promptPassphrase() {
  // A pipe feeds exactly one value; prompting into it would only pollute the
  // caller's stdout.
  if (!process.stdin.isTTY) {
    return readPipedLine();
  }
  // A typo in a passphrase nobody can see locks the site out of its own
  // content, so interactive entry is always confirmed.
  const passphrase = await readHidden('Passphrase: ');
  const confirmation = await readHidden('Confirm passphrase: ');
  if (passphrase !== confirmation) {
    fatal('passphrases do not match');
  }
  return passphrase;
}

/**
 * Read a passphrase that will be checked against existing ciphertext.
 *
 * No confirmation: authentication is the confirmation — a typo fails to
 * decrypt and says so. The prompt goes to stderr so `--json` keeps stdout to
 * the report alone.
 */
function promptVerificationPassphrase() {
  return readHidden('Passphrase: ', process.stderr);
}

/**
 * Normalize a --html-root value. Throws rather than exiting: the encrypt path
 * turns this into the same fatal error through main()'s catch, and verify maps
 * it to its own "audit could not be performed" exit code.
 */
function normalizeHtmlRoot(root) {
  const normalized = path.normalize(root);
  if (path.isAbsolute(normalized)) {
    throw new Error(`--html-root must be relative, not absolute: ${root}`);
  }
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error(`--html-root cannot escape the directory it names: ${root}`);
  }
  return normalized === '.' ? '.' : normalized.replace(new RegExp(`${escapeRegExp(path.sep)}+$`), '');
}

function escapeRegExp(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function shouldEncryptHtml(relPath, htmlRoots) {
  if (htmlRoots.length === 0) return true;
  return htmlRoots.some((root) => {
    if (root === '.') return true;
    return relPath === root || relPath.startsWith(`${root}${path.sep}`);
  });
}

// ---------------------------------------------------------------------------
// Asset inlining
// ---------------------------------------------------------------------------

/**
 * Find the true end of the opening tag that starts at `start` (the '<'),
 * returning the index just past its '>'. Quoted attribute values are skipped
 * whole, so a '>' inside one cannot truncate the tag. A quote only opens a
 * value right after '=', matching how browsers tokenize `href=x'y`.
 */
function findTagEnd(html, start) {
  let i = start + 1;
  let afterEquals = false;
  while (i < html.length) {
    const ch = html[i];
    if (ch === '=') {
      afterEquals = true;
    } else if (/\s/.test(ch)) {
      // separator: whatever came before still applies
    } else if (afterEquals && (ch === '"' || ch === "'")) {
      const close = html.indexOf(ch, i + 1);
      i = close === -1 ? html.length : close + 1;
      afterEquals = false;
      continue;
    } else if (ch === '>') {
      return i + 1;
    } else {
      afterEquals = false;
    }
    i++;
  }
  return html.length;
}

/**
 * Elements whose content a browser tokenizes as text rather than markup:
 * raw text (script, style, xmp, iframe, noembed, noframes) and RCDATA
 * (textarea, title). Both end at the first matching close sequence.
 *
 * <noscript> is included because decrypted Veil pages always run with
 * scripting enabled, where its content is raw text ending at the first
 * </noscript> — rewriting inside it could push author bytes (e.g. a CSS
 * string containing "</noscript>") out into active markup. Public-side
 * reference collection separately scans noscript bodies as markup so
 * scripting-disabled fallback assets are still retained.
 */
const RAW_TEXT_ELEMENTS = new Set([
  'script', 'style', 'noscript', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes',
]);

/**
 * Walk a document once and yield its opening tags, skipping everything a
 * browser would not read as markup: comments, doctypes, closing tags, and the
 * text inside raw-text and RCDATA elements. Tag-shaped text in an attribute
 * value, a comment, or a script body therefore never reaches the passes below.
 *
 * Each token is { name (lowercased), tag, start, end }, where start..end spans
 * the opening tag. A raw-text element also carries rawEnd (where its body
 * stops) and closeEnd (just past its closing tag, or null when the document
 * ends first), so a pass can replace the whole element as one span.
 */
function* scanTags(html) {
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) return;
    const next = html[lt + 1];
    if (html.startsWith('<!--', lt)) {
      const close = html.indexOf('-->', lt + 4);
      i = close === -1 ? html.length : close + 3;
      continue;
    }
    if (next === '!' || next === '?' || next === '/') {
      const close = html.indexOf('>', lt);
      i = close === -1 ? html.length : close + 1;
      continue;
    }
    if (next === undefined || !/[a-zA-Z]/.test(next)) {
      i = lt + 1; // stray '<': data, not a tag
      continue;
    }
    const end = findTagEnd(html, lt);
    let j = lt + 1;
    while (j < html.length && !/[\s/>]/.test(html[j])) j++;
    const token = { name: html.slice(lt + 1, j).toLowerCase(), tag: html.slice(lt, end), start: lt, end };
    i = end;
    if (RAW_TEXT_ELEMENTS.has(token.name)) {
      // Text, not markup: it ends at the first matching close sequence
      // whatever the quoting, so nothing inside can be a tag.
      const closer = new RegExp(`</${token.name}`, 'gi');
      closer.lastIndex = end;
      const m = closer.exec(html);
      token.rawEnd = m ? m.index : html.length;
      const gt = m ? html.indexOf('>', closer.lastIndex) : -1;
      token.closeEnd = gt === -1 ? null : gt + 1;
      i = token.closeEnd === null ? html.length : token.closeEnd;
    }
    yield token;
    // Everything after <plaintext> is text: no tag can follow it.
    if (token.name === 'plaintext') return;
  }
}

/**
 * Find an attribute in a tag string, tokenizing the tag rather than pattern
 * matching it: text that looks like an attribute inside another attribute's
 * quoted value can never match, and `data-src` can never match `src`.
 *
 * Returns { value, start, end } for the first attribute whose name matches
 * (case-insensitively), where start..end is the exact span the attribute
 * occupies in `tag` and value is null for a valueless attribute.
 */
function findAttr(tag, name) {
  const target = name.toLowerCase();
  let i = 1; // skip '<'
  while (i < tag.length && !/[\s/>]/.test(tag[i])) i++; // skip the tag name
  while (i < tag.length) {
    while (i < tag.length && /[\s/]/.test(tag[i])) i++;
    if (i >= tag.length || tag[i] === '>') break;
    const start = i;
    while (i < tag.length && !/[\s=/>]/.test(tag[i])) i++;
    const attrName = tag.slice(start, i);
    if (attrName === '') {
      i++; // stray '=' or similar: step over it so the scan cannot stall
      continue;
    }
    let end = i;
    let value = null;
    let j = i;
    while (j < tag.length && /\s/.test(tag[j])) j++;
    if (tag[j] === '=') {
      j++;
      while (j < tag.length && /\s/.test(tag[j])) j++;
      const quote = tag[j];
      if (quote === '"' || quote === "'") {
        const close = tag.indexOf(quote, j + 1);
        value = close === -1 ? tag.slice(j + 1) : tag.slice(j + 1, close);
        end = close === -1 ? tag.length : close + 1;
      } else {
        const from = j;
        while (j < tag.length && !/[\s>]/.test(tag[j])) j++;
        value = tag.slice(from, j);
        end = j;
      }
      i = end;
    }
    if (attrName.toLowerCase() === target) return { value, start, end };
  }
  return null;
}

/** Extract an attribute value from a tag string (quoted or unquoted). */
function getAttr(tag, name) {
  const found = findAttr(tag, name);
  return found ? found.value : null;
}

/** Split a URL into its path part and any ?query#fragment suffix. */
function splitUrl(url) {
  const i = url.search(/[?#]/);
  return i === -1
    ? { pathPart: url, suffix: '' }
    : { pathPart: url.slice(0, i), suffix: url.slice(i) };
}

/** True for URLs Veil can never resolve locally: schemes and protocol-relative. */
function isExternalUrl(url) {
  return /^\/\/|^[a-z][a-z0-9+.-]*:/i.test(url);
}

/**
 * Resolve a local asset reference (relative or root-relative) to a real,
 * input-root-confined filesystem path. Returns null when the file is
 * missing, escapes the root, or the URL cannot be decoded.
 */
function resolveAssetPath(baseDir, urlPath, inputRoot) {
  let decoded;
  try {
    decoded = decodeURIComponent(urlPath);
  } catch {
    return null;
  }
  const resolved = decoded.startsWith('/')
    ? path.join(inputRoot, decoded.slice(1))
    : path.resolve(baseDir, decoded);
  try {
    const real = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(inputRoot);
    const rel = path.relative(realRoot, real);
    // '..' must match only as a whole path segment: a real in-root file
    // named '..weird.css' yields rel '..weird.css' and is not an escape.
    if (rel === '..' || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel)) return null;
    return real;
  } catch {
    return null; // file doesn't exist
  }
}

/**
 * Read a text file, requiring valid UTF-8. Everything Veil encrypts or
 * inlines is re-encoded as UTF-8 in the browser, so a page or asset in any
 * other encoding would be silently corrupted — fail loudly instead.
 */
function readUtf8(file, label) {
  const buf = fs.readFileSync(file);
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf);
  } catch {
    // Throw (not fatal/exit) so staging cleanup in main() still runs.
    const err = new Error(`not valid UTF-8: ${label}\nVeil requires UTF-8 text inputs (HTML and inlined CSS/JS).`);
    err.code = 'VEIL_NOT_UTF8';
    throw err;
  }
}

/** Escape </script> sequences in JS to prevent premature tag closure. */
function escapeScriptClose(js) {
  return js.replace(/<\/(script)/gi, '<\\/$1');
}

/** Escape </style> sequences in CSS the same way (\/ is a valid CSS escape). */
function escapeStyleClose(css) {
  return css.replace(/<\/(style)/gi, '<\\/$1');
}

/**
 * Resolve CSS escape sequences to the characters they denote, so a reference
 * written as `my\ icon.png` or `\69 con.png` names the file it means. CSS
 * preprocessing folds CRLF into one newline, so the pair terminates a hex
 * escape as a unit.
 */
function cssUnescape(s) {
  return s.replace(/\\([0-9a-fA-F]{1,6})(?:\r\n|[ \t\n\r\f])?|\\(?:\r\n|[\n\r\f])|\\([\s\S])/g, (m, hex, ch) => {
    if (ch !== undefined) return ch;
    // A backslash before a newline is a line continuation: it contributes
    // nothing, not the newline itself.
    if (hex === undefined) return '';
    const cp = parseInt(hex, 16);
    return cp > 0 && cp <= 0x10ffff ? String.fromCodePoint(cp) : '�';
  });
}

/** Characters that must not survive raw inside an emitted url("...") token. */
const SUFFIX_ESCAPES = { '"': '%22', "'": '%27', '\\': '%5C', '(': '%28', ')': '%29' };

/** Convert a real path under realRoot to a posix input-relative path. */
function rootRelPosix(realPath, realRoot) {
  return path.relative(realRoot, realPath).split(path.sep).join('/');
}

/**
 * Rewrite relative and root-relative url()/@import references in CSS that
 * is being moved from its own file into a page, so they still resolve from
 * the page's location. External, data:, and fragment-only URLs are left
 * alone; unresolvable local references are left unchanged and reported.
 *
 * The scan is lexical, not a set of global regexes: comments and ordinary
 * string literals are copied through verbatim, so `content:"url(x.png)"` and
 * commented-out rules survive untouched. It is not a CSS parser — it only
 * knows comments, strings, and the two tokens it rewrites.
 */
function rewriteCssUrls(css, cssDir, pageDirPosix, inputRoot, onWarn, onKeep) {
  const realRoot = fs.realpathSync(inputRoot);
  const n = css.length;

  // kind is 'import' for stylesheet loads, 'url' for everything else.
  const rewriteOne = (rawUrl, kind) => {
    const { pathPart, suffix } = splitUrl(cssUnescape(rawUrl));
    if (pathPart === '') return null;
    if (isExternalUrl(pathPart)) {
      // Images and fonts have their own CSP directives and commonly live on
      // a CDN; only cross-origin stylesheet loads are worth reporting.
      if (kind === 'import') {
        onWarn(rawUrl, 'external CSS reference left as-is; cross-origin loads are blocked by the page CSP');
      }
      return null;
    }
    const real = resolveAssetPath(cssDir, pathPart, inputRoot);
    if (!real) {
      onWarn(rawUrl, 'CSS reference not found inside the input directory; left unchanged');
      return null;
    }
    onKeep(real);
    const rel = path.posix.relative(pageDirPosix, rootRelPosix(real, realRoot));
    // The result is emitted inside url("...")/@import "...". Percent-encode
    // each path segment so quotes, '#', '?' and backslashes in file names
    // cannot escape it, and the query/fragment for the same reason — leaving
    // '?', '#', '&' and '=' intact so the suffix still means what it did.
    // encodeURIComponent leaves ' ( ) alone, so those are mapped explicitly.
    const safeSuffix = suffix.replace(/["'\\()\s]/g, (c) => SUFFIX_ESCAPES[c] || encodeURIComponent(c));
    return rel.split('/').map(encodeURIComponent).join('/') + safeSuffix;
  };

  /** Read a quoted string starting at its opening quote; escapes stay raw. */
  const readString = (start) => {
    const quote = css[start];
    let j = start + 1;
    let value = '';
    while (j < n) {
      const ch = css[j];
      if (ch === '\\' && j + 1 < n) {
        value += ch + css[j + 1];
        j += 2;
      } else if (ch === quote) {
        j++;
        break;
      } else {
        value += ch;
        j++;
      }
    }
    return { value, end: j };
  };

  const isUrlToken = (pos) => /^url\(/i.test(css.slice(pos, pos + 4));

  /** Consume a url(...) token at pos; null when it is not well formed. */
  const readUrlToken = (pos, kind) => {
    let j = pos + 4;
    while (j < n && /\s/.test(css[j])) j++;
    let rawUrl;
    let argEnd;
    if (css[j] === '"' || css[j] === "'") {
      const str = readString(j);
      rawUrl = str.value;
      argEnd = str.end;
    } else {
      const from = j;
      // An escape can carry any character into an unquoted url, whitespace
      // and quotes included, so it is consumed as a unit: a hex escape runs
      // up to six digits plus one optional whitespace terminator.
      while (j < n && !/['")\s]/.test(css[j])) {
        if (css[j] !== '\\' || j + 1 >= n) {
          j++;
          continue;
        }
        j++;
        const hex = /^[0-9a-fA-F]{1,6}/.exec(css.slice(j, j + 6));
        if (!hex) {
          j++;
          continue;
        }
        j += hex[0].length;
        // CRLF is one newline after preprocessing, so it terminates the
        // escape as a pair; any other whitespace character does so alone.
        if (css[j] === '\r' && css[j + 1] === '\n') j += 2;
        else if (/[ \t\r\n\f]/.test(css[j] || '')) j++;
      }
      rawUrl = css.slice(from, j);
      argEnd = j;
    }
    let k = argEnd;
    while (k < n && /\s/.test(css[k])) k++;
    if (css[k] !== ')') return null;
    const rewritten = rewriteOne(rawUrl, kind);
    return {
      text: rewritten === null ? css.slice(pos, k + 1) : `url("${rewritten}")`,
      end: k + 1,
    };
  };

  /** Skip the whitespace and comments that separate tokens, from pos. */
  const skipSeparators = (pos) => {
    let j = pos;
    for (;;) {
      if (j < n && /\s/.test(css[j])) {
        j++;
      } else if (css[j] === '/' && css[j + 1] === '*') {
        const close = css.indexOf('*/', j + 2);
        j = close === -1 ? n : close + 2;
      } else {
        return j;
      }
    }
  };

  let out = '';
  let i = 0;
  let depth = 0; // brace nesting, counted outside strings and comments
  while (i < n) {
    const ch = css[i];
    if (ch === '/' && css[i + 1] === '*') {
      const close = css.indexOf('*/', i + 2);
      const end = close === -1 ? n : close + 2;
      out += css.slice(i, end);
      i = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const str = readString(i);
      out += css.slice(i, str.end);
      i = str.end;
      continue;
    }
    // A url token only counts at an identifier boundary, so `-moz-url(` and
    // the tail of an identifier are not mistaken for one.
    if (isUrlToken(i) && !/[A-Za-z0-9_\-\\]/.test(css[i - 1] || '')) {
      const tok = readUrlToken(i, 'url');
      out += tok ? tok.text : css.slice(i, i + 4);
      i = tok ? tok.end : i + 4;
      continue;
    }
    // @import is only valid at the top level of a stylesheet, so it is only
    // recognized at depth 0: text inside a block — a declaration value such
    // as `--x: @import "y";` — belongs to something larger and is copied
    // through. Its argument may follow immediately (`@import"y.css"`).
    if (ch === '@' && depth === 0 && /^@import/i.test(css.slice(i, i + 7))) {
      const j = skipSeparators(i + 7);
      if (css[j] === '"' || css[j] === "'") {
        const str = readString(j);
        const rewritten = rewriteOne(str.value, 'import');
        out += css.slice(i, j) + (rewritten === null ? css.slice(j, str.end) : `"${rewritten}"`);
        i = str.end;
        continue;
      }
      if (isUrlToken(j)) {
        const tok = readUrlToken(j, 'import');
        if (tok) {
          out += css.slice(i, j) + tok.text;
          i = tok.end;
          continue;
        }
      }
    }
    if (ch === '{') depth++;
    else if (ch === '}' && depth > 0) depth--;
    out += ch;
    i++;
  }
  return out;
}

/**
 * Collect the local url()/@import targets of a stylesheet as real paths.
 * The rewriter doubles as the scanner — its keep callback reports every
 * reference it resolves — so both share one CSS lexer.
 */
function collectCssRefs(cssText, baseDir, inputRoot) {
  const refs = new Set();
  rewriteCssUrls(cssText, baseDir, '.', inputRoot, () => {}, (real) => refs.add(real));
  return refs;
}

/**
 * Inline local CSS <link> tags and local JS <script src> tags into the HTML.
 *
 * Returns the transformed HTML plus a report used by the build layer:
 * - inlined: real paths whose contents were embedded
 * - inlinedScripts: the subset of those embedded as JavaScript, which the
 *   build layer must treat as JS whatever the file is named
 * - kept: real paths that remain referenced at runtime (CSS url()/@import
 *   targets, module scripts) and must stay in the public output
 * - warnings: per-resource notes about references that stay in the page,
 *   including ones the page CSP will block
 *
 * @param {string} html - The HTML content
 * @param {string} pageRelPath - The page path relative to inputRoot
 * @param {string} inputRoot - The top-level input directory (path confinement boundary)
 */
function inlineAssets(html, pageRelPath, inputRoot) {
  const htmlDir = path.dirname(path.join(inputRoot, pageRelPath));
  const pageDirPosix = path.posix.dirname(pageRelPath.split(path.sep).join('/'));
  const inlined = new Set();
  const inlinedScripts = new Set();
  const kept = new Set();
  const warnings = [];
  const warn = (url, reason) => warnings.push({ page: pageRelPath, url, reason });

  // Inline local CSS: <link rel="stylesheet" href="local.css"> → <style>contents</style>
  // Returns the replacement for a stylesheet link, or null to keep it.
  const inlineLink = (tag) => {
    const rel = getAttr(tag, 'rel');
    if (!rel || !rel.trim().toLowerCase().split(/\s+/).includes('stylesheet')) return null;
    const href = getAttr(tag, 'href');
    if (!href) return null;
    const { pathPart } = splitUrl(href);
    if (pathPart === '') return null;
    if (isExternalUrl(pathPart)) {
      warn(href, 'external stylesheet left as-is; cross-origin stylesheets are blocked by the page CSP');
      return null;
    }
    const cssPath = resolveAssetPath(htmlDir, pathPart, inputRoot);
    if (!cssPath) {
      warn(href, 'stylesheet not found inside the input directory; left as a reference');
      return null;
    }
    try {
      let css = readUtf8(cssPath, `${href} (inlined by ${pageRelPath})`);
      css = rewriteCssUrls(
        css,
        path.dirname(cssPath),
        pageDirPosix,
        inputRoot,
        (u, reason) => warn(`${href} → ${u}`, reason),
        (real) => kept.add(real)
      );
      css = escapeStyleClose(css);
      inlined.add(cssPath);
      const media = getAttr(tag, 'media');
      const mediaAttr = media ? ` media="${media}"` : '';
      return `<style${mediaAttr}>${css}</style>`;
    } catch (err) {
      if (err && err.code === 'VEIL_NOT_UTF8') throw err;
      warn(href, 'could not read stylesheet; left as a reference');
      return null;
    }
  };

  // Inline local JS: <script src="local.js"></script> → <script>contents</script>
  // Returns the replacement for an empty-bodied script tag, or null to keep it.
  const inlineScript = (tag) => {
    const src = getAttr(tag, 'src');
    if (!src) return null;
    const { pathPart } = splitUrl(src);
    if (pathPart === '') return null;
    if (isExternalUrl(pathPart)) {
      warn(src, 'external script will be blocked by the page CSP (scripts must be inline)');
      return null;
    }
    const type = (getAttr(tag, 'type') || '').trim().toLowerCase();
    if (type === 'module') {
      // Inlining a module changes its import base URL; leave it, keep the
      // file public, and be explicit that the CSP will block it.
      const real = resolveAssetPath(htmlDir, pathPart, inputRoot);
      if (real) kept.add(real);
      warn(src, 'module script cannot be inlined and will be blocked by the page CSP');
      return null;
    }
    const jsPath = resolveAssetPath(htmlDir, pathPart, inputRoot);
    if (!jsPath) {
      warn(src, 'script not found inside the input directory; the reference will be blocked by the page CSP');
      return null;
    }
    try {
      const js = escapeScriptClose(readUtf8(jsPath, `${src} (inlined by ${pageRelPath})`));
      inlined.add(jsPath);
      inlinedScripts.add(jsPath);
      // Preserve other attributes (type, data-*, etc.) minus src, cutting the
      // exact span the tokenizer found rather than re-matching it.
      let openTag = tag;
      const srcAttr = findAttr(openTag, 'src');
      if (srcAttr) {
        let cut = srcAttr.start;
        while (cut > 0 && /\s/.test(openTag[cut - 1])) cut--;
        openTag = openTag.slice(0, cut) + openTag.slice(srcAttr.end);
      }
      return `${openTag}${js}</script>`;
    } catch (err) {
      if (err && err.code === 'VEIL_NOT_UTF8') throw err;
      warn(src, 'could not read script; the reference will be blocked by the page CSP');
      return null;
    }
  };

  // One walk applies both passes. A script is inlined only when its body is
  // empty and it is closed — a body would otherwise be lost — so its span
  // covers the closing tag; anything left is reported by the sweep below.
  {
    let out = '';
    let last = 0;
    for (const token of scanTags(html)) {
      let replacement = null;
      let spanEnd = token.end;
      if (token.name === 'link') {
        replacement = inlineLink(token.tag);
      } else if (token.name === 'script' && token.closeEnd !== null && html.slice(token.end, token.rawEnd).trim() === '') {
        replacement = inlineScript(token.tag);
        spanEnd = token.closeEnd;
      }
      if (replacement === null) continue;
      out += html.slice(last, token.start) + replacement;
      last = spanEnd;
    }
    html = out + html.slice(last);
  }

  // Whatever survived both passes — a tag with a body, an unreadable file, a
  // module — still loads a script by URL, which the page CSP forbids. One
  // sweep over the transformed page catches them all, skipping resources a
  // more specific warning already covered.
  warnings.push(...scanBlockedScripts(html, pageRelPath, new Set(warnings.map((w) => w.url))));

  return { html, inlined, inlinedScripts, kept, warnings };
}

/**
 * Report every <script src> left in a page: the wrapper CSP allows inline
 * scripts only, so any surviving reference is dead. Open tags only — a tag's
 * body has no bearing on whether its src is blocked.
 */
function scanBlockedScripts(html, pageRelPath, seenUrls = new Set()) {
  const warnings = [];
  for (const token of scanTags(html)) {
    if (token.name !== 'script') continue;
    const src = getAttr(token.tag, 'src');
    if (src && !seenUrls.has(src)) {
      seenUrls.add(src);
      warnings.push({
        page: pageRelPath,
        url: src,
        reason: 'script src remains in the page and will be blocked by the page CSP',
      });
    }
  }
  return warnings;
}

/**
 * Collect local asset paths referenced by a passthrough (public) HTML file.
 * Used to decide which inlined assets must still be copied. Deliberately
 * broad — any link href or script src counts as a reference.
 */
function collectLocalRefs(html, pageRelPath, inputRoot) {
  const refs = new Set();
  const htmlDir = path.dirname(path.join(inputRoot, pageRelPath));
  const add = (url) => {
    const { pathPart } = splitUrl(url);
    if (pathPart === '' || isExternalUrl(pathPart)) return;
    const real = resolveAssetPath(htmlDir, pathPart, inputRoot);
    if (real) refs.add(real);
  };
  const scan = (fragment) => {
    for (const token of scanTags(fragment)) {
      if (token.name === 'link') {
        const href = getAttr(token.tag, 'href');
        if (href) add(href);
      } else if (token.name === 'script') {
        const src = getAttr(token.tag, 'src');
        if (src) add(src);
      } else if (token.name === 'noscript' && token.rawEnd !== undefined) {
        // A scripting-disabled browser parses noscript content as markup;
        // keep any fallback assets it references.
        scan(fragment.slice(token.end, token.rawEnd));
      }
    }
  };
  scan(html);
  return refs;
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

const FORMAT_VERSION = 2;
const MIN_ITERATIONS = 100000;
const DEFAULT_ITERATIONS = 600000;

/**
 * Build the AAD that binds metadata to authenticated ciphertext.
 *
 * v2 encodes a JSON array — unambiguous even when siteId or path contain
 * delimiters, and JSON.stringify produces identical bytes in Node and the
 * browser for these value types. Two domains are separated: 'wrap' seals
 * the master key, 'page' seals a page and binds it to its output-relative
 * path, so a ct/iv pair moved to another page's payload fails to
 * authenticate. (Copying the whole {path, ct, iv} tuple — or the whole
 * file — is indistinguishable from the original and out of scope, as is
 * rollback; see the threat model.)
 *
 * The version is an explicit argument, not the constant: encryption passes
 * FORMAT_VERSION, decryption passes the version the payload declares, so
 * older payloads authenticate under the AAD they were sealed with (v1 used
 * one colon-delimited string for both domains).
 */
function buildAad(version, siteId, purpose, pagePath) {
  if (version < 2) {
    return Buffer.from(`veil:v${version}:${siteId}`);
  }
  const parts = purpose === 'page'
    ? ['veil', version, siteId, 'page', pagePath]
    : ['veil', version, siteId, 'wrap'];
  return Buffer.from(JSON.stringify(parts));
}

/**
 * Generate all cryptographic material for a build.
 * Returns an object with site-wide keys and metadata needed by every page wrapper.
 *
 * @param {string} passphrase
 * @param {number} iterations - PBKDF2 iteration count
 * @param {string} siteId - Used in AAD to bind crypto to this site
 * @returns {{ salt: Buffer, iterations: number, wrappedMk: Buffer, wrapIv: Buffer, mk: Buffer }}
 */
function generateSiteKeys(passphrase, iterations, siteId) {
  // main() rejects a low iteration count before any work starts; this is the
  // library-level guard for callers that did not.
  if (iterations < MIN_ITERATIONS) {
    throw new Error(`Iterations must be at least ${MIN_ITERATIONS} (got ${iterations})`);
  }

  // Random site master key (256-bit)
  const mk = crypto.randomBytes(32);

  // Random salt for PBKDF2 (128-bit)
  const salt = crypto.randomBytes(16);

  // Derive KEK from passphrase
  const kek = crypto.pbkdf2Sync(passphrase, salt, iterations, 32, 'sha256');

  // Wrap MK with AES-256-GCM using KEK, with AAD
  const aad = buildAad(FORMAT_VERSION, siteId, 'wrap');
  const wrapIv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', kek, wrapIv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([cipher.update(mk), cipher.final()]);
  const authTag = cipher.getAuthTag();
  const wrappedMk = Buffer.concat([encrypted, authTag]); // 32 + 16 = 48 bytes

  return { salt, iterations, wrappedMk, wrapIv, mk };
}

/**
 * Encrypt a single HTML page with the site master key.
 *
 * @param {string} html - The plaintext HTML content
 * @param {Buffer} mk - The site master key
 * @param {string} siteId - Used in AAD
 * @param {string} pagePath - Output-relative posix path, bound into the AAD
 * @returns {{ ciphertext: Buffer, iv: Buffer }}
 */
function encryptPage(html, mk, siteId, pagePath) {
  const aad = buildAad(FORMAT_VERSION, siteId, 'page', pagePath);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', mk, iv);
  cipher.setAAD(aad);
  const encrypted = Buffer.concat([
    cipher.update(html, 'utf8'),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();
  return {
    ciphertext: Buffer.concat([encrypted, authTag]),
    iv,
  };
}

/**
 * Build the metadata payload embedded in each wrapper page.
 * This contains everything the browser needs to derive KEK and unwrap MK.
 */
function buildPayloadMeta(siteKeys, siteId, remember) {
  return {
    v: FORMAT_VERSION,
    siteId,
    salt: siteKeys.salt.toString('base64'),
    iterations: siteKeys.iterations,
    wrappedMk: siteKeys.wrappedMk.toString('base64'),
    wrapIv: siteKeys.wrapIv.toString('base64'),
    remember,
  };
}

/**
 * Validate a wrapper payload's schema. Returns an array of error strings;
 * empty means valid. Field lengths are exact byte counts after strict
 * (canonical) base64 decoding, so a payload that merely decodes leniently
 * is rejected.
 */
function validatePayload(payload) {
  if (!payload || typeof payload !== 'object') return ['payload is not an object'];
  const errors = [];
  if (!Number.isInteger(payload.v) || payload.v < 1) {
    errors.push('v must be a positive integer');
  }
  if (typeof payload.siteId !== 'string' || payload.siteId === '') {
    errors.push('siteId must be a non-empty string');
  }
  if (Number.isInteger(payload.v) && payload.v >= 2 && (typeof payload.path !== 'string' || payload.path === '')) {
    errors.push('path must be a non-empty string');
  }
  if (!Number.isInteger(payload.iterations) || payload.iterations < MIN_ITERATIONS) {
    errors.push(`iterations must be an integer of at least ${MIN_ITERATIONS}`);
  }
  if (typeof payload.remember !== 'boolean') {
    errors.push('remember must be a boolean');
  }
  const b64Field = (field, lengthOk, expected) => {
    const s = payload[field];
    if (typeof s !== 'string') {
      errors.push(`${field} must be a base64 string`);
      return;
    }
    const buf = Buffer.from(s, 'base64');
    if (buf.toString('base64') !== s) {
      errors.push(`${field} is not canonical base64`);
      return;
    }
    if (!lengthOk(buf.length)) {
      errors.push(`${field} must be ${expected} (got ${buf.length} bytes)`);
    }
  };
  b64Field('salt', (n) => n === 16, '16 bytes');
  b64Field('wrapIv', (n) => n === 12, '12 bytes');
  b64Field('wrappedMk', (n) => n === 48, '48 bytes');
  b64Field('iv', (n) => n === 12, '12 bytes');
  b64Field('ct', (n) => n >= 16, 'at least 16 bytes');
  return errors;
}

/**
 * Decrypt a wrapper payload the way the browser runtime does: derive the KEK
 * from the passphrase, unwrap the master key, then decrypt the page.
 *
 * The AAD comes from the payload's own version, site id, and page path, so a
 * payload written by an older format still verifies under the AAD it was
 * sealed with. Throws on any validation, authentication, or decoding
 * failure — a wrong passphrase, a tampered field, and a corrupt ciphertext
 * are all meaningful signals.
 *
 * @param {object} payload - The parsed veil-payload object from a wrapper
 * @param {string} passphrase
 * @returns {string} The decrypted page HTML
 */
function decryptPayload(payload, passphrase) {
  const errors = validatePayload(payload);
  if (errors.length > 0) {
    throw new Error(`invalid payload: ${errors.join('; ')}`);
  }
  return decryptPageWithMk(payload, unwrapMk(payload, passphrase));
}

/**
 * Derive the KEK from the passphrase and unwrap the site master key.
 *
 * Split out from decryptPayload because PBKDF2 is the entire cost of a
 * decryption: every page of one build shares this master key, so a caller
 * checking a whole site derives once and decrypts each page with the result.
 * Throws when the passphrase is wrong or the wrap metadata was tampered with;
 * the two are indistinguishable by design.
 */
function unwrapMk(payload, passphrase) {
  const kek = crypto.pbkdf2Sync(
    passphrase, Buffer.from(payload.salt, 'base64'), payload.iterations, 32, 'sha256'
  );
  // The wrapped key is a 32-byte key followed by its 16-byte auth tag.
  const wrapped = Buffer.from(payload.wrappedMk, 'base64');
  const unwrap = crypto.createDecipheriv('aes-256-gcm', kek, Buffer.from(payload.wrapIv, 'base64'));
  unwrap.setAAD(buildAad(payload.v, payload.siteId, 'wrap'));
  unwrap.setAuthTag(wrapped.subarray(32));
  return Buffer.concat([unwrap.update(wrapped.subarray(0, 32)), unwrap.final()]);
}

/** Decrypt one page with an already-unwrapped master key. */
function decryptPageWithMk(payload, mk) {
  const pageAad = buildAad(payload.v, payload.siteId, 'page', payload.path);
  const ct = Buffer.from(payload.ct, 'base64');
  const decipher = crypto.createDecipheriv('aes-256-gcm', mk, Buffer.from(payload.iv, 'base64'));
  decipher.setAAD(pageAad);
  decipher.setAuthTag(ct.subarray(ct.length - 16));
  const plaintext = Buffer.concat([decipher.update(ct.subarray(0, ct.length - 16)), decipher.final()]);
  return plaintext.toString('utf8');
}

// ---------------------------------------------------------------------------
// Wrapper template
// ---------------------------------------------------------------------------

/**
 * Generate a self-contained HTML wrapper page that decrypts and displays content.
 *
 * Only the current format is supported: the emitted runtime constructs
 * current-format AADs, so wrapping an older payload would produce a page
 * that can never unlock. Reading old payloads is a Node-API concern
 * (decryptPayload dispatches on payload.v); generating wrappers is not.
 *
 * @param {object} pageData - The encrypted payload and metadata
 * @returns {string} Complete HTML wrapper page
 */
function generateWrapper(pageData) {
  if (pageData.v !== FORMAT_VERSION) {
    throw new Error(
      `generateWrapper only supports format v${FORMAT_VERSION} payloads (got v${pageData.v}); ` +
      're-encrypt the source content instead of rewrapping an old payload'
    );
  }
  const jsonPayload = JSON.stringify(pageData);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline' 'self'; img-src 'self' data:; font-src 'self' data:; media-src 'self'; connect-src 'self'; form-action 'self'; base-uri 'self'">
<meta name="robots" content="noindex,nofollow,noarchive">
<title>Protected page</title>
<style>
/* Accent #c1432e is used as a mark: rules, focus, and active state. Error text
   uses the lighter #e2705c because #c1432e on #0e0e0d is 3.8:1, which carries a
   border but not a sentence the visitor has to read. Control boundaries use
   #6f6b61 (3.6:1) rather than the quieter #2a2926/#403e39 separator rules,
   which sit below the 3:1 an active control needs to be findable. */
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:ui-sans-serif,system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#0e0e0d;color:#e8e3d5;color-scheme:dark;min-height:100vh;display:flex;align-items:center;justify-content:center;padding:1.5rem;line-height:1.5}
.veil-prompt{max-width:23rem;width:100%}
.veil-prompt h1{font-size:1rem;font-weight:400;letter-spacing:.01em;padding-bottom:.9rem;border-bottom:1px solid #2a2926}
.veil-prompt input[type=password]{width:100%;margin-top:1.4rem;padding:.4rem 0;font-family:inherit;font-size:.95rem;background:none;border:none;border-bottom:1px solid #6f6b61;border-radius:0;color:#e8e3d5;outline:none;transition:border-color .12s}
.veil-prompt input[type=password]::placeholder{color:#8a857a}
.veil-prompt input[type=password]:focus{border-bottom-color:#c1432e}
.veil-prompt .veil-remember{display:flex;align-items:center;gap:.5rem;margin-top:1rem;font-size:.8rem;color:#8a857a;cursor:pointer;width:fit-content}
.veil-prompt .veil-remember input{cursor:pointer;accent-color:#c1432e}
.veil-prompt .veil-btn{margin-top:1.4rem;padding:.45rem 1.4rem;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:.78rem;letter-spacing:.1em;text-transform:uppercase;background:none;color:#e8e3d5;border:1px solid #6f6b61;border-radius:2px;cursor:pointer;transition:border-color .12s}
.veil-prompt .veil-btn:hover{border-color:#c1432e}
.veil-prompt .veil-btn:disabled{color:#8a857a;border-color:#2a2926;cursor:not-allowed}
.veil-prompt :focus-visible{outline:1px solid #c1432e;outline-offset:3px}
.veil-error{color:#e2705c;font-size:.8rem;margin-top:.9rem;min-height:1.2em}
.veil-hidden{display:none!important}
</style>
</head>
<body>
<div class="veil-prompt veil-hidden" id="veil-prompt">
<h1>This page is protected</h1>
<form id="veil-form" autocomplete="off">
<input type="password" id="veil-pass" placeholder="Passphrase" autofocus autocomplete="current-password">
<label class="veil-remember"><input type="checkbox" id="veil-rem"${pageData.remember ? ' checked' : ''}> Remember this device</label>
<button type="submit" class="veil-btn" id="veil-btn">Unlock</button>
</form>
<div class="veil-error" id="veil-error"></div>
</div>
<script id="veil-payload" type="application/json">${escapeJsonForScriptTag(jsonPayload)}</script>
<script>
(function(){
'use strict';
var D=document,W=window;
var S=(W.crypto&&W.crypto.subtle)||null;
var data=JSON.parse(D.getElementById('veil-payload').textContent);
var SK='veil:v'+data.v+':'+data.siteId+':mk';
var wrapAad=JSON.stringify(['veil',data.v,data.siteId,'wrap']);
var pageAad=JSON.stringify(['veil',data.v,data.siteId,'page',data.path]);

function b64(s){return Uint8Array.from(atob(s),function(c){return c.charCodeAt(0)})}
function toAb(u){return u.buffer.slice(u.byteOffset,u.byteOffset+u.byteLength)}

function showPrompt(){
D.getElementById('veil-prompt').classList.remove('veil-hidden');
try{D.getElementById('veil-pass').focus()}catch(e){}
}
function setError(msg){D.getElementById('veil-error').textContent=msg}

// Storage access can throw (disabled cookies, sandboxed frames); every
// touch is guarded so storage problems degrade to the prompt, never to a
// dead page.
function getStore(name){try{return W[name]}catch(e){return null}}
function sGet(store){if(!store)return null;try{return store.getItem(SK)}catch(e){return null}}
function sDel(store){if(!store)return;try{store.removeItem(SK)}catch(e){}}
function parseMk(s){
if(typeof s!=='string')return null;
try{
var u=Uint8Array.from(atob(s),function(c){return c.charCodeAt(0)});
if(u.length!==32)return null;
// atob is permissive (whitespace, missing padding); require the exact
// canonical encoding we store, so validation is strict.
if(btoa(String.fromCharCode.apply(null,u))!==s)return null;
return u;
}catch(e){return null}
}

function importMk(raw){
return S.importKey('raw',raw,{name:'AES-GCM'},false,['decrypt']);
}

function decryptPage(mkKey){
var ct=b64(data.ct),iv=b64(data.iv);
var aad=new TextEncoder().encode(pageAad);
return S.decrypt({name:'AES-GCM',iv:toAb(iv),additionalData:toAb(aad),tagLength:128},mkKey,toAb(ct));
}

function showPage(buf){
var html=new TextDecoder().decode(buf);
// A cached key can decrypt before the wrapper has finished parsing. While the
// parser is still active the insertion point is defined, so document.write
// appends at that point instead of replacing the document: the prompt markup
// and the payload survive, and the decrypted <title> lands in the body where
// it does nothing. Wait for the parser to finish before writing.
if(D.readyState==='loading'){
D.addEventListener('DOMContentLoaded',function(){writeDoc(html)});
return;
}
writeDoc(html);
}

function writeDoc(html){
D.open();D.write(html);D.close();
// Add lock button to decrypted page
var lock=D.createElement('button');
lock.className='veil-lock';lock.textContent='lock';
// The decrypted document supplies its own styles, so this control carries a
// solid background of its own rather than inheriting unknown contrast, and its
// focus ring is two-tone: whatever colour the page puts behind it, one of the
// two rings still has an edge that contrasts.
lock.title='Lock; clear the cached key';
lock.setAttribute('aria-label','Lock; clear the cached key');
lock.onclick=function(){doLogout()};
var s=D.createElement('style');
s.textContent='.veil-lock{position:fixed;top:10px;right:10px;padding:3px 8px;background:#0e0e0d;color:#e8e3d5;border:1px solid #6f6b61;border-radius:2px;font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:11px;line-height:1.4;letter-spacing:.08em;cursor:pointer;z-index:99999;transition:border-color .12s}.veil-lock:hover{border-color:#c1432e}.veil-lock:focus-visible{outline:2px solid #c1432e;outline-offset:0;box-shadow:0 0 0 4px #0e0e0d}';
var host=D.body||D.documentElement;
host.appendChild(s);host.appendChild(lock);
}

function cacheMk(raw,persist){
var b64mk=btoa(String.fromCharCode.apply(null,new Uint8Array(raw)));
var ss=getStore('sessionStorage'),ls=getStore('localStorage');
if(ss){try{ss.setItem(SK,b64mk)}catch(e){}}
if(persist&&ls){try{ls.setItem(SK,b64mk)}catch(e){}}
}

function clearAll(){
sDel(getStore('sessionStorage'));
sDel(getStore('localStorage'));
}

function doLogout(){
clearAll();
W.location.reload();
}

function deriveAndUnwrap(passphrase){
var salt=b64(data.salt);
var aad=new TextEncoder().encode(wrapAad);
return S.importKey('raw',new TextEncoder().encode(passphrase),'PBKDF2',false,['deriveKey'])
.then(function(baseKey){
return S.deriveKey(
{name:'PBKDF2',salt:toAb(salt),iterations:data.iterations,hash:'SHA-256'},
baseKey,{name:'AES-GCM',length:256},false,['decrypt']
);
})
.then(function(kek){
var wrapped=b64(data.wrappedMk);
var wrapIv=b64(data.wrapIv);
return S.decrypt({name:'AES-GCM',iv:toAb(wrapIv),additionalData:toAb(aad),tagLength:128},kek,toAb(wrapped));
});
}

// Explicit logout: clear cached keys, then navigate to the same page
// without the veil parameter (a plain reload would re-trigger this branch
// forever).
var params=null;
try{params=new URLSearchParams(W.location.search)}catch(e){}
if(params&&params.getAll('veil').indexOf('logout')!==-1){
clearAll();
params.delete('veil');
var q=params.toString();
W.location.replace(W.location.pathname+(q?'?'+q:'')+W.location.hash);
return;
}

// Web Crypto requires a secure context (HTTPS, localhost, or file).
if(!S){
showPrompt();
setError('Cannot decrypt: this page needs HTTPS (or localhost).');
D.getElementById('veil-btn').disabled=true;
return;
}

// Try cached keys: session tier first, then persistent. A tier that fails
// (malformed value or stale key from an older build) is cleared and the
// next tier tried — a bad session value must not destroy a valid
// remembered key.
function tryCached(tiers){
if(!tiers.length){showPrompt();return}
var t=tiers[0];
importMk(toAb(t.mk))
.then(function(k){return decryptPage(k)})
.then(function(buf){showPage(buf)})
.catch(function(){
sDel(t.store);
tryCached(tiers.slice(1));
});
}

var tiers=[];
['sessionStorage','localStorage'].forEach(function(name){
var store=getStore(name);
var raw=sGet(store);
var mk=parseMk(raw);
if(mk){tiers.push({mk:mk,store:store})}
else if(raw!==null){sDel(store)}
});
tryCached(tiers);

// Form handler
D.getElementById('veil-form').addEventListener('submit',function(e){
e.preventDefault();
var pass=D.getElementById('veil-pass').value;
var persist=D.getElementById('veil-rem').checked;
var btn=D.getElementById('veil-btn');
if(!pass){setError('Please enter a passphrase.');return}
btn.disabled=true;btn.textContent='Decrypting\\u2026';setError('');
deriveAndUnwrap(pass)
.catch(function(){throw 'veil-wrong-pass'})
.then(function(mkRaw){
return importMk(mkRaw)
.then(function(k){return decryptPage(k)})
.catch(function(){throw 'veil-corrupt-page'})
.then(function(buf){cacheMk(mkRaw,persist);showPage(buf)});
})
.catch(function(err){
if(err==='veil-corrupt-page'){
setError('Passphrase accepted, but this page failed to decrypt. The deployed file may be corrupt or from a different build.');
}else{
setError('Wrong passphrase. Please try again.');
}
btn.disabled=false;btn.textContent='Unlock';
D.getElementById('veil-pass').select();
});
});
})();
<\/script>
</body>
</html>`;
}

/** Escape HTML special characters. */
function escapeHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/** Make JSON safe to embed in a <script> tag without breaking JSON.parse(textContent). */
function escapeJsonForScriptTag(str) {
  return str
    .replace(/</g, '\\u003C')
    .replace(/>/g, '\\u003E')
    .replace(/&/g, '\\u0026')
    .replace(/\u2028/g, '\\u2028')
    .replace(/\u2029/g, '\\u2029');
}

/** The payload script emitted by generateWrapper; its body never contains '<'. */
const PAYLOAD_RE = /<script id="veil-payload" type="application\/json">([^<]+)<\/script>/;

/**
 * Read the metadata payload back out of a wrapper page.
 *
 * Returns null when the page carries no payload script or its contents are not
 * JSON — both mean "this is not a Veil wrapper", which callers must be able to
 * tell apart from a decryption failure, so neither case throws.
 *
 * @param {string} wrapperHtml - A generated wrapper page
 * @returns {object|null} The parsed payload, or null
 */
function extractPayload(wrapperHtml) {
  const match = PAYLOAD_RE.exec(wrapperHtml);
  if (!match) return null;
  try {
    return JSON.parse(match[1]);
  } catch {
    return null;
  }
}

const PAYLOAD_RE_G = new RegExp(PAYLOAD_RE.source, 'g');

/** Exactly how generateWrapper opens the payload script. */
const PAYLOAD_SCRIPT_OPEN = '<script id="veil-payload" type="application/json">';

/**
 * Classify a page the way an auditor needs to see it, which is finer than
 * extractPayload's null: a page with no payload at all is public content,
 * while a page that carries Veil's payload script but yields no readable
 * payload is a damaged wrapper. Reporting both as "not a wrapper" would let a
 * mangled protected page pass as an intentionally public one.
 *
 * Both tests run against the raw text, in this order, on purpose. A payload
 * script is found by the exact pattern Veil writes, so no amount of markup
 * added around it — a comment that a browser and a tokenizer disagree about,
 * say — can hide a payload that is still there. Only when no payload is
 * readable does the opening tag alone decide, and it is Veil's own spelling of
 * that tag, which cannot occur in prose about Veil because prose escapes `<`.
 *
 * What this deliberately does *not* attempt is to recognize a wrapper whose
 * payload script was renamed or restructured. Deciding whether such a page is
 * "really" a wrapper means reproducing a browser's HTML parsing exactly, and
 * losing that race fails open. The guarantee is placed elsewhere instead:
 * every page *in scope* must equal the wrapper Veil generates for its payload,
 * and each protected zone is audited by its own verify run — so a damaged
 * wrapper is caught by the run that owns it, not by a heuristic in another.
 *
 * @returns {{kind: 'absent'|'malformed'|'parsed', payload: object|null, reason: string|null}}
 */
function inspectPayload(wrapperHtml) {
  const absent = { kind: 'absent', payload: null, reason: null };
  const malformed = (reason) => ({ kind: 'malformed', payload: null, reason });
  const matches = [...wrapperHtml.matchAll(PAYLOAD_RE_G)];
  if (matches.length === 0) {
    return wrapperHtml.includes(PAYLOAD_SCRIPT_OPEN)
      ? malformed('opens a veil-payload script that has no readable contents')
      : absent;
  }
  // Two payload scripts mean the runtime and the auditor could read different
  // metadata: the wrapper's own template emits exactly one.
  if (matches.length > 1) {
    return malformed(`carries ${matches.length} veil-payload scripts`);
  }
  let payload;
  try {
    payload = JSON.parse(matches[0][1]);
  } catch {
    return malformed('payload script is not valid JSON');
  }
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return malformed('payload is not a JSON object');
  }
  return { kind: 'parsed', payload, reason: null };
}

// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------

/** Case-insensitive HTML file classification, used everywhere HTML is decided. */
function isHtmlFile(name) {
  return /\.html?$/i.test(name);
}

/** Case-insensitive JavaScript file classification (classic, ESM, CommonJS). */
function isJsFile(name) {
  return /\.(m|c)?js$/i.test(name);
}

/**
 * Reject anything that is not a regular file or directory. Symlinks and
 * special files are never walked: silently skipping them (the old behavior)
 * made files vanish from builds, and following them would need cycle handling
 * and escape checks. Rejecting is the simple, safe policy.
 */
function refuseIrregular(rel, kind) {
  if (kind === 'symbolic link') {
    throw new Error(
      `symbolic link in input directory: ${rel}\n` +
      'Veil does not follow symlinks. Replace it with a regular file or directory.'
    );
  }
  throw new Error(`unsupported file type in input directory: ${rel}`);
}

/**
 * Recursively collect all files under dir, returning paths relative to dir in
 * a deterministic order.
 *
 * `onIrregular(rel, kind)` decides what a symlink or special file means. The
 * default refuses the whole walk, which is right for a build; verify passes a
 * collector so one bad entry becomes a finding instead of ending the audit.
 */
function walkDir(dir, options = {}) {
  const onIrregular = options.onIrregular || refuseIrregular;
  const results = [];
  const walk = (current, relBase) => {
    const entries = fs.readdirSync(current, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.join(relBase, entry.name);
      if (entry.isSymbolicLink()) {
        onIrregular(rel, 'symbolic link');
      } else if (entry.isDirectory()) {
        walk(full, rel);
      } else if (entry.isFile()) {
        results.push(rel);
      } else {
        onIrregular(rel, 'unsupported file type');
      }
    }
  };
  walk(dir, '');
  return results;
}

/** Ensure a directory exists, creating parent directories as needed. */
function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true });
}

/** Copy a file, creating destination directories as needed. */
function copyFile(src, dest) {
  ensureDir(path.dirname(dest));
  fs.copyFileSync(src, dest);
}

/**
 * Canonicalize a path that may not exist yet: realpath of the nearest
 * existing ancestor joined with the unresolved remainder.
 */
function canonicalizePath(p) {
  let existing = path.resolve(p);
  const suffix = [];
  while (!fs.existsSync(existing)) {
    const parent = path.dirname(existing);
    if (parent === existing) break;
    suffix.unshift(path.basename(existing));
    existing = parent;
  }
  return path.join(fs.realpathSync(existing), ...suffix);
}

/**
 * Refuse input/output layouts where writing the output could touch the input.
 * Compares canonical (symlink-resolved) paths in both directions, so an
 * output path that is an alias for the input — or contains it, or lives
 * inside it — is rejected rather than silently overwriting source files.
 */
function assertSeparateTrees(inputDir, outputDir) {
  let outLstat = null;
  try { outLstat = fs.lstatSync(outputDir); } catch {}
  if (outLstat && outLstat.isSymbolicLink()) {
    fatal(`output directory must not be a symbolic link: ${outputDir}`);
  }
  if (outLstat && !outLstat.isDirectory()) {
    fatal(`output path exists and is not a directory: ${outputDir}`);
  }
  const contains = (rel) =>
    rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
  // Check both lexical and canonical (symlink-resolved) forms. Canonical
  // comparison catches aliases; the lexical check additionally protects the
  // path the input was supplied through — e.g. an input reached via a symlink
  // that lives inside the output directory would survive canonical
  // comparison, and --force replacement would then delete it.
  const pairs = [
    [path.resolve(inputDir), path.resolve(outputDir)],
    [fs.realpathSync(inputDir), canonicalizePath(outputDir)],
  ];
  for (const [a, b] of pairs) {
    if (contains(path.relative(a, b)) || contains(path.relative(b, a))) {
      fatal('Output directory cannot be the same as, inside, or contain the input directory');
    }
  }
}

/**
 * Move a fully built staging directory into place as the output directory.
 *
 * - destination absent: plain rename (the genuinely atomic case)
 * - destination empty: remove it, then rename
 * - destination non-empty: refuse unless force, then replace via
 *   backup-rename with rollback. This is crash-recoverable, not atomic:
 *   a reader can briefly observe a missing output during the swap.
 *
 * Throws (never exits) so the caller retains staging-cleanup ownership.
 */
function publishOutput(stagingDir, outputDir, force) {
  let st = null;
  try { st = fs.statSync(outputDir); } catch {}

  if (st && !st.isDirectory()) {
    throw new Error(`output path exists and is not a directory: ${outputDir}`);
  }
  if (!st) {
    fs.renameSync(stagingDir, outputDir);
    return;
  }
  if (fs.readdirSync(outputDir).length === 0) {
    fs.rmdirSync(outputDir);
    fs.renameSync(stagingDir, outputDir);
    return;
  }
  if (!force) {
    throw new Error(
      `output directory is not empty: ${outputDir}\n` +
      'Veil replaces the whole output directory so stale files from earlier\n' +
      'builds can never be deployed. Re-run with --force to replace it.'
    );
  }
  const backupDir = `${outputDir}.veil-old-${process.pid}-${Date.now()}`;
  fs.renameSync(outputDir, backupDir);
  try {
    fs.renameSync(stagingDir, outputDir);
  } catch (err) {
    fs.renameSync(backupDir, outputDir); // roll the old output back
    throw err;
  }
  try {
    fs.rmSync(backupDir, { recursive: true, force: true });
  } catch {
    console.warn(`veil: warning: could not remove backup directory: ${backupDir}`);
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

function printVerifyHelp() {
  const usage = `
Usage: veil verify <output-dir> [options]

Audit a built output directory: every HTML file in the audited scope must be a
valid, current-format Veil wrapper sealed for the path it sits at.

Options:
  --html-root <dir>     Audit only this output-relative dir (repeatable)
  --input <dir>         Compare against the input directory this build was made from
  --id <site-id>        Require this exact site id
  --passphrase <pass>   Verify decryption with this passphrase
  --passphrase-env <n>  Verify decryption with the passphrase in env variable <n>
  --prompt-passphrase   Verify decryption with a passphrase typed at the terminal
  --json                Emit the report as JSON
  --help                Show this help

Without --html-root every HTML file in the output must be encrypted; with it,
HTML outside those roots is reported as public rather than treated as a failure.
Decryption is only checked when a passphrase is supplied.

Exit codes:
  0   the audit ran and found no errors
  1   the audit ran and found errors
  2   the audit could not be performed
`.trim();
  console.log(usage);
}

/** Report every path in posix form, so a report reads the same on any platform. */
function toPosix(rel) {
  return rel.split(path.sep).join('/');
}

/** Deterministic string order, independent of locale. */
function compareStrings(a, b) {
  return a < b ? -1 : a > b ? 1 : 0;
}

// Payload metadata written once per build and shared by every page of it.
const SHARED_PAYLOAD_FIELDS = ['v', 'siteId', 'salt', 'iterations', 'wrappedMk', 'wrapIv', 'remember'];

// The subset that actually determines the master key and the AAD it is sealed
// under. Grouping pages for IV uniqueness and for the decryption pass uses
// this, not the whole shared tuple: `remember` is a UI default, so a build
// that disagrees about it is inconsistent but still one key's worth of pages.
const KEY_MATERIAL_FIELDS = ['v', 'siteId', 'salt', 'iterations', 'wrappedMk', 'wrapIv'];

// Findings produced only by the correspondence stage, used to report its
// status. `irregular_file` and `unreadable_file` belong here too, but only
// when they arose from the input tree or from a comparison — the same codes
// occur while reading output HTML, which says nothing about correspondence —
// so those are flagged where they are raised rather than matched by code.
const CORRESPONDENCE_CODES = new Set([
  'missing_output', 'missing_asset', 'orphan', 'passthrough_modified',
]);

function parseVerifyArgs(args) {
  const opts = {
    outputDir: null,
    inputDir: null,
    htmlRoots: [],
    siteId: null,
    passphrase: null,
    passphraseEnv: null,
    promptPassphrase: false,
    json: false,
  };
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--help' || arg === '-h') {
      printVerifyHelp();
      process.exit(0);
    } else if (arg === '--input') {
      opts.inputDir = path.resolve(takeValue(args, ++i, '--input'));
    } else if (arg === '--html-root') {
      opts.htmlRoots.push(normalizeHtmlRoot(takeValue(args, ++i, '--html-root')));
    } else if (arg === '--id') {
      opts.siteId = takeValue(args, ++i, '--id');
      if (opts.siteId === '') throw new Error('--id must not be empty');
    } else if (arg === '--passphrase') {
      opts.passphrase = takeValue(args, ++i, '--passphrase');
    } else if (arg === '--passphrase-env') {
      opts.passphraseEnv = takeValue(args, ++i, '--passphrase-env');
    } else if (arg === '--prompt-passphrase') {
      opts.promptPassphrase = true;
    } else if (arg === '--json') {
      opts.json = true;
    } else if (arg.startsWith('-')) {
      throw new Error(`Unknown option: ${arg}`);
    } else {
      positional.push(arg);
    }
  }

  if (positional.length === 0) {
    throw new Error('verify requires an output directory\nUsage: veil verify <output-dir> [options]');
  }
  if (positional.length > 1) {
    throw new Error(`Unexpected argument: ${positional[1]}`);
  }
  opts.outputDir = path.resolve(positional[0]);
  return opts;
}

/**
 * Resolve the passphrase for the decryption stage, or null to skip it.
 *
 * Exactly one source, and never an implicit one: a missing passphrase means
 * "skip decryption", so it must not also mean "prompt", or an automated run
 * with no passphrase would block on a terminal that is not there.
 */
async function resolveVerifyPassphrase(opts) {
  const given = [opts.passphrase !== null, opts.passphraseEnv !== null, opts.promptPassphrase];
  if (given.filter(Boolean).length > 1) {
    throw new Error('Use only one of --passphrase, --passphrase-env, or --prompt-passphrase');
  }
  if (opts.passphrase !== null) {
    if (opts.passphrase === '') throw new Error('Passphrase cannot be empty');
    warn('--passphrase is visible in process listings and shell history — prefer --passphrase-env or --prompt-passphrase');
    return opts.passphrase;
  }
  if (opts.passphraseEnv !== null) {
    const value = process.env[opts.passphraseEnv] || '';
    if (!value) throw new Error(`Environment variable ${opts.passphraseEnv} is empty or not set`);
    return value;
  }
  if (opts.promptPassphrase) {
    if (!process.stdin.isTTY) {
      throw new Error('--prompt-passphrase needs a terminal; use --passphrase-env in scripts');
    }
    const value = await promptVerificationPassphrase();
    if (!value) throw new Error('Passphrase cannot be empty');
    return value;
  }
  return null;
}

/**
 * Audit an output directory and return a structured report.
 *
 * Inside the scope named by --html-root, every HTML file must be a canonical
 * wrapper — parseable, valid, current-format, sealed for the path it sits at,
 * and byte-identical to what generateWrapper produces for its payload — and
 * the scope as a whole must agree on its site id, shared metadata, and IV
 * uniqueness, and must decrypt when a passphrase is supplied. Anything short
 * of that is an error.
 *
 * Outside that scope only one thing is decidable: a page whose bytes equal
 * generateWrapper(payload) is certainly a wrapper, and is checked as one.
 * Every other payload-looking page is warned about and listed as public,
 * because a damaged wrapper and a public page quoting wrapper markup in a
 * script, comment, or code sample are the same bytes to anything short of a
 * real HTML parser. A chained artifact is therefore audited once per zone:
 * each run is what turns that warning into an error for its own pages.
 *
 * Throws only when the audit cannot be performed at all; everything it can
 * assess becomes a finding.
 */
function verifyCommand(opts, passphrase) {
  const findings = [];
  const add = (severity, code, message, file = null) => {
    findings.push({ severity, code, path: file, message });
  };
  // Set by anything that leaves the input/output comparison incomplete, so the
  // stage can never report "passed" over a tree it could not fully read.
  let correspondenceIncomplete = false;

  const requireDir = (dir, tree) => {
    let st;
    try {
      st = fs.statSync(dir);
    } catch {
      throw new Error(`${tree} directory does not exist: ${dir}`);
    }
    if (!st.isDirectory()) {
      throw new Error(`${tree} path is not a directory: ${dir}`);
    }
  };

  requireDir(opts.outputDir, 'output');
  if (opts.inputDir !== null) {
    requireDir(opts.inputDir, 'input');
    // Comparing a build against itself makes every correspondence check
    // vacuously pass, which is worse than not running them: the report would
    // claim the stage passed. Veil can never build one tree from the other,
    // so any overlap is a mistyped path, not a layout to support.
    const realOut = fs.realpathSync(opts.outputDir);
    const realIn = fs.realpathSync(opts.inputDir);
    const contains = (a, b) => {
      const rel = path.relative(a, b);
      return rel === '' || (rel !== '..' && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel));
    };
    if (contains(realIn, realOut) || contains(realOut, realIn)) {
      throw new Error(
        '--input must name a separate tree from the output directory\n' +
        'Comparing a build against itself proves nothing about it.'
      );
    }
  }

  const readTree = (dir, tree) => {
    return walkDir(dir, {
      onIrregular: (rel, kind) => {
        // An entry the walk had to skip is a hole in the file set being
        // compared, whichever tree it was in: a skipped output entry never
        // reaches the orphan check, a skipped input entry never reaches the
        // missing-file check.
        correspondenceIncomplete = true;
        add(
          'error', 'irregular_file',
          `is a ${kind} in the ${tree} tree — Veil never emits one, and its contents are not audited`,
          toPosix(rel)
        );
      },
    });
  };

  const outputFiles = readTree(opts.outputDir, 'output');
  const inputFiles = opts.inputDir === null ? null : readTree(opts.inputDir, 'input');
  const inScope = (rel) => shouldEncryptHtml(rel, opts.htmlRoots);

  // -- Wrapper hygiene, and the cohort it yields ---------------------------

  const outputHtml = outputFiles.filter(isHtmlFile);
  const publicHtml = [];   // HTML reported as public: { path, allowed }
  const cohort = [];       // in-scope, current-format wrappers: { rel, path, payload }
  let outOfScopeWrappers = 0;

  for (const rel of outputHtml) {
    const posix = toPosix(rel);
    const scoped = inScope(rel);
    let html;
    try {
      html = fs.readFileSync(path.join(opts.outputDir, rel), 'utf8');
    } catch (err) {
      add('error', 'unreadable_file', `could not be read: ${err.message}`, posix);
      continue;
    }

    // Anything payload-shaped that is not a canonical wrapper — unreadable,
    // invalid, the wrong format version, or simply not byte-identical — is
    // only decidable inside the audited scope. Outside it, the same bytes are
    // equally a damaged wrapper or ordinary public HTML quoting wrapper markup
    // in a script, a comment, or a code sample; telling those apart needs a
    // real HTML parser, and guessing would fail a legitimate public page. So
    // out of scope it is reported, not failed: the run that owns it decides.
    const undecidable = (code, message) => {
      if (scoped) {
        add('error', code, message, posix);
        return;
      }
      add(
        'warning', code,
        `${message} — outside the audited roots this may equally be public HTML quoting wrapper markup; verify the zone that owns it`,
        posix
      );
      publicHtml.push({ path: posix, allowed: true });
    };

    const found = inspectPayload(html);
    if (found.kind === 'absent') {
      publicHtml.push({ path: posix, allowed: !scoped });
      if (scoped) {
        add('error', 'html_not_encrypted', 'carries no Veil payload — it is published as plaintext', posix);
      }
      continue;
    }
    if (found.kind === 'malformed') {
      undecidable('payload_malformed', found.reason);
      continue;
    }

    const payload = found.payload;
    const schemaErrors = validatePayload(payload);
    if (schemaErrors.length > 0) {
      undecidable('payload_invalid', `has an invalid payload: ${schemaErrors.join('; ')}`);
      continue;
    }
    if (payload.v !== FORMAT_VERSION) {
      undecidable(
        'payload_version_unsupported',
        payload.v < FORMAT_VERSION
          ? `is format v${payload.v}; this Veil writes v${FORMAT_VERSION} and cannot certify an older wrapper — re-encrypt the source`
          : `is format v${payload.v}; this Veil only understands v${FORMAT_VERSION} — upgrade veil.js to audit it`
      );
      continue;
    }
    // The wrapper is a security boundary in its own right: its CSP, its
    // storage handling, and its runtime all live in the shell around the
    // payload. Regenerating it from the payload it carries is the cheapest
    // complete check that none of that was touched — and equality is also the
    // only proof that a page *is* a wrapper, since a schema-valid payload can
    // be quoted verbatim by a public page inside a textarea or a comment,
    // where a browser creates no payload element at all.
    const canonical = html === generateWrapper(payload);
    if (!canonical) {
      undecidable(
        'wrapper_modified',
        'does not match the wrapper Veil generates for its own payload — it was edited, minified, or tampered with after the build'
      );
    }
    // A canonical wrapper is unambiguous wherever it sits, so a path it was
    // not sealed for is an error even out of scope.
    if (payload.path !== posix && (scoped || canonical)) {
      add(
        'error', 'payload_path_mismatch',
        `is sealed for "${payload.path}" — the wrapper was moved or renamed after the build`,
        posix
      );
    }

    if (scoped) cohort.push({ rel, path: posix, payload });
    else if (canonical) outOfScopeWrappers++;
  }

  if (outputHtml.filter(inScope).length === 0) {
    add(
      'error', 'no_encrypted_pages',
      opts.htmlRoots.length > 0
        ? `no HTML files under ${opts.htmlRoots.map(toPosix).join(', ')} — nothing was verified`
        : 'no HTML files in the output directory — nothing was verified'
    );
  }

  // -- Cohort checks --------------------------------------------------------

  if (opts.siteId !== null) {
    const wrong = new Map();
    for (const page of cohort) {
      if (page.payload.siteId === opts.siteId) continue;
      if (!wrong.has(page.payload.siteId)) wrong.set(page.payload.siteId, []);
      wrong.get(page.payload.siteId).push(page.path);
    }
    for (const [id, paths] of wrong) {
      add(
        'error', 'site_id_mismatch',
        `carries site id "${id}", not the expected "${opts.siteId}" (${paths.length} page(s) in scope)`,
        paths[0]
      );
    }
  }

  if (cohort.length > 1) {
    const ref = cohort[0];
    for (const page of cohort.slice(1)) {
      for (const field of SHARED_PAYLOAD_FIELDS) {
        if (page.payload[field] !== ref.payload[field]) {
          add(
            'error', 'site_inconsistent',
            `has a different ${field} than ${ref.path} — these pages came from different builds`,
            page.path
          );
        }
      }
    }
  }

  // IV uniqueness only means anything among pages sealed with the same master
  // key, so pages are grouped by their whole shared tuple first: an
  // inconsistent build would otherwise report a false key-reuse catastrophe.
  const keyGroups = new Map();
  for (const page of cohort) {
    const key = JSON.stringify(KEY_MATERIAL_FIELDS.map((f) => page.payload[f]));
    if (!keyGroups.has(key)) keyGroups.set(key, new Map());
    const seenIvs = keyGroups.get(key);
    if (seenIvs.has(page.payload.iv)) {
      add(
        'error', 'iv_reuse',
        `reuses the IV of ${seenIvs.get(page.payload.iv)} under the same master key — AES-GCM leaks both plaintexts`,
        page.path
      );
    } else {
      seenIvs.set(page.payload.iv, page.path);
    }
  }

  const weak = cohort.filter((p) => p.payload.iterations < DEFAULT_ITERATIONS);
  if (weak.length > 0) {
    add(
      'warning', 'iterations_below_default',
      `${weak[0].payload.iterations} PBKDF2 iterations is below the default ${DEFAULT_ITERATIONS} — weaker against offline guessing (${weak.length} page(s))`
    );
  }

  // -- Correspondence with the input tree ----------------------------------

  if (inputFiles !== null) {
    const inputSet = new Set(inputFiles);
    const outputSet = new Set(outputFiles);
    // Only in-scope HTML is generated by this build; everything else that
    // reaches the output — assets, public HTML, and wrappers from an earlier
    // zone of a chained build — is passed through and must survive intact.
    const generated = new Set(inputFiles.filter((rel) => isHtmlFile(rel) && inScope(rel)));

    for (const rel of inputFiles) {
      const posix = toPosix(rel);
      if (!outputSet.has(rel)) {
        if (isHtmlFile(rel)) {
          add('error', 'missing_output', 'is in the input tree but absent from the output', posix);
        } else {
          add(
            'warning', 'missing_asset',
            'is in the input tree but absent from the output — expected when its contents were inlined into encrypted pages',
            posix
          );
        }
        continue;
      }
      if (generated.has(rel)) continue;
      let identical;
      try {
        const src = path.join(opts.inputDir, rel);
        const dest = path.join(opts.outputDir, rel);
        identical = fs.statSync(src).size === fs.statSync(dest).size &&
          fs.readFileSync(src).equals(fs.readFileSync(dest));
      } catch (err) {
        correspondenceIncomplete = true;
        add('error', 'unreadable_file', `could not be compared: ${err.message}`, posix);
        continue;
      }
      if (!identical) {
        add('error', 'passthrough_modified', 'differs from the input file it was copied from', posix);
      }
    }

    for (const rel of outputFiles) {
      if (!inputSet.has(rel)) {
        add('error', 'orphan', 'is in the output but not in the input tree — a stale file from an earlier build', toPosix(rel));
      }
    }
  }

  // Each root is checked on its own: the union matching something would let a
  // second, mistyped root pass unnoticed.
  const rootTree = inputFiles === null ? outputFiles : inputFiles;
  const rootTreeName = inputFiles === null ? 'output' : 'input';
  for (const root of opts.htmlRoots) {
    if (!rootTree.some((rel) => isHtmlFile(rel) && shouldEncryptHtml(rel, [root]))) {
      add(
        'error', 'html_root_unmatched',
        `--html-root ${toPosix(root)} matches no HTML file in the ${rootTreeName} tree`
      );
    }
  }

  // -- Decryption -----------------------------------------------------------

  let decryption = { status: 'skipped', reason: 'no passphrase supplied' };
  if (passphrase !== null) {
    const keyMaterial = new Set(keyGroups.keys());
    if (cohort.length === 0) {
      decryption = { status: 'skipped', reason: 'no verifiable encrypted pages in scope' };
    } else if (keyMaterial.size > 1) {
      decryption = { status: 'skipped', reason: 'pages in scope do not share one set of key material' };
    } else {
      let mk = null;
      try {
        mk = unwrapMk(cohort[0].payload, passphrase);
      } catch {
        add(
          'error', 'mk_unwrap_failed',
          'the master key did not unwrap — the passphrase is wrong, or the key metadata was tampered with'
        );
      }
      if (mk === null) {
        decryption = { status: 'failed', reason: null };
      } else {
        let failed = 0;
        for (const page of cohort) {
          try {
            decryptPageWithMk(page.payload, mk);
          } catch {
            failed++;
            add(
              'error', 'page_decrypt_failed',
              'did not decrypt under the site master key — its ciphertext, IV, or sealed metadata was altered',
              page.path
            );
          }
        }
        decryption = { status: failed > 0 ? 'failed' : 'passed', reason: null };
      }
    }
  }

  // -- Report ---------------------------------------------------------------

  const severityRank = { error: 0, warning: 1 };
  findings.sort((a, b) =>
    severityRank[a.severity] - severityRank[b.severity] ||
    compareStrings(a.path || '', b.path || '') ||
    compareStrings(a.code, b.code) ||
    compareStrings(a.message, b.message)
  );
  publicHtml.sort((a, b) => compareStrings(a.path, b.path));

  const errors = findings.filter((f) => f.severity === 'error').length;
  const warnings = findings.length - errors;
  const correspondenceFailed = correspondenceIncomplete || findings.some(
    (f) => f.severity === 'error' && CORRESPONDENCE_CODES.has(f.code)
  );

  return {
    reportVersion: 1,
    ok: errors === 0,
    outputDir: opts.outputDir,
    inputDir: opts.inputDir,
    scope: { htmlRoots: opts.htmlRoots.map(toPosix), siteId: opts.siteId },
    stats: {
      files: outputFiles.length,
      encryptedHtml: cohort.length,
      publicHtml: publicHtml.filter((p) => p.allowed).length,
      outOfScopeWrappers,
    },
    publicHtml,
    checks: {
      correspondence: inputFiles === null
        ? { status: 'skipped', reason: 'no --input directory supplied' }
        : { status: correspondenceFailed ? 'failed' : 'passed', reason: null },
      decryption,
    },
    findings,
    counts: { errors, warnings },
  };
}

/** Render a report for a human reader. */
function formatVerifyReport(report) {
  const lines = [`veil verify: ${report.outputDir}`];
  const roots = report.scope.htmlRoots.length > 0 ? report.scope.htmlRoots.join(', ') : 'whole output';
  lines.push(`  scope: ${roots}${report.scope.siteId === null ? '' : ` (site id: ${report.scope.siteId})`}`);
  if (report.inputDir !== null) lines.push(`  input: ${report.inputDir}`);

  const s = report.stats;
  lines.push('');
  lines.push(
    `${s.files} file(s), ${s.encryptedHtml} encrypted page(s) in scope, ` +
    `${s.publicHtml} public HTML file(s), ${s.outOfScopeWrappers} wrapper(s) outside scope`
  );

  const allowedPublic = report.publicHtml.filter((p) => p.allowed);
  if (allowedPublic.length > 0) {
    lines.push('');
    lines.push('Public HTML (outside the audited roots — served as plaintext):');
    for (const p of allowedPublic) lines.push(`  ${p.path}`);
  }

  for (const severity of ['error', 'warning']) {
    const group = report.findings.filter((f) => f.severity === severity);
    if (group.length === 0) continue;
    lines.push('');
    lines.push(`${severity === 'error' ? 'Errors' : 'Warnings'}:`);
    for (const f of group) {
      lines.push(`  [${f.code}] ${f.path === null ? f.message : `${f.path} ${f.message}`}`);
    }
  }

  lines.push('');
  for (const [name, check] of Object.entries(report.checks)) {
    lines.push(`${name}: ${check.status}${check.reason === null ? '' : ` (${check.reason})`}`);
  }

  const { errors, warnings } = report.counts;
  lines.push('');
  lines.push(
    report.ok
      ? `PASS${warnings > 0 ? ` (${warnings} warning(s))` : ''}`
      : `FAIL (${errors} error(s)${warnings > 0 ? `, ${warnings} warning(s)` : ''})`
  );
  return lines.join('\n');
}

/**
 * Run the verify subcommand. Returns the process exit code rather than
 * exiting, so stdout is never truncated mid-report: 0 clean, 1 errors found,
 * 2 the audit could not be performed at all.
 */
async function runVerify(args) {
  try {
    const opts = parseVerifyArgs(args);
    const passphrase = await resolveVerifyPassphrase(opts);
    const report = verifyCommand(opts, passphrase);
    console.log(opts.json ? JSON.stringify(report, null, 2) : formatVerifyReport(report));
    return report.counts.errors > 0 ? 1 : 0;
  } catch (err) {
    console.error(`veil: ${err && err.message ? err.message : String(err)}`);
    return 2;
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  // The verify subcommand is dispatched before the encrypt parser so that
  // parser keeps its two-positional shape. An input directory actually named
  // "verify" is still addressable as ./verify.
  if (process.argv[2] === 'verify') {
    process.exitCode = await runVerify(process.argv.slice(3));
    return;
  }

  const opts = parseArgs(process.argv);

  emitStartupWarnings(opts);

  // -- Validate everything before touching the filesystem ------------------

  if (!fs.existsSync(opts.inputDir)) {
    fatal(`Input directory does not exist: ${opts.inputDir}`);
  }
  if (!fs.statSync(opts.inputDir).isDirectory()) {
    fatal(`Not a directory: ${opts.inputDir}`);
  }

  assertSeparateTrees(opts.inputDir, opts.outputDir);

  // Refuse a non-empty destination up front (publishOutput re-checks in case
  // of races) so no work happens on a build that cannot be published.
  if (
    !opts.force &&
    fs.existsSync(opts.outputDir) &&
    fs.statSync(opts.outputDir).isDirectory() &&
    fs.readdirSync(opts.outputDir).length > 0
  ) {
    fatal(
      `output directory is not empty: ${opts.outputDir}\n` +
      'Veil replaces the whole output directory so stale files from earlier\n' +
      'builds can never be deployed. Re-run with --force to replace it.'
    );
  }

  if (opts.iterations < MIN_ITERATIONS) {
    fatal(`Iterations must be at least ${MIN_ITERATIONS} (got ${opts.iterations})`);
  }

  // null means the flag was never given; '' means it was given empty, which is
  // a mistake rather than a request to prompt.
  if (opts.passphrase !== null && opts.passphraseEnv) {
    fatal('Use only one of --passphrase or --passphrase-env');
  }

  if (opts.passphrase === '') {
    fatal('Passphrase cannot be empty');
  }

  if (opts.passphrase === null && opts.passphraseEnv) {
    opts.passphrase = process.env[opts.passphraseEnv] || '';
    if (!opts.passphrase) {
      fatal(`Environment variable ${opts.passphraseEnv} is empty or not set`);
    }
  }

  if (opts.passphrase === null) {
    opts.passphrase = await promptPassphrase();
    if (!opts.passphrase) {
      fatal('Passphrase cannot be empty');
    }
  }

  // Discover files
  const files = walkDir(opts.inputDir);
  const allHtmlFiles = files.filter(isHtmlFile);
  const htmlFiles = allHtmlFiles.filter((f) => shouldEncryptHtml(f, opts.htmlRoots));
  const htmlFileSet = new Set(htmlFiles);
  const passthroughFiles = files.filter((f) => !htmlFileSet.has(f));

  if (allHtmlFiles.length === 0) {
    fatal('No HTML files found in input directory');
  }
  if (htmlFiles.length === 0) {
    fatal(`No HTML files matched --html-root (${opts.htmlRoots.join(', ')})`);
  }

  // Generate site-wide cryptographic material (also before any writes)
  const siteKeys = generateSiteKeys(opts.passphrase, opts.iterations, opts.siteId);
  const payloadMeta = buildPayloadMeta(siteKeys, opts.siteId, opts.remember);

  // -- Build into a staging directory, publish only on success -------------

  const publicHtmlFiles = passthroughFiles.filter(isHtmlFile);

  ensureDir(path.dirname(opts.outputDir));
  const stagingDir = fs.mkdtempSync(`${opts.outputDir}.veil-tmp-`);

  let published = false;
  try {
    // mkdtemp creates 0700; published output should have a normal
    // umask-derived directory mode so other users (e.g. a web server) can
    // traverse it.
    fs.chmodSync(stagingDir, 0o777 & ~process.umask());

    // Process HTML files first: inline assets, encrypt, generate wrapper.
    // The inline report decides below which assets need copying at all.
    const inlinedAssets = new Set();
    const inlinedScripts = new Set();
    const keptAssets = new Set();
    const inlineWarnings = [];

    for (const file of htmlFiles) {
      const src = path.join(opts.inputDir, file);
      let html = readUtf8(src, file);

      if (opts.inline) {
        const res = inlineAssets(html, file, opts.inputDir);
        html = res.html;
        for (const p of res.inlined) inlinedAssets.add(p);
        for (const p of res.inlinedScripts) inlinedScripts.add(p);
        for (const p of res.kept) keptAssets.add(p);
        // Anything the transformed page still points at — preload/icon links,
        // module or unreadable scripts — is fetched at runtime by the
        // decrypted page and must stay in the public output.
        for (const p of collectLocalRefs(html, file, opts.inputDir)) keptAssets.add(p);
        inlineWarnings.push(...res.warnings);
      } else {
        inlineWarnings.push(...scanBlockedScripts(html, file));
      }

      // Encrypt the page, binding it to its output-relative posix path
      const pagePath = file.split(path.sep).join('/');
      const { ciphertext, iv } = encryptPage(html, siteKeys.mk, opts.siteId, pagePath);

      const pageData = {
        ...payloadMeta,
        path: pagePath,
        ct: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
      };

      // Generate self-contained wrapper HTML
      const wrapper = generateWrapper(pageData);
      const dest = path.join(stagingDir, file);
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, wrapper);
    }

    const seenWarnings = new Set();
    for (const w of inlineWarnings) {
      const key = `${w.page}|${w.url}|${w.reason}`;
      if (seenWarnings.has(key)) continue;
      seenWarnings.add(key);
      console.warn(`veil: warning: ${w.page}: ${w.url}: ${w.reason}`);
    }

    // An asset whose contents were inlined into encrypted pages is only
    // omitted from the public output when nothing left can reach it: no
    // public HTML tag, no public stylesheet or inline <style>, and no
    // reference that survived inlining on a protected page. Anything
    // uncertain is copied.
    const realOf = (file) => {
      try {
        return fs.realpathSync(path.join(opts.inputDir, file));
      } catch {
        return null;
      }
    };
    const omit = new Set();
    if (opts.inline && inlinedAssets.size > 0) {
      const publicRefs = new Set();
      for (const file of publicHtmlFiles) {
        const html = fs.readFileSync(path.join(opts.inputDir, file), 'utf8');
        const htmlDir = path.dirname(path.join(opts.inputDir, file));
        for (const p of collectLocalRefs(html, file, opts.inputDir)) publicRefs.add(p);
        html.replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, (m, body) => {
          for (const p of collectCssRefs(body, htmlDir, opts.inputDir)) publicRefs.add(p);
          return m;
        });
      }
      // Every passthrough stylesheet is scanned, not just the ones a public
      // page links: that covers css → css → css import chains without
      // recursing, since each file in the chain is scanned on its own.
      for (const file of passthroughFiles) {
        if (!/\.css$/i.test(file)) continue;
        let css;
        try {
          css = fs.readFileSync(path.join(opts.inputDir, file), 'utf8');
        } catch {
          continue;
        }
        const cssDir = path.dirname(path.join(opts.inputDir, file));
        for (const p of collectCssRefs(css, cssDir, opts.inputDir)) publicRefs.add(p);
      }
      // Public JS can import anything, and a public page can load it from an
      // inline event handler no scanner sees — so an inlined JS file is only
      // omitted when the whole site is encrypted (no public HTML at all) and
      // no JavaScript survives publicly. CSS needs no such rule; the scans
      // above follow every reference a stylesheet can make.
      const unreachable = (real) =>
        !!real && inlinedAssets.has(real) && !keptAssets.has(real) && !publicRefs.has(real);
      // A file is JavaScript when a protected page consumed it as a script —
      // an extensionless handler still is — or when its name says so, which
      // also catches passthrough JS that no page inlined.
      const isJs = (real, name) => (!!real && inlinedScripts.has(real)) || isJsFile(name);
      const keepInlinedJs =
        publicHtmlFiles.length > 0 ||
        passthroughFiles.some((f) => {
          const real = realOf(f);
          return isJs(real, f) && !unreachable(real);
        });
      for (const p of inlinedAssets) {
        if (!unreachable(p)) continue;
        if (keepInlinedJs && isJs(p, p)) continue;
        omit.add(p);
      }
    }

    const toCopy = [];
    let omittedCount = 0;
    for (const file of passthroughFiles) {
      const real = realOf(file);
      if (real && omit.has(real)) {
        omittedCount++;
        continue;
      }
      toCopy.push(file);
    }

    const copyOther = toCopy.filter((f) => !isHtmlFile(f));
    const copyHtml = toCopy.filter(isHtmlFile);
    if (omittedCount > 0) {
      console.log(`veil: omitting ${omittedCount} asset(s) that were inlined into encrypted pages and are not referenced by public files`);
    }
    if (copyOther.length > 0) {
      console.warn(`veil: copying ${copyOther.length} non-HTML file(s) unencrypted — these remain public`);
    }
    if (copyHtml.length > 0) {
      console.warn(`veil: leaving ${copyHtml.length} HTML file(s) public outside the encrypted roots`);
    }

    for (const file of toCopy) {
      copyFile(
        path.join(opts.inputDir, file),
        path.join(stagingDir, file)
      );
    }

    publishOutput(stagingDir, opts.outputDir, opts.force);
    published = true;
  } finally {
    if (!published) {
      fs.rmSync(stagingDir, { recursive: true, force: true });
    }
  }

  console.log(
    `veil: encrypted ${htmlFiles.length} HTML file(s) → ${opts.outputDir}`
  );
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

// The pure, crypto, and payload surface — everything that can be exercised
// without a filesystem build. Nothing exported here calls fatal() or exits:
// library callers get thrown errors, so only the CLI decides to terminate.
module.exports = {
  FORMAT_VERSION,
  MIN_ITERATIONS,
  buildAad,
  generateSiteKeys,
  encryptPage,
  buildPayloadMeta,
  validatePayload,
  generateWrapper,
  extractPayload,
  decryptPayload,
  isHtmlFile,
  escapeHtml,
  escapeJsonForScriptTag,
  inlineAssets,
  rewriteCssUrls,
  cssUnescape,
  scanTags,
  findAttr,
  getAttr,
};

// Only run the CLI when invoked as a program: requiring this file must not
// build anything.
if (require.main === module) {
  main().catch((err) => {
    fatal(err && err.message ? err.message : String(err));
  });
}
