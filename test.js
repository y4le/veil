#!/usr/bin/env node
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

const VEIL = path.join(__dirname, 'veil.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(require('os').tmpdir(), 'veil-test-'));
}

function run(args, opts = {}) {
  try {
    const stdout = execFileSync(process.execPath, [VEIL, ...args], {
      encoding: 'utf8',
      timeout: 30000,
      ...opts,
    });
    return { stdout, stderr: '', code: 0 };
  } catch (err) {
    return { stdout: err.stdout || '', stderr: err.stderr || '', code: err.status };
  }
}

function setupSite(dir, files) {
  const siteDir = path.join(dir, 'site');
  fs.mkdirSync(siteDir, { recursive: true });
  for (const [name, content] of Object.entries(files)) {
    const filePath = path.join(siteDir, name);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  }
  return siteDir;
}

function cleanup(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// CLI argument tests
// ---------------------------------------------------------------------------

describe('CLI arguments', () => {
  it('shows help with --help', () => {
    const r = run(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage: veil/);
    assert.match(r.stdout, /--passphrase/);
    assert.match(r.stdout, /--passphrase-env/);
    assert.match(r.stdout, /--html-root/);
  });

  it('exits 1 with no arguments', () => {
    const r = run([]);
    assert.equal(r.code, 1);
    assert.match(r.stdout, /Usage: veil/);
  });

  it('exits 1 for missing input directory', () => {
    const r = run(['/nonexistent/dir', '/tmp/out', '--passphrase', 'test']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /does not exist/);
  });

  it('rejects output inside input', () => {
    const dir = tmpDir();
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const r = run([siteDir, path.join(siteDir, 'dist'), '--passphrase', 'test']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot be the same as, inside, or contain/);
    cleanup(dir);
  });

  it('rejects unknown flags', () => {
    const r = run(['/tmp', '/tmp/out', '--unknown-flag']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Unknown option/);
  });

  it('rejects low iteration count', () => {
    const dir = tmpDir();
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const outDir = path.join(dir, 'out');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '50']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /at least 100000/);
    cleanup(dir);
  });

  it('rejects empty input directory', () => {
    const dir = tmpDir();
    const siteDir = path.join(dir, 'site');
    fs.mkdirSync(siteDir);
    const r = run([siteDir, path.join(dir, 'out'), '--passphrase', 'test']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No HTML files/);
    cleanup(dir);
  });

  it('reads passphrase from environment with --passphrase-env', () => {
    const dir = tmpDir();
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const outDir = path.join(dir, 'out-env');
    const r = run([siteDir, outDir, '--passphrase-env', 'VEIL_TEST_PASS', '--iterations', '100000'], {
      env: { ...process.env, VEIL_TEST_PASS: 'env-secret' },
    });
    assert.equal(r.code, 0);
    const payload = extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'));
    assert.match(decryptPayload(payload, 'env-secret'), /x/);
    cleanup(dir);
  });

  it('rejects missing environment passphrase', () => {
    const dir = tmpDir();
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const outDir = path.join(dir, 'out-env-missing');
    const r = run([siteDir, outDir, '--passphrase-env', 'VEIL_TEST_PASS_MISSING', '--iterations', '100000'], {
      env: { ...process.env, VEIL_TEST_PASS_MISSING: '' },
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /empty or not set/);
    cleanup(dir);
  });

  it('rejects using both --passphrase and --passphrase-env', () => {
    const dir = tmpDir();
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const outDir = path.join(dir, 'out-both-pass');
    const r = run([siteDir, outDir, '--passphrase', 'a', '--passphrase-env', 'VEIL_TEST_PASS', '--iterations', '100000'], {
      env: { ...process.env, VEIL_TEST_PASS: 'b' },
    });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Use only one/);
    cleanup(dir);
  });

  it('rejects html roots outside the input directory', () => {
    const dir = tmpDir();
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const outDir = path.join(dir, 'out-root');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--html-root', '../secret']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot escape/);
    cleanup(dir);
  });
});

// ---------------------------------------------------------------------------
// Output artifact safety tests
// ---------------------------------------------------------------------------

describe('output artifact safety', () => {
  let dir;

  before(() => {
    dir = tmpDir();
  });

  after(() => {
    cleanup(dir);
  });

  it('refuses a non-empty output directory without --force', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const outDir = path.join(dir, 'out-nonempty');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'stale.html'), '<html><body>OLD SECRET</body></html>');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not empty/);
    // Existing content untouched
    assert.match(fs.readFileSync(path.join(outDir, 'stale.html'), 'utf8'), /OLD SECRET/);
  });

  it('replaces a non-empty output directory with --force, removing stale files', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const outDir = path.join(dir, 'out-force');
    fs.mkdirSync(outDir, { recursive: true });
    fs.writeFileSync(path.join(outDir, 'stale.html'), '<html><body>OLD SECRET</body></html>');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000', '--force']);
    assert.equal(r.code, 0);
    assert.ok(!fs.existsSync(path.join(outDir, 'stale.html')), 'stale file should be gone');
    assert.ok(fs.existsSync(path.join(outDir, 'index.html')));
    // No backup or staging directories left behind
    const siblings = fs.readdirSync(dir).filter((f) => f.startsWith('out-force.veil-'));
    assert.deepEqual(siblings, []);
  });

  it('writes into an existing empty output directory', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const outDir = path.join(dir, 'out-empty');
    fs.mkdirSync(outDir, { recursive: true });
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    assert.ok(fs.existsSync(path.join(outDir, 'index.html')));
  });

  it('rejects an output path that is a symlink to another directory', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><body>SOURCE</body></html>' });
    const alias = path.join(dir, 'out-alias');
    fs.symlinkSync(siteDir, alias);
    const r = run([siteDir, alias, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /symbolic link/);
    // Source is intact
    assert.match(fs.readFileSync(path.join(siteDir, 'index.html'), 'utf8'), /SOURCE/);
    fs.unlinkSync(alias);
  });

  it('rejects symlinks inside the input directory with a path-specific error', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const target = path.join(dir, 'outside.css');
    fs.writeFileSync(target, 'body{}');
    fs.symlinkSync(target, path.join(siteDir, 'linked.css'));
    const r = run([siteDir, path.join(dir, 'out-symlink-input'), '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /symbolic link in input directory: linked\.css/);
    fs.unlinkSync(path.join(siteDir, 'linked.css'));
  });

  it('encrypts mixed-case HTML extensions', () => {
    const siteDir = setupSite(dir, {
      'index.html': '<html><body>x</body></html>',
      'SECRET.HTML': '<html><body>UPPER SECRET</body></html>',
      'Report.HtM': '<html><body>MIXED SECRET</body></html>',
    });
    const outDir = path.join(dir, 'out-case');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    for (const name of ['SECRET.HTML', 'Report.HtM']) {
      const content = fs.readFileSync(path.join(outDir, name), 'utf8');
      assert.ok(!content.includes('SECRET'), `${name} must not contain plaintext`);
      assert.match(content, /veil-payload/);
    }
  });

  it('rejects an output that lexically contains a symlinked input path', () => {
    // Input supplied through a symlink living inside the output directory:
    // canonical comparison alone would call these separate trees, and --force
    // replacement would then delete the symlink the input was named through.
    const realSite = path.join(dir, 'real-site');
    fs.mkdirSync(realSite, { recursive: true });
    fs.writeFileSync(path.join(realSite, 'index.html'), '<html><body>REAL</body></html>');
    const jobDir = path.join(dir, 'job');
    fs.mkdirSync(jobDir, { recursive: true });
    const linkedInput = path.join(jobDir, 'site');
    fs.symlinkSync(realSite, linkedInput);
    const r = run([linkedInput, jobDir, '--passphrase', 'test', '--iterations', '100000', '--force']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot be the same as, inside, or contain/);
    assert.ok(fs.lstatSync(linkedInput).isSymbolicLink(), 'input symlink must survive');
    assert.match(fs.readFileSync(path.join(realSite, 'index.html'), 'utf8'), /REAL/);
  });

  // Deterministic fault injection: preload a module via NODE_OPTIONS that
  // makes a chosen fs call throw inside the child process. Works regardless
  // of uid/platform permission semantics.
  function faultModule(name, code) {
    const file = path.join(dir, name);
    fs.writeFileSync(file, code);
    return { ...process.env, NODE_OPTIONS: `--require ${file}` };
  }

  it('cleans up staging when a wrapper write fails mid-build', () => {
    const siteDir = setupSite(dir, {
      'index.html': '<html><body>x</body></html>',
      'boom.html': '<html><body>y</body></html>',
    });
    const env = faultModule('fault-write.js', `
      const fs = require('fs');
      const orig = fs.writeFileSync;
      fs.writeFileSync = function (p, ...rest) {
        if (String(p).endsWith('boom.html')) throw new Error('injected write failure');
        return orig.call(fs, p, ...rest);
      };
    `);
    const outDir = path.join(dir, 'out-midfail');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000'], { env });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /injected write failure/);
    assert.ok(!fs.existsSync(outDir), 'failed build must not publish output');
    const siblings = fs.readdirSync(dir).filter((f) => f.startsWith('out-midfail.veil-'));
    assert.deepEqual(siblings, [], 'failed build must not leave staging dirs');
  });

  it('cleans up staging when the post-mkdtemp chmod fails', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const env = faultModule('fault-chmod.js', `
      const fs = require('fs');
      const orig = fs.chmodSync;
      fs.chmodSync = function (p, ...rest) {
        if (String(p).includes('.veil-tmp-')) throw new Error('injected chmod failure');
        return orig.call(fs, p, ...rest);
      };
    `);
    const outDir = path.join(dir, 'out-chmodfail');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000'], { env });
    assert.equal(r.code, 1);
    assert.match(r.stderr, /injected chmod failure/);
    assert.ok(!fs.existsSync(outDir), 'failed build must not publish output');
    const siblings = fs.readdirSync(dir).filter((f) => f.startsWith('out-chmodfail.veil-'));
    assert.deepEqual(siblings, [], 'chmod failure must not leak the staging dir');
  });

  it('published output directory has a umask-derived mode (POSIX)', (t) => {
    if (process.platform === 'win32') return t.skip();
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const outDir = path.join(dir, 'out-mode');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const mode = fs.statSync(outDir).mode & 0o777;
    assert.equal(mode, 0o777 & ~process.umask());
  });

  it('a failed run creates no output directory', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const outDir = path.join(dir, 'out-failed');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '99999']);
    assert.equal(r.code, 1);
    assert.ok(!fs.existsSync(outDir), 'failed run must not create output');
    const siblings = fs.readdirSync(dir).filter((f) => f.startsWith('out-failed.veil-'));
    assert.deepEqual(siblings, [], 'failed run must not leave staging dirs');
  });
});

// ---------------------------------------------------------------------------
// Asset inlining tests
// ---------------------------------------------------------------------------

describe('asset inlining', () => {
  let dir;

  before(() => {
    dir = tmpDir();
  });

  after(() => {
    cleanup(dir);
  });

  it('inlines local CSS', () => {
    const siteDir = setupSite(dir, {
      'index.html': '<html><head><link rel="stylesheet" href="style.css"></head><body>x</body></html>',
      'style.css': 'body{color:red}',
    });
    const outDir = path.join(dir, 'out-css');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const wrapper = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    // The wrapper contains encrypted content, so we check the JSON payload
    const payload = extractPayload(wrapper);
    const html = decryptPayload(payload, 'test');
    assert.match(html, /<style>body\{color:red\}/);
    assert.ok(!html.includes('href="style.css"'));
  });

  it('inlines local JS with script-close escaping', () => {
    const siteDir = setupSite(dir, {
      'index.html': '<html><body><script src="app.js"></script></body></html>',
      'app.js': 'var x = "</script>";',
    });
    const outDir = path.join(dir, 'out-js');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8')), 'test');
    assert.match(html, /<\\\/script>/);
    assert.ok(!html.includes('src="app.js"'));
  });

  it('preserves external URLs', () => {
    const siteDir = setupSite(dir, {
      'index.html': '<html><head><link rel="stylesheet" href="https://cdn.example.com/lib.css"></head><body><script src="//cdn.example.com/lib.js"></script></body></html>',
    });
    const outDir = path.join(dir, 'out-ext');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8')), 'test');
    assert.match(html, /href="https:\/\/cdn\.example\.com\/lib\.css"/);
    assert.match(html, /src="\/\/cdn\.example\.com\/lib\.js"/);
  });

  it('skips inlining with --no-inline', () => {
    const siteDir = setupSite(dir, {
      'index.html': '<html><head><link rel="stylesheet" href="style2.css"></head><body>x</body></html>',
      'style2.css': 'body{color:blue}',
    });
    const outDir = path.join(dir, 'out-noinline');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000', '--no-inline']);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8')), 'test');
    assert.match(html, /href="style2\.css"/);
    assert.ok(!html.includes('body{color:blue}'));
  });

  it('blocks path traversal', () => {
    const siteDir = setupSite(dir, {
      'index.html': '<html><head><link rel="stylesheet" href="../../etc/passwd"></head><body>x</body></html>',
    });
    const outDir = path.join(dir, 'out-traversal');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8')), 'test');
    assert.match(html, /href="\.\.\/\.\.\/etc\/passwd"/);
  });

  it('preserves media attribute on inlined CSS', () => {
    const siteDir = setupSite(dir, {
      'index.html': '<html><head><link rel="stylesheet" href="print.css" media="print"></head><body>x</body></html>',
      'print.css': '@page{margin:1cm}',
    });
    const outDir = path.join(dir, 'out-media');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8')), 'test');
    assert.match(html, /<style media="print">/);
  });

  it('inlines assets outside the encrypted subtree when input root is wider', () => {
    const siteDir = setupSite(dir, {
      'index.html': '<html><body>public</body></html>',
      'trip/web/index.html': '<html><head><link rel="stylesheet" href="../../assets/travel.css"></head><body><script src="app.js"></script></body></html>',
      'trip/web/app.js': 'window.tripLoaded = true;',
      'assets/travel.css': 'body{color:green}',
    });
    const outDir = path.join(dir, 'out-wide-root');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000', '--html-root', 'trip/web']);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'trip/web/index.html'), 'utf8')), 'test');
    assert.match(html, /body\{color:green\}/);
    assert.match(html, /window\.tripLoaded = true/);
    assert.ok(!html.includes('href="../../assets/travel.css"'));
  });
});

// ---------------------------------------------------------------------------
// Encryption tests
// ---------------------------------------------------------------------------

describe('encryption', () => {
  let dir;

  before(() => {
    dir = tmpDir();
  });

  after(() => {
    cleanup(dir);
  });

  it('encrypts and decrypts a page correctly', () => {
    const original = '<!DOCTYPE html><html><head><title>Test</title></head><body><h1>Hello</h1></body></html>';
    const siteDir = setupSite(dir, { 'index.html': original });
    const outDir = path.join(dir, 'out-encrypt');
    run([siteDir, outDir, '--passphrase', 'secret', '--iterations', '100000']);
    const wrapper = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    const payload = extractPayload(wrapper);
    const decrypted = decryptPayload(payload, 'secret');
    assert.equal(decrypted, original);
  });

  it('rejects wrong passphrase', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><body>secret</body></html>' });
    const outDir = path.join(dir, 'out-wrong');
    run([siteDir, outDir, '--passphrase', 'correct', '--iterations', '100000']);
    const payload = extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'));
    assert.throws(() => decryptPayload(payload, 'wrong'));
  });

  it('includes correct metadata in payload', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><head><title>My Title</title></head><body>x</body></html>' });
    const outDir = path.join(dir, 'out-meta');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '200000', '--id', 'my-site']);
    const payload = extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'));
    assert.equal(payload.v, 1);
    assert.equal(payload.siteId, 'my-site');
    assert.equal(payload.iterations, 200000);
    assert.equal(payload.title, 'My Title');
    assert.equal(payload.remember, false);
  });

  it('respects --remember flag', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const outDir = path.join(dir, 'out-remember');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000', '--remember']);
    const payload = extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'));
    assert.equal(payload.remember, true);
  });

  it('different builds produce different salt, wrappedMk, and IVs', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const outDir1 = path.join(dir, 'out-run1');
    const outDir2 = path.join(dir, 'out-run2');
    run([siteDir, outDir1, '--passphrase', 'test', '--iterations', '100000']);
    run([siteDir, outDir2, '--passphrase', 'test', '--iterations', '100000']);
    const p1 = extractPayload(fs.readFileSync(path.join(outDir1, 'index.html'), 'utf8'));
    const p2 = extractPayload(fs.readFileSync(path.join(outDir2, 'index.html'), 'utf8'));
    assert.notEqual(p1.salt, p2.salt);
    assert.notEqual(p1.wrappedMk, p2.wrappedMk);
    assert.notEqual(p1.wrapIv, p2.wrapIv);
    assert.notEqual(p1.iv, p2.iv);
    // Both still decrypt correctly
    assert.match(decryptPayload(p1, 'test'), /x/);
    assert.match(decryptPayload(p2, 'test'), /x/);
  });

  it('rejects tampered ciphertext', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><body>secret</body></html>' });
    const outDir = path.join(dir, 'out-tamper-ct');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const payload = extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'));
    // Flip a byte in the ciphertext
    const ct = Buffer.from(payload.ct, 'base64');
    ct[0] ^= 0xff;
    payload.ct = ct.toString('base64');
    assert.throws(() => decryptPayload(payload, 'test'));
  });

  it('rejects tampered wrappedMk', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><body>secret</body></html>' });
    const outDir = path.join(dir, 'out-tamper-mk');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const payload = extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'));
    const mk = Buffer.from(payload.wrappedMk, 'base64');
    mk[0] ^= 0xff;
    payload.wrappedMk = mk.toString('base64');
    assert.throws(() => decryptPayload(payload, 'test'));
  });

  it('rejects tampered siteId (AAD mismatch)', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><body>secret</body></html>' });
    const outDir = path.join(dir, 'out-tamper-aad');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const payload = extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'));
    payload.siteId = 'tampered-site';
    assert.throws(() => decryptPayload(payload, 'test'));
  });

  it('rejects tampered version (AAD mismatch)', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><body>secret</body></html>' });
    const outDir = path.join(dir, 'out-tamper-ver');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const payload = extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'));
    payload.v = 99;
    assert.throws(() => decryptPayload(payload, 'test'));
  });

  it('encrypts multiple pages with same MK', () => {
    const siteDir = setupSite(dir, {
      'index.html': '<html><body>page1</body></html>',
      'about.html': '<html><body>page2</body></html>',
    });
    const outDir = path.join(dir, 'out-multi');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const p1 = extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'));
    const p2 = extractPayload(fs.readFileSync(path.join(outDir, 'about.html'), 'utf8'));
    // Same site keys
    assert.equal(p1.salt, p2.salt);
    assert.equal(p1.wrappedMk, p2.wrappedMk);
    assert.equal(p1.wrapIv, p2.wrapIv);
    // Different per-page IVs
    assert.notEqual(p1.iv, p2.iv);
    // Both decrypt correctly
    assert.match(decryptPayload(p1, 'test'), /page1/);
    assert.match(decryptPayload(p2, 'test'), /page2/);
  });
});

// ---------------------------------------------------------------------------
// Wrapper HTML tests
// ---------------------------------------------------------------------------

describe('wrapper HTML', () => {
  let dir;

  before(() => {
    dir = tmpDir();
  });

  after(() => {
    cleanup(dir);
  });

  it('produces valid HTML with CSP', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const outDir = path.join(dir, 'out-wrapper');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const wrapper = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    assert.match(wrapper, /<!DOCTYPE html>/);
    assert.match(wrapper, /Content-Security-Policy/);
    assert.match(wrapper, /default-src 'none'/);
    assert.match(wrapper, /veil-payload/);
    assert.match(wrapper, /veil-prompt/);
    assert.match(wrapper, /veil-form/);
  });

  it('preserves page title', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><head><title>My Page</title></head><body>x</body></html>' });
    const outDir = path.join(dir, 'out-title');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const wrapper = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    assert.match(wrapper, /<title>My Page<\/title>/);
  });

  it('escapes HTML entities in title', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><head><title>A & B <C></title></head><body>x</body></html>' });
    const outDir = path.join(dir, 'out-escape');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const wrapper = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    assert.match(wrapper, /A &amp; B &lt;C&gt;/);
  });

  it('embeds script payload as valid JSON, not HTML-escaped JSON', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><head><title>Quote " Test</title></head><body>x & y</body></html>' });
    const outDir = path.join(dir, 'out-json-payload');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const wrapper = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    const match = wrapper.match(/<script id="veil-payload" type="application\/json">([^<]+)<\/script>/);
    assert.ok(match);
    assert.doesNotMatch(match[1], /&quot;|&lt;|&gt;|&amp;/);
    assert.equal(JSON.parse(match[1]).title, 'Quote " Test');
  });

  it('copies non-HTML files', () => {
    const siteDir = setupSite(dir, {
      'index.html': '<html><body>x</body></html>',
      'image.png': 'fake-png-data',
      'sub/data.json': '{"key":"value"}',
    });
    const outDir = path.join(dir, 'out-assets');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(fs.readFileSync(path.join(outDir, 'image.png'), 'utf8'), 'fake-png-data');
    assert.equal(fs.readFileSync(path.join(outDir, 'sub', 'data.json'), 'utf8'), '{"key":"value"}');
  });

  it('uses fallback title for pages without <title>', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><body>no title here</body></html>' });
    const outDir = path.join(dir, 'out-notitle');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const wrapper = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    assert.match(wrapper, /<title>Protected Page<\/title>/);
  });

  it('checks "remember" by default when --remember is set', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const outDir = path.join(dir, 'out-rem-check');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000', '--remember']);
    const wrapper = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    assert.match(wrapper, /id="veil-rem" checked/);
  });

  it('can encrypt only one HTML subtree and leave other HTML public', () => {
    const siteDir = setupSite(dir, {
      'index.html': '<html><body>public root</body></html>',
      'trip/web/index.html': '<html><body>private trip</body></html>',
      'trip/web/about.html': '<html><body>private about</body></html>',
      'assets/data.json': '{"ok":true}',
    });
    const outDir = path.join(dir, 'out-subtree');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000', '--html-root', 'trip/web']);
    assert.equal(r.code, 0);
    assert.equal(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'), '<html><body>public root</body></html>');
    assert.equal(fs.readFileSync(path.join(outDir, 'assets', 'data.json'), 'utf8'), '{"ok":true}');
    const payload = extractPayload(fs.readFileSync(path.join(outDir, 'trip/web/index.html'), 'utf8'));
    assert.match(decryptPayload(payload, 'test'), /private trip/);
    const payload2 = extractPayload(fs.readFileSync(path.join(outDir, 'trip/web/about.html'), 'utf8'));
    assert.match(decryptPayload(payload2, 'test'), /private about/);
  });

  it('rejects html roots that match no HTML files', () => {
    const siteDir = setupSite(dir, {
      'index.html': '<html><body>public root</body></html>',
      'trip/web/index.html': '<html><body>private trip</body></html>',
    });
    const outDir = path.join(dir, 'out-no-match');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000', '--html-root', 'missing/web']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /No HTML files matched --html-root/);
  });
});

// ---------------------------------------------------------------------------
// Helpers for decryption in tests
// ---------------------------------------------------------------------------

function extractPayload(wrapperHtml) {
  const match = wrapperHtml.match(/<script id="veil-payload" type="application\/json">([^<]+)<\/script>/);
  if (!match) throw new Error('Could not find veil-payload in wrapper HTML');
  return JSON.parse(match[1]);
}

function decryptPayload(payload, passphrase) {
  const salt = Buffer.from(payload.salt, 'base64');
  const aad = Buffer.from(`veil:v${payload.v}:${payload.siteId}`);

  // Derive KEK
  const kek = crypto.pbkdf2Sync(passphrase, salt, payload.iterations, 32, 'sha256');

  // Unwrap MK
  const wrapIv = Buffer.from(payload.wrapIv, 'base64');
  const wrapped = Buffer.from(payload.wrappedMk, 'base64');
  const decipher1 = crypto.createDecipheriv('aes-256-gcm', kek, wrapIv);
  decipher1.setAAD(aad);
  decipher1.setAuthTag(wrapped.subarray(32));
  const mk = Buffer.concat([decipher1.update(wrapped.subarray(0, 32)), decipher1.final()]);

  // Decrypt page
  const iv = Buffer.from(payload.iv, 'base64');
  const ct = Buffer.from(payload.ct, 'base64');
  const decipher2 = crypto.createDecipheriv('aes-256-gcm', mk, iv);
  decipher2.setAAD(aad);
  decipher2.setAuthTag(ct.subarray(ct.length - 16));
  const plaintext = Buffer.concat([decipher2.update(ct.subarray(0, ct.length - 16)), decipher2.final()]);
  return plaintext.toString('utf8');
}
