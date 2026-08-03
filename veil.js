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

Encrypt a directory of HTML files for static hosting.

Options:
  --passphrase <pass>   Set passphrase (omit to prompt interactively)
  --passphrase-env <n>  Read passphrase from environment variable <n>
  --id <site-id>        Storage key scope (default: output dir basename)
  --iterations <N>      PBKDF2 iteration count (default: 600000)
  --remember            Check "Remember this device" by default
  --html-root <dir>     Encrypt only HTML under this input-relative dir (repeatable)
  --no-inline           Skip local CSS/JS inlining
  --force               Replace a non-empty output directory
  --help                Show this help

The output directory is built fresh on every run: Veil stages the build in a
temporary sibling directory and moves it into place, so the output never mixes
files from different builds. A non-empty output directory is only replaced
with --force.
`.trim();
  console.log(usage);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    inputDir: null,
    outputDir: null,
    passphrase: null,
    passphraseEnv: null,
    siteId: null,
    iterations: 600000,
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
    } else if (arg === '--passphrase') {
      opts.passphrase = args[++i];
      if (opts.passphrase === undefined) fatal('--passphrase requires a value');
    } else if (arg === '--passphrase-env') {
      opts.passphraseEnv = args[++i];
      if (opts.passphraseEnv === undefined) fatal('--passphrase-env requires a value');
    } else if (arg === '--id') {
      opts.siteId = args[++i];
      if (opts.siteId === undefined) fatal('--id requires a value');
    } else if (arg === '--iterations') {
      const val = parseInt(args[++i], 10);
      if (isNaN(val) || val < 1) fatal('--iterations must be a positive integer');
      opts.iterations = val;
    } else if (arg === '--remember') {
      opts.remember = true;
    } else if (arg === '--html-root') {
      const root = args[++i];
      if (root === undefined) fatal('--html-root requires a value');
      opts.htmlRoots.push(normalizeHtmlRoot(root));
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

  opts.inputDir = path.resolve(positional[0]);
  opts.outputDir = path.resolve(positional[1]);

  if (!opts.siteId) {
    opts.siteId = path.basename(opts.outputDir);
  }

  return opts;
}

// ---------------------------------------------------------------------------
// Utilities
// ---------------------------------------------------------------------------

function fatal(msg) {
  console.error(`veil: ${msg}`);
  process.exit(1);
}

function promptPassphrase() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    // Disable echo for passphrase input
    if (process.stdin.isTTY) {
      process.stdout.write('Passphrase: ');
      process.stdin.setRawMode(true);
      let input = '';
      process.stdin.resume();
      process.stdin.setEncoding('utf8');
      const onData = (ch) => {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener('data', onData);
          rl.close();
          process.stdout.write('\n');
          resolve(input);
        } else if (ch === '\u0003') {
          // Ctrl-C
          process.stdout.write('\n');
          process.exit(1);
        } else if (ch === '\u007f' || ch === '\b') {
          // Backspace
          input = input.slice(0, -1);
        } else {
          input += ch;
        }
      };
      process.stdin.on('data', onData);
    } else {
      // Non-interactive: read from stdin pipe
      rl.question('Passphrase: ', (answer) => {
        rl.close();
        resolve(answer || '');
      });
      // Handle closed stdin (e.g., </dev/null) — 'close' fires with no 'line'
      rl.on('close', () => resolve(''));
    }
  });
}

function normalizeHtmlRoot(root) {
  const normalized = path.normalize(root);
  if (path.isAbsolute(normalized)) {
    fatal(`--html-root must be relative to the input directory: ${root}`);
  }
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    fatal(`--html-root cannot escape the input directory: ${root}`);
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

/** Check if a URL should not be inlined (external, absolute, or non-http scheme). */
function isExternalUrl(url) {
  // Protocol-relative, http(s), or any explicit scheme (data:, file:, blob:, javascript:)
  if (/^\/\/|^[a-z][a-z0-9+.-]*:/i.test(url)) return true;
  // Absolute path (site-root reference) — can't resolve locally
  if (url.startsWith('/')) return true;
  return false;
}

/** Resolve a local asset path, confined within the allowed root directory. */
function resolveAssetPath(htmlDir, href, inputRoot) {
  const resolved = path.resolve(htmlDir, href);
  try {
    const real = fs.realpathSync(resolved);
    const realRoot = fs.realpathSync(inputRoot);
    const rel = path.relative(realRoot, real);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
    return real;
  } catch {
    return null; // file doesn't exist
  }
}

/** Escape </script> sequences in JS to prevent premature tag closure. */
function escapeScriptClose(js) {
  return js.replace(/<\/(script)/gi, '<\\/$1');
}

/**
 * Inline local CSS <link> tags and local JS <script src> tags into the HTML.
 * External URLs are left untouched. Paths are confined to inputRoot.
 *
 * @param {string} html - The HTML content
 * @param {string} htmlDir - The directory containing the HTML file
 * @param {string} inputRoot - The top-level input directory (path confinement boundary)
 * @returns {string} HTML with local assets inlined
 */
function inlineAssets(html, htmlDir, inputRoot) {
  // Inline local CSS: <link rel="stylesheet" href="local.css"> → <style>contents</style>
  html = html.replace(
    /<link\s+[^>]*rel\s*=\s*["']stylesheet["'][^>]*>/gi,
    (tag) => {
      const hrefMatch = tag.match(/href\s*=\s*["']([^"']+)["']/i);
      if (!hrefMatch) return tag;
      const href = hrefMatch[1].split(/[?#]/)[0]; // strip query/hash
      if (isExternalUrl(href)) return tag;
      const cssPath = resolveAssetPath(htmlDir, href, inputRoot);
      if (!cssPath) return tag;
      try {
        const css = fs.readFileSync(cssPath, 'utf8');
        // Preserve media attribute if present
        const mediaMatch = tag.match(/media\s*=\s*["']([^"']+)["']/i);
        const mediaAttr = mediaMatch ? ` media="${mediaMatch[1]}"` : '';
        return `<style${mediaAttr}>${css}</style>`;
      } catch {
        console.warn(`veil: warning: could not inline CSS: ${href}`);
        return tag;
      }
    }
  );

  // Inline local JS: <script src="local.js"></script> → <script>contents</script>
  html = html.replace(
    /<script\s+[^>]*src\s*=\s*["']([^"']+)["'][^>]*>\s*<\/script>/gi,
    (tag, src) => {
      src = src.split(/[?#]/)[0]; // strip query/hash
      if (isExternalUrl(src)) return tag;
      const jsPath = resolveAssetPath(htmlDir, src, inputRoot);
      if (!jsPath) return tag;
      try {
        const js = escapeScriptClose(fs.readFileSync(jsPath, 'utf8'));
        // Preserve other attributes (type, etc.) minus src
        const openTag = tag
          .match(/<script\s[^>]*>/i)[0]
          .replace(/\s*src\s*=\s*["'][^"']*["']/i, '');
        return `${openTag}${js}</script>`;
      } catch {
        console.warn(`veil: warning: could not inline JS: ${src}`);
        return tag;
      }
    }
  );

  return html;
}

// ---------------------------------------------------------------------------
// Encryption
// ---------------------------------------------------------------------------

const FORMAT_VERSION = 1;
const MIN_ITERATIONS = 100000;

/** Build the AAD string that binds metadata to authenticated ciphertext. */
function buildAad(siteId) {
  return Buffer.from(`veil:v${FORMAT_VERSION}:${siteId}`);
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
  if (iterations < MIN_ITERATIONS) {
    fatal(`Iterations must be at least ${MIN_ITERATIONS} (got ${iterations})`);
  }

  // Random site master key (256-bit)
  const mk = crypto.randomBytes(32);

  // Random salt for PBKDF2 (128-bit)
  const salt = crypto.randomBytes(16);

  // Derive KEK from passphrase
  const kek = crypto.pbkdf2Sync(passphrase, salt, iterations, 32, 'sha256');

  // Wrap MK with AES-256-GCM using KEK, with AAD
  const aad = buildAad(siteId);
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
 * @returns {{ ciphertext: Buffer, iv: Buffer }}
 */
function encryptPage(html, mk, siteId) {
  const aad = buildAad(siteId);
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

// ---------------------------------------------------------------------------
// Wrapper template
// ---------------------------------------------------------------------------

/**
 * Generate a self-contained HTML wrapper page that decrypts and displays content.
 *
 * @param {object} pageData - The encrypted payload and metadata
 * @returns {string} Complete HTML wrapper page
 */
function generateWrapper(pageData) {
  const jsonPayload = JSON.stringify(pageData);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:; form-action 'none'">
<title>${escapeHtml(pageData.title)}</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:#1a1a2e;color:#e0e0e0;min-height:100vh;display:flex;align-items:center;justify-content:center}
.veil-prompt{max-width:360px;width:100%;padding:2rem;text-align:center}
.veil-prompt h1{font-size:1.25rem;font-weight:500;margin-bottom:1.5rem;color:#a0a0c0}
.veil-prompt input[type=password]{width:100%;padding:.75rem 1rem;font-size:1rem;background:#16213e;border:1px solid #333;border-radius:6px;color:#e0e0e0;outline:none;transition:border-color .2s}
.veil-prompt input[type=password]:focus{border-color:#7c83ff}
.veil-prompt .veil-remember{display:flex;align-items:center;gap:.5rem;margin-top:.75rem;font-size:.85rem;color:#888;cursor:pointer;justify-content:center}
.veil-prompt .veil-remember input{cursor:pointer}
.veil-prompt .veil-btn{width:100%;padding:.75rem;margin-top:1rem;font-size:1rem;background:#7c83ff;color:#fff;border:none;border-radius:6px;cursor:pointer;transition:background .2s}
.veil-prompt .veil-btn:hover{background:#6a70e0}
.veil-prompt .veil-btn:disabled{background:#444;cursor:not-allowed}
.veil-error{color:#ff6b6b;font-size:.85rem;margin-top:.75rem;min-height:1.2em}
.veil-lock{position:fixed;top:12px;right:12px;background:none;border:none;color:#666;font-size:1.25rem;cursor:pointer;padding:4px 8px;z-index:99999;opacity:.5;transition:opacity .2s}
.veil-lock:hover{opacity:1}
.veil-hidden{display:none!important}
</style>
</head>
<body>
<div class="veil-prompt" id="veil-prompt">
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
var D=document,W=window,S=W.crypto.subtle;
var data=JSON.parse(D.getElementById('veil-payload').textContent);
var SK='veil:v'+data.v+':'+data.siteId+':mk';
var aadStr='veil:v'+data.v+':'+data.siteId;

function b64(s){return Uint8Array.from(atob(s),function(c){return c.charCodeAt(0)})}
function toAb(u){return u.buffer.slice(u.byteOffset,u.byteOffset+u.byteLength)}

function importMk(raw){
return S.importKey('raw',raw,{name:'AES-GCM'},false,['decrypt']);
}

function decryptPage(mkKey){
var ct=b64(data.ct),iv=b64(data.iv);
var aad=new TextEncoder().encode(aadStr);
return S.decrypt({name:'AES-GCM',iv:toAb(iv),additionalData:toAb(aad),tagLength:128},mkKey,toAb(ct));
}

function showPage(buf){
var html=new TextDecoder().decode(buf);
D.open();D.write(html);D.close();
// Add lock button to decrypted page
var lock=D.createElement('button');
lock.className='veil-lock';lock.textContent='\\u{1F512}';
lock.title='Lock (forget passphrase)';
lock.onclick=function(){doLogout()};
var s=D.createElement('style');
s.textContent='.veil-lock{position:fixed;top:12px;right:12px;background:none;border:none;color:#666;font-size:1.25rem;cursor:pointer;padding:4px 8px;z-index:99999;opacity:.5;transition:opacity .2s}.veil-lock:hover{opacity:1}';
D.body.appendChild(s);D.body.appendChild(lock);
}

function cacheMk(raw,persist){
var b64mk=btoa(String.fromCharCode.apply(null,new Uint8Array(raw)));
try{sessionStorage.setItem(SK,b64mk)}catch(e){}
if(persist){try{localStorage.setItem(SK,b64mk)}catch(e){}}
}

function getCachedMk(){
var s=sessionStorage.getItem(SK)||localStorage.getItem(SK);
if(!s)return null;
return Uint8Array.from(atob(s),function(c){return c.charCodeAt(0)});
}

function doLogout(){
try{sessionStorage.removeItem(SK)}catch(e){}
try{localStorage.removeItem(SK)}catch(e){}
W.location.reload();
}

function deriveAndUnwrap(passphrase){
var salt=b64(data.salt);
var aad=new TextEncoder().encode(aadStr);
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

// Check for logout
if(W.location.search.indexOf('veil=logout')!==-1){
doLogout();
}

// Try cached MK first
var cached=getCachedMk();
if(cached){
importMk(toAb(cached))
.then(function(k){return decryptPage(k)})
.then(function(buf){showPage(buf)})
.catch(function(){
// Stale cache — clear and show prompt
try{sessionStorage.removeItem(SK)}catch(e){}
try{localStorage.removeItem(SK)}catch(e){}
D.getElementById('veil-prompt').classList.remove('veil-hidden');
});
}else{
D.getElementById('veil-prompt').classList.remove('veil-hidden');
}

// Form handler
D.getElementById('veil-form').addEventListener('submit',function(e){
e.preventDefault();
var pass=D.getElementById('veil-pass').value;
var persist=D.getElementById('veil-rem').checked;
var btn=D.getElementById('veil-btn');
var err=D.getElementById('veil-error');
if(!pass){err.textContent='Please enter a passphrase.';return}
btn.disabled=true;btn.textContent='Decrypting\\u2026';err.textContent='';
deriveAndUnwrap(pass)
.then(function(mkRaw){
cacheMk(mkRaw,persist);
return importMk(mkRaw).then(function(k){return decryptPage(k)});
})
.then(function(buf){showPage(buf)})
.catch(function(){
err.textContent='Wrong passphrase. Please try again.';
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

// ---------------------------------------------------------------------------
// File system helpers
// ---------------------------------------------------------------------------

/** Case-insensitive HTML file classification, used everywhere HTML is decided. */
function isHtmlFile(name) {
  return /\.html?$/i.test(name);
}

/**
 * Recursively collect all files under dir, returning paths relative to dir.
 * Symlinks and special files are rejected: silently skipping them (the old
 * behavior) made files vanish from builds, and following them would need
 * cycle handling and escape checks. Rejecting is the simple, safe policy.
 */
function walkDir(dir, relBase = '') {
  const results = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    const rel = path.join(relBase, entry.name);
    if (entry.isSymbolicLink()) {
      fatal(
        `symbolic link in input directory: ${rel}\n` +
        'Veil does not follow symlinks. Replace it with a regular file or directory.'
      );
    } else if (entry.isDirectory()) {
      results.push(...walkDir(full, rel));
    } else if (entry.isFile()) {
      results.push(rel);
    } else {
      fatal(`unsupported file type in input directory: ${rel}`);
    }
  }
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
// Main
// ---------------------------------------------------------------------------

async function main() {
  const opts = parseArgs(process.argv);

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

  if (opts.passphrase && opts.passphraseEnv) {
    fatal('Use only one of --passphrase or --passphrase-env');
  }

  if (!opts.passphrase && opts.passphraseEnv) {
    opts.passphrase = process.env[opts.passphraseEnv] || '';
    if (!opts.passphrase) {
      fatal(`Environment variable ${opts.passphraseEnv} is empty or not set`);
    }
  }

  if (!opts.passphrase) {
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
  const publicOtherFiles = passthroughFiles.filter((f) => !isHtmlFile(f));

  if (publicOtherFiles.length > 0) {
    console.warn(`veil: copying ${publicOtherFiles.length} non-HTML file(s) unencrypted — these remain public`);
  }
  if (publicHtmlFiles.length > 0) {
    console.warn(`veil: leaving ${publicHtmlFiles.length} HTML file(s) public outside the encrypted roots`);
  }

  ensureDir(path.dirname(opts.outputDir));
  const stagingDir = fs.mkdtempSync(`${opts.outputDir}.veil-tmp-`);

  let published = false;
  try {
    // mkdtemp creates 0700; published output should have a normal
    // umask-derived directory mode so other users (e.g. a web server) can
    // traverse it.
    fs.chmodSync(stagingDir, 0o777 & ~process.umask());

    for (const file of passthroughFiles) {
      copyFile(
        path.join(opts.inputDir, file),
        path.join(stagingDir, file)
      );
    }

    // Process HTML files: inline assets, encrypt, generate wrapper
    for (const file of htmlFiles) {
      const src = path.join(opts.inputDir, file);
      let html = fs.readFileSync(src, 'utf8');

      if (opts.inline) {
        html = inlineAssets(html, path.dirname(src), opts.inputDir);
      }

      // Extract page title for the wrapper
      const titleMatch = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
      const pageTitle = titleMatch ? titleMatch[1].trim() : 'Protected Page';

      // Encrypt the page
      const { ciphertext, iv } = encryptPage(html, siteKeys.mk, opts.siteId);

      // Build per-page data
      const pageData = {
        ...payloadMeta,
        title: pageTitle,
        ct: ciphertext.toString('base64'),
        iv: iv.toString('base64'),
      };

      // Generate self-contained wrapper HTML
      const wrapper = generateWrapper(pageData);
      const dest = path.join(stagingDir, file);
      ensureDir(path.dirname(dest));
      fs.writeFileSync(dest, wrapper);
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

main().catch((err) => {
  fatal(err && err.message ? err.message : String(err));
});
