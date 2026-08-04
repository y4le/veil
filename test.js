#!/usr/bin/env node
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
// Tests decrypt with the real implementation, not a copy of it.
const { extractPayload, decryptPayload } = require('./veil.js');

const VEIL = path.join(__dirname, 'veil.js');

function tmpDir() {
  return fs.mkdtempSync(path.join(require('os').tmpdir(), 'veil-test-'));
}

function run(args, opts = {}) {
  const r = spawnSync(process.execPath, [VEIL, ...args], {
    encoding: 'utf8',
    timeout: 30000,
    ...opts,
  });
  return { stdout: r.stdout || '', stderr: r.stderr || '', code: r.status };
}

function setupSite(dir, files) {
  // A fresh directory per call: shared fixture dirs let files from earlier
  // tests leak into later ones and make results order-dependent.
  const siteDir = fs.mkdtempSync(path.join(dir, 'site-'));
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

  it('inlines root-relative CSS and JS', () => {
    const siteDir = setupSite(dir, {
      'sub/page.html':
        '<html><head><link rel="stylesheet" href="/rootstyle.css"></head>' +
        '<body><script src="/lib/rootapp.js"></script></body></html>',
      'rootstyle.css': 'body{color:teal}',
      'lib/rootapp.js': 'var rootApp = 1;',
    });
    const outDir = path.join(dir, 'out-rootrel');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'sub/page.html'), 'utf8')), 'test');
    assert.match(html, /color:teal/);
    assert.match(html, /var rootApp = 1/);
    assert.ok(!html.includes('href="/rootstyle.css"'));
    assert.ok(!html.includes('src="/lib/rootapp.js"'));
  });

  it('inlines unquoted attribute references', () => {
    const siteDir = setupSite(dir, {
      'unq.html':
        '<html><head><link rel=stylesheet href=unq.css></head>' +
        '<body><script src=unq.js></script></body></html>',
      'unq.css': 'body{color:olive}',
      'unq.js': 'var unq = 1;',
    });
    const outDir = path.join(dir, 'out-unquoted');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'unq.html'), 'utf8')), 'test');
    assert.match(html, /color:olive/);
    assert.match(html, /var unq = 1/);
  });

  it('inlines percent-encoded references', () => {
    const siteDir = setupSite(dir, {
      'enc.html': '<html><head><link rel="stylesheet" href="my%20style.css"></head><body>x</body></html>',
      'my style.css': 'body{color:navy}',
    });
    const outDir = path.join(dir, 'out-encoded');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'enc.html'), 'utf8')), 'test');
    assert.match(html, /color:navy/);
  });

  it('escapes </style> sequences in inlined CSS', () => {
    const siteDir = setupSite(dir, {
      'esc.html': '<html><head><link rel="stylesheet" href="esc.css"></head><body>x</body></html>',
      'esc.css': 'i::before{content:"</style><script>alert(1)</script>"}',
    });
    const outDir = path.join(dir, 'out-styleesc');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'esc.html'), 'utf8')), 'test');
    assert.ok(!html.includes('</style><script>alert(1)'), 'CSS must not break out of its style tag');
    assert.match(html, /<\\\/style>/);
  });

  it('rewrites relative and root-relative url() and @import in inlined CSS', () => {
    const siteDir = setupSite(dir, {
      'trip/web/page.html': '<html><head><link rel="stylesheet" href="../../assets/deep.css"></head><body>x</body></html>',
      'assets/deep.css':
        '@import "theme/base.css";\n' +
        'body{background:url(bg.png?v=2)}\n' +
        'h1{background:url("/logo.png")}\n' +
        'p{background:url(https://cdn.example.com/x.png)}',
      'assets/theme/base.css': 'b{}',
      'assets/bg.png': 'png',
      'logo.png': 'png',
    });
    const outDir = path.join(dir, 'out-cssurl');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'trip/web/page.html'), 'utf8')), 'test');
    assert.match(html, /@import "\.\.\/\.\.\/assets\/theme\/base\.css"/);
    assert.match(html, /url\("\.\.\/\.\.\/assets\/bg\.png\?v=2"\)/);
    assert.match(html, /url\("\.\.\/\.\.\/logo\.png"\)/);
    assert.match(html, /url\(https:\/\/cdn\.example\.com\/x\.png\)/, 'external url() must be untouched');
    // url()/@import targets must still exist in the output
    assert.ok(fs.existsSync(path.join(outDir, 'assets/theme/base.css')));
    assert.ok(fs.existsSync(path.join(outDir, 'assets/bg.png')));
    assert.ok(fs.existsSync(path.join(outDir, 'logo.png')));
  });

  it('omits inlined CSS that public files do not reference', () => {
    const siteDir = setupSite(dir, {
      'secret/page.html': '<html><head><link rel="stylesheet" href="only.css"></head><body><script src="only.js"></script></body></html>',
      'secret/only.css': 'body{color:red}',
      'secret/only.js': 'var only = 1;',
      'public.html': '<html><head><link rel="stylesheet" href="shared.css"></head><body>pub</body></html>',
      'shared.css': 'body{color:green}',
    });
    const outDir = path.join(dir, 'out-omit');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000', '--html-root', 'secret']);
    assert.equal(r.code, 0);
    assert.ok(!fs.existsSync(path.join(outDir, 'secret/only.css')), 'inlined-only CSS must not be published');
    assert.ok(fs.existsSync(path.join(outDir, 'secret/only.js')), 'inlined JS stays published while any public HTML remains');
    assert.ok(fs.existsSync(path.join(outDir, 'shared.css')), 'public-referenced CSS must be published');
    assert.match(r.stdout, /omitting 1 asset/);
  });

  it('omits inlined JS when the whole site is encrypted', () => {
    const siteDir = setupSite(dir, {
      'index.html': '<html><head><link rel="stylesheet" href="only2.css"></head><body><script src="only2.js"></script></body></html>',
      'only2.css': 'body{color:red}',
      'only2.js': 'var only2 = 1;',
    });
    const outDir = path.join(dir, 'out-omit-full');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    assert.ok(!fs.existsSync(path.join(outDir, 'only2.css')));
    assert.ok(!fs.existsSync(path.join(outDir, 'only2.js')), 'inlined JS is omitted once no public HTML remains');
    assert.match(r.stdout, /omitting 2 asset/);
  });

  it('keeps inlined JS that a public inline event handler could load', () => {
    const siteDir = setupSite(dir, {
      'secret/page.html': '<html><body><script src="/handler.js"></script></body></html>',
      'handler.js': 'var handler = 1;',
      'public.html': '<html><body onclick="import(\'./handler.js\')">pub</body></html>',
    });
    const outDir = path.join(dir, 'out-onclick');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000', '--html-root', 'secret']);
    assert.equal(r.code, 0);
    assert.ok(fs.existsSync(path.join(outDir, 'handler.js')), 'JS an inline handler could import must be published');
    assert.ok(!r.stdout.includes('omitting'));
  });

  it('keeps an inlined extensionless script that a public inline handler could load', () => {
    const siteDir = setupSite(dir, {
      'secret/page.html': '<html><body><script src="/handler"></script></body></html>',
      'handler': 'var handler = 1;',
      'public.html': '<html><body onclick="import(\'./handler\')">pub</body></html>',
    });
    const outDir = path.join(dir, 'out-onclick-noext');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000', '--html-root', 'secret']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'secret/page.html'), 'utf8')), 'test');
    assert.match(html, /var handler = 1/, 'the extensionless script must still be inlined');
    assert.ok(fs.existsSync(path.join(outDir, 'handler')), 'a file inlined as JS must be published like any other JS');
    assert.ok(!r.stdout.includes('omitting'));
  });

  it('keeps an inlined asset that another protected page references as a module', () => {
    const siteDir = setupSite(dir, {
      'one.html': '<html><body><script src="app.js"></script></body></html>',
      'two.html': '<html><body><script type="module" src="app.js"></script></body></html>',
      'app.js': 'var dual = 1;',
    });
    const outDir = path.join(dir, 'out-dualref');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    assert.ok(fs.existsSync(path.join(outDir, 'app.js')), 'module-referenced asset must stay published');
    assert.match(r.stderr, /module script cannot be inlined/);
  });

  it('warns about references it leaves in the page', () => {
    const siteDir = setupSite(dir, {
      'warn.html':
        '<html><head><link rel="stylesheet" href="missing.css"></head>' +
        '<body><script src="https://cdn.example.com/lib.js"></script></body></html>',
    });
    const outDir = path.join(dir, 'out-warn');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.match(r.stderr, /warn\.html: missing\.css: stylesheet not found/);
    assert.match(r.stderr, /warn\.html: https:\/\/cdn\.example\.com\/lib\.js: external script will be blocked/);
  });

  it('warns that --no-inline leaves script src blocked', () => {
    const siteDir = setupSite(dir, {
      'ni.html': '<html><body><script src="local.js"></script></body></html>',
      'local.js': 'var x = 1;',
    });
    const outDir = path.join(dir, 'out-ni-warn');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000', '--no-inline']);
    assert.match(r.stderr, /ni\.html: local\.js: script src remains in the page and will be blocked by the page CSP/);
  });

  it('rejects non-UTF-8 HTML input and leaves no output behind', () => {
    const siteDir = setupSite(dir, {
      'good.html': '<html><body>ok</body></html>',
      'bad.html': Buffer.concat([Buffer.from('<html><body>'), Buffer.from([0xff, 0xfe, 0x80]), Buffer.from('</body></html>')]),
    });
    const outDir = path.join(dir, 'out-notutf8');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not valid UTF-8: bad\.html/);
    assert.ok(!fs.existsSync(outDir));
    assert.deepEqual(fs.readdirSync(dir).filter((f) => f.startsWith('out-notutf8.veil-')), []);
  });

  it('rejects non-UTF-8 inlined CSS', () => {
    const siteDir = setupSite(dir, {
      'latin.html': '<html><head><link rel="stylesheet" href="latin1.css"></head><body>x</body></html>',
      'latin1.css': Buffer.from([0x62, 0x6f, 0x64, 0x79, 0x7b, 0x7d, 0x2f, 0x2a, 0xe9, 0x2a, 0x2f]),
    });
    const outDir = path.join(dir, 'out-notutf8-css');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /not valid UTF-8: latin1\.css \(inlined by latin\.html\)/);
  });

  it('round-trips non-ASCII UTF-8 content exactly', () => {
    const original = '<html><head><title>Café ☕</title></head><body>中文 émoji 🎉</body></html>';
    const siteDir = setupSite(dir, { 'utf8.html': original });
    const outDir = path.join(dir, 'out-utf8');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'utf8.html'), 'utf8')), 'test');
    assert.equal(html, original);
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

  it('removes only the src attribute when inlining a script', () => {
    const siteDir = setupSite(dir, {
      'ds.html': '<html><body><script data-src="lazy.js" src="app.js"></script></body></html>',
      'app.js': 'var inlinedApp = 1;',
      'lazy.js': 'var lazy = 1;',
    });
    const outDir = path.join(dir, 'out-datasrc');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'ds.html'), 'utf8')), 'test');
    assert.match(html, /var inlinedApp = 1/);
    assert.ok(!html.includes('src="app.js"'), 'inlined src must be gone');
    assert.match(html, /data-src="lazy\.js"/, 'data-src must survive intact');
    assert.ok(fs.existsSync(path.join(outDir, 'lazy.js')), 'unrelated asset must still be published');
  });

  it('ignores attribute-like text inside another attribute value', () => {
    const siteDir = setupSite(dir, {
      'dec.html': '<html><body><script data-x="src=\'decoy.js\'" src="real.js"></script></body></html>',
      'real.js': 'var real = 1;',
      'decoy.js': 'var decoy = 1;',
    });
    const outDir = path.join(dir, 'out-decoy');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'dec.html'), 'utf8')), 'test');
    assert.match(html, /var real = 1/);
    assert.ok(!html.includes('real.js'), 'the real script reference must be gone');
    assert.match(html, /data-x="src='decoy\.js'"/, 'the decoy attribute must be untouched');
    assert.equal(fs.readFileSync(path.join(outDir, 'decoy.js'), 'utf8'), 'var decoy = 1;');
  });

  it('ignores tag-shaped text in attributes, comments, and script bodies', () => {
    const decoy = '<link rel="stylesheet" href="fake.css">';
    const siteDir = setupSite(dir, {
      'tok.html':
        '<html><head><link rel="stylesheet" href="realtok.css">' +
        `<!-- <p>disabled</p> ${decoy} -->` +
        `</head><body><div data-template='${decoy}'>d</div>` +
        `<script>const tpl='${decoy}';</script>` +
        '<script src="realtok.js"></script></body></html>',
      'realtok.css': 'body{color:maroon}',
      'realtok.js': 'var realTok = 1;',
      'fake.css': ".q::before{content:'x'}",
    });
    const outDir = path.join(dir, 'out-tokenizer');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'tok.html'), 'utf8')), 'test');
    assert.ok(html.includes(`<!-- <p>disabled</p> ${decoy} -->`), 'a comment must be byte-identical');
    assert.ok(html.includes(`<div data-template='${decoy}'>`), 'an attribute value must be byte-identical');
    assert.ok(html.includes(`<script>const tpl='${decoy}';</script>`), 'a script body must be byte-identical');
    assert.ok(!html.includes("content:'x'"), 'the decoy stylesheet must never be inlined');
    assert.match(html, /<style>body\{color:maroon\}<\/style>/, 'the real link must still be inlined');
    assert.match(html, /var realTok = 1/, 'the real script must still be inlined');
    assert.ok(fs.existsSync(path.join(outDir, 'fake.css')), 'the decoy target must not be treated as inlined');
  });

  it('leaves protected-page noscript content byte-identical', () => {
    // With scripting enabled (always true on a decrypted Veil page) noscript
    // content is raw text ending at the first </noscript>. Inlining inside it
    // could push author bytes out into active markup: fallback.css below
    // contains a CSS string with "</noscript>" that must never become a tag.
    const noscriptBlock = '<noscript><link rel="stylesheet" href="fallback.css"></noscript>';
    const siteDir = setupSite(dir, {
      'ns.html': `<html><head>${noscriptBlock}<link rel="stylesheet" href="real.css"></head><body>x</body></html>`,
      'fallback.css': '.x{content:"</noscript><div id=escaped>escaped</div>"}',
      'real.css': 'body{color:crimson}',
    });
    const outDir = path.join(dir, 'out-noscript');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'ns.html'), 'utf8')), 'test');
    assert.ok(html.includes(noscriptBlock), 'noscript content must be byte-identical');
    assert.ok(!html.includes('id=escaped'), 'CSS bytes must not escape into markup');
    assert.match(html, /color:crimson/, 'real link outside noscript still inlines');
    assert.ok(fs.existsSync(path.join(outDir, 'fallback.css')), 'noscript fallback asset must stay published');
  });

  it('keeps assets referenced only from public noscript blocks', () => {
    const siteDir = setupSite(dir, {
      'secret/page.html': '<html><head><link rel="stylesheet" href="../fb.css"></head><body>x</body></html>',
      'public.html': '<html><head><noscript><link rel="stylesheet" href="fb.css"></noscript></head><body>pub</body></html>',
      'fb.css': 'body{color:plum}',
    });
    const outDir = path.join(dir, 'out-noscript-pub');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000', '--html-root', 'secret']);
    assert.equal(r.code, 0);
    assert.ok(fs.existsSync(path.join(outDir, 'fb.css')), 'public noscript reference must keep the asset');
  });

  it('treats textarea content as text, not markup', () => {
    const decoy = '<link rel="stylesheet" href="tafake.css">';
    const siteDir = setupSite(dir, {
      'ta.html':
        `<html><head><link rel="stylesheet" href="tareal.css"></head>` +
        `<body><textarea>${decoy}</textarea></body></html>`,
      'tareal.css': 'body{color:purple}',
      'tafake.css': ".q::before{content:'ta'}",
    });
    const outDir = path.join(dir, 'out-textarea');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'ta.html'), 'utf8')), 'test');
    assert.ok(html.includes(`<textarea>${decoy}</textarea>`), 'textarea content must be byte-identical');
    assert.match(html, /<style>body\{color:purple\}<\/style>/, 'the real link must still be inlined');
    assert.ok(fs.existsSync(path.join(outDir, 'tafake.css')), 'the decoy target must not be treated as inlined');
  });

  it('treats title content as text, not markup', () => {
    const decoy = '<link rel="stylesheet" href="tifake.css">';
    const siteDir = setupSite(dir, {
      'ti.html':
        `<html><head><title>${decoy}</title>` +
        `<link rel="stylesheet" href="tireal.css"></head><body>x</body></html>`,
      'tireal.css': 'body{color:olive}',
      'tifake.css': ".q::before{content:'ti'}",
    });
    const outDir = path.join(dir, 'out-title');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'ti.html'), 'utf8')), 'test');
    assert.ok(html.includes(`<title>${decoy}</title>`), 'title content must be byte-identical');
    assert.match(html, /<style>body\{color:olive\}<\/style>/, 'the real link must still be inlined');
    assert.ok(fs.existsSync(path.join(outDir, 'tifake.css')), 'the decoy target must not be treated as inlined');
  });

  it('treats raw-text elements and text after <plaintext> as text', () => {
    const decoy = '<link rel="stylesheet" href="rawfake.css">';
    const body = `<xmp>${decoy}</xmp><noframes>${decoy}</noframes><plaintext>${decoy}`;
    const siteDir = setupSite(dir, {
      'raw.html':
        `<html><head><link rel="stylesheet" href="rawreal.css"></head><body>${body}</body></html>`,
      'rawreal.css': 'body{color:navy}',
      'rawfake.css': ".q::before{content:'raw'}",
    });
    const outDir = path.join(dir, 'out-rawtext');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'raw.html'), 'utf8')), 'test');
    assert.ok(html.includes(body), 'raw-text and plaintext content must be byte-identical');
    assert.match(html, /<style>body\{color:navy\}<\/style>/, 'the real link must still be inlined');
    assert.ok(fs.existsSync(path.join(outDir, 'rawfake.css')), 'the decoy target must not be treated as inlined');
  });

  it('publishes assets reachable through public CSS @import chains', () => {
    const siteDir = setupSite(dir, {
      'secret/page.html':
        '<html><head><link rel="stylesheet" href="/shared.css">' +
        '<link rel="stylesheet" href="/b.css"></head><body>x</body></html>',
      'shared.css': 'body{color:red}',
      'b.css': 'p{color:blue}',
      'a.css': '@import "b.css";',
      'public.css': '@import "shared.css";\n@import "a.css";',
      'public.html': '<html><head><link rel="stylesheet" href="public.css"></head><body>pub</body></html>',
    });
    const outDir = path.join(dir, 'out-cssimport');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000', '--html-root', 'secret']);
    assert.equal(r.code, 0);
    assert.ok(fs.existsSync(path.join(outDir, 'shared.css')), 'CSS imported by a public stylesheet must be published');
    assert.ok(fs.existsSync(path.join(outDir, 'b.css')), 'CSS reachable through an import chain must be published');
  });

  it('publishes assets referenced by an inline <style> in a public page', () => {
    const siteDir = setupSite(dir, {
      'secret/page.html': '<html><head><link rel="stylesheet" href="/theme.css"></head><body>x</body></html>',
      'theme.css': 'body{background:url(/pattern.png)}',
      'pattern.png': 'png',
      'public.html': '<html><head><style>@import "theme.css";</style></head><body>pub</body></html>',
    });
    const outDir = path.join(dir, 'out-inlinestyle');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000', '--html-root', 'secret']);
    assert.equal(r.code, 0);
    assert.ok(fs.existsSync(path.join(outDir, 'theme.css')), 'CSS imported by an inline <style> must be published');
  });

  it('leaves CSS strings and comments untouched while rewriting real urls', () => {
    const siteDir = setupSite(dir, {
      'sub/page.html': '<html><head><link rel="stylesheet" href="../css/lex.css"></head><body>x</body></html>',
      'css/lex.css':
        '.x::before{content:"url(icon.png)"}\n' +
        '/* url(fake.png) and @import "fake.css"; */\n' +
        '.y{background:url(real.png)}\n' +
        '@font-face{src:url(font.woff) format("woff")}',
      'css/real.png': 'png',
      'css/font.woff': 'woff',
    });
    const outDir = path.join(dir, 'out-csslex');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'sub/page.html'), 'utf8')), 'test');
    assert.match(html, /\.x::before\{content:"url\(icon\.png\)"\}/, 'string literal must be byte-identical');
    assert.match(html, /\/\* url\(fake\.png\) and @import "fake\.css"; \*\//, 'comment must be byte-identical');
    assert.match(html, /url\("\.\.\/css\/real\.png"\)/, 'real url\\(\\) must be rewritten');
    assert.match(html, /url\("\.\.\/css\/font\.woff"\) format\("woff"\)/);
    for (const noise of ['icon.png', 'fake.png', 'fake.css']) {
      assert.ok(!r.stderr.includes(noise), `${noise} must not be treated as a reference`);
    }
  });

  it('percent-encodes rewritten CSS paths and keeps the query and fragment', () => {
    const siteDir = setupSite(dir, {
      'sub/page.html': '<html><head><link rel="stylesheet" href="../css/enc.css"></head><body>x</body></html>',
      'css/enc.css': '.i{background:url("icon%23x.png?v=1#frag")}',
      'css/icon#x.png': 'png',
    });
    const outDir = path.join(dir, 'out-cssenc');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'sub/page.html'), 'utf8')), 'test');
    assert.match(html, /url\("\.\.\/css\/icon%23x\.png\?v=1#frag"\)/);
    assert.ok(fs.existsSync(path.join(outDir, 'css/icon#x.png')), 'the referenced file must be published');
  });

  it('warns about a script src with a body and keeps the file published', () => {
    const siteDir = setupSite(dir, {
      'body.html': '<html><body><script src="app.js">fallback</script></body></html>',
      'app.js': 'var app = 1;',
    });
    const outDir = path.join(dir, 'out-scriptbody');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /body\.html: app\.js: script src remains in the page and will be blocked by the page CSP/);
    assert.ok(fs.existsSync(path.join(outDir, 'app.js')), 'a script that was not inlined must stay published');
  });

  it('warns about an external @import but not about external url()', () => {
    const siteDir = setupSite(dir, {
      'ext.html': '<html><head><link rel="stylesheet" href="ext.css"></head><body>x</body></html>',
      'ext.css': '@import "https://cdn.example.com/theme.css";\nbody{background:url(https://cdn.example.com/bg.png)}',
    });
    const outDir = path.join(dir, 'out-extimport');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /ext\.css → https:\/\/cdn\.example\.com\/theme\.css: external CSS reference left as-is/);
    assert.ok(!r.stderr.includes('bg.png'), 'external images must not be warned about');
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'ext.html'), 'utf8')), 'test');
    assert.match(html, /@import "https:\/\/cdn\.example\.com\/theme\.css";/);
  });

  it('inlines tags whose earlier attribute value contains ">"', () => {
    const siteDir = setupSite(dir, {
      'gt.html':
        '<html><head><link rel="stylesheet" title="x>y" href="gt.css"></head>' +
        '<body><script data-note="a>b" src="gt.js"></script></body></html>',
      'gt.css': 'body{color:fuchsia}',
      'gt.js': 'var gtApp = 1;',
    });
    const outDir = path.join(dir, 'out-gt');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'gt.html'), 'utf8')), 'test');
    assert.match(html, /<style>body\{color:fuchsia\}/);
    assert.ok(!html.includes('href="gt.css"'), 'the stylesheet reference must be gone');
    assert.match(html, /var gtApp = 1/);
    assert.ok(!html.includes('src="gt.js"'), 'the script reference must be gone');
    assert.match(html, /data-note="a>b"/, 'the quoted ">" attribute must survive intact');
  });

  it('omits an asset inlined through a tag with a quoted ">" on every page', () => {
    const siteDir = setupSite(dir, {
      'secret/a.html': '<html><body><script src="/gtshared.js"></script></body></html>',
      'secret/b.html': '<html><body><script data-note="a>b" src="/gtshared.js"></script></body></html>',
      'gtshared.js': 'var gtShared = 1;',
    });
    const outDir = path.join(dir, 'out-gt-omit');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000', '--html-root', 'secret']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'secret/b.html'), 'utf8')), 'test');
    assert.match(html, /var gtShared = 1/, 'the truncated tag must still be inlined');
    assert.ok(!html.includes('src="/gtshared.js"'));
    assert.ok(!fs.existsSync(path.join(outDir, 'gtshared.js')), 'inlined-everywhere JS must not be published');
    assert.match(r.stdout, /omitting 1 asset/);
  });

  it('keeps inlined JS when public JavaScript could import it', () => {
    const siteDir = setupSite(dir, {
      'secret/page.html':
        '<html><head><link rel="stylesheet" href="/priv.css"></head>' +
        '<body><script src="/shared.js"></script></body></html>',
      'shared.js': 'var shared = 1;',
      'priv.css': 'body{color:red}',
      'public.html': '<html><body><script type="module" src="public.js"></script></body></html>',
      'public.js': 'import "./shared.js";',
    });
    const outDir = path.join(dir, 'out-publicjs');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000', '--html-root', 'secret']);
    assert.equal(r.code, 0);
    assert.ok(fs.existsSync(path.join(outDir, 'shared.js')), 'JS a public module could import must be published');
    assert.ok(fs.existsSync(path.join(outDir, 'public.js')));
    assert.ok(!fs.existsSync(path.join(outDir, 'priv.css')), 'unreferenced inlined CSS is still omitted');
    assert.match(r.stdout, /omitting 1 asset/);
  });

  it('resolves CSS escapes when rewriting url() references', () => {
    const siteDir = setupSite(dir, {
      'sub/page.html': '<html><head><link rel="stylesheet" href="../css/esc.css"></head><body>x</body></html>',
      'css/esc.css': '.a{background:url("my\\ icon.png")}\n.b{background:url(my\\ icon.png)}',
      'css/my icon.png': 'png',
    });
    const outDir = path.join(dir, 'out-cssescape');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'sub/page.html'), 'utf8')), 'test');
    const hits = html.match(/url\("\.\.\/css\/my%20icon\.png"\)/g) || [];
    assert.equal(hits.length, 2, 'quoted and unquoted escaped urls must both be rewritten');
    assert.ok(fs.existsSync(path.join(outDir, 'css/my icon.png')), 'the escaped reference must be published');
  });

  it('resolves a hex escape in an unquoted url()', () => {
    const siteDir = setupSite(dir, {
      'sub/page.html': '<html><head><link rel="stylesheet" href="../css/hex.css"></head><body>x</body></html>',
      'css/hex.css': '.a{background:url(my\\20 icon.png)}',
      'css/my icon.png': 'png',
    });
    const outDir = path.join(dir, 'out-csshex');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'sub/page.html'), 'utf8')), 'test');
    assert.match(html, /url\("\.\.\/css\/my%20icon\.png"\)/);
    assert.ok(fs.existsSync(path.join(outDir, 'css/my icon.png')), 'the escaped reference must be published');
  });

  it('treats CRLF after a hex escape as one terminator', () => {
    const siteDir = setupSite(dir, {
      'sub/page.html': '<html><head><link rel="stylesheet" href="../css/crlf.css"></head><body>x</body></html>',
      'css/crlf.css': '.a{background:url(my\\20\r\nicon.png)}',
      'css/my icon.png': 'png',
    });
    const outDir = path.join(dir, 'out-csscrlf');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'sub/page.html'), 'utf8')), 'test');
    assert.match(html, /url\("\.\.\/css\/my%20icon\.png"\)/);
    assert.ok(fs.existsSync(path.join(outDir, 'css/my icon.png')), 'the escaped reference must be published');
  });

  it('treats an escaped newline in a url string as a line continuation', () => {
    const siteDir = setupSite(dir, {
      'sub/page.html': '<html><head><link rel="stylesheet" href="../css/cont.css"></head><body>x</body></html>',
      'css/cont.css': '.a{background:url("my\\\nicon.png")}',
      'css/myicon.png': 'png',
    });
    const outDir = path.join(dir, 'out-csscont');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'sub/page.html'), 'utf8')), 'test');
    assert.match(html, /url\("\.\.\/css\/myicon\.png"\)/);
    assert.ok(fs.existsSync(path.join(outDir, 'css/myicon.png')), 'the continued reference must be published');
  });

  it('rewrites @import without a separator and ignores it inside a block', () => {
    const siteDir = setupSite(dir, {
      'sub/page.html': '<html><head><link rel="stylesheet" href="../css/imp.css"></head><body>x</body></html>',
      'css/imp.css':
        '@import"a.css";\n' +
        '@import/**/"b.css";\n' +
        ':root{--x: @import "c.css";}\n' +
        '@media print{@import "e.css";}',
      'css/a.css': 'a{}',
      'css/b.css': 'b{}',
      'css/e.css': 'e{}',
    });
    const outDir = path.join(dir, 'out-importsep');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'sub/page.html'), 'utf8')), 'test');
    assert.match(html, /@import"\.\.\/css\/a\.css";/);
    assert.match(html, /@import\/\*\*\/"\.\.\/css\/b\.css";/);
    assert.ok(html.includes(':root{--x: @import "c.css";}'), 'a declaration value must be byte-identical');
    assert.ok(html.includes('@media print{@import "e.css";}'), 'a nested @import is invalid CSS and is left alone');
    assert.ok(!r.stderr.includes('c.css'), 'a declaration value must not be treated as a reference');
    assert.ok(fs.existsSync(path.join(outDir, 'css/a.css')));
    assert.ok(fs.existsSync(path.join(outDir, 'css/b.css')));
  });

  it('escapes the query string of a rewritten url', () => {
    const siteDir = setupSite(dir, {
      'sub/page.html': '<html><head><link rel="stylesheet" href="../css/q.css"></head><body>x</body></html>',
      'css/q.css': '.i{background:url("icon.png?q=\\"x\\"&y=(z)&n=\'")}',
      'css/icon.png': 'png',
    });
    const outDir = path.join(dir, 'out-cssquery');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'sub/page.html'), 'utf8')), 'test');
    assert.match(html, /url\("\.\.\/css\/icon\.png\?q=%22x%22&y=%28z%29&n=%27"\)/);
    assert.ok(!html.includes('q="x"'), 'a raw quote must not survive inside the emitted url');
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

  it('produces valid HTML with CSP, noindex, and hidden prompt', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const outDir = path.join(dir, 'out-wrapper');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const wrapper = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    assert.match(wrapper, /<!DOCTYPE html>/);
    assert.match(wrapper, /Content-Security-Policy/);
    assert.match(wrapper, /default-src 'none'/);
    assert.match(wrapper, /img-src 'self' data:/);
    assert.match(wrapper, /base-uri 'self'/);
    assert.match(wrapper, /name="robots" content="noindex,nofollow,noarchive"/);
    // Prompt starts hidden so cached auto-unlock never flashes it
    assert.match(wrapper, /class="veil-prompt veil-hidden"/);
    assert.match(wrapper, /veil-payload/);
    assert.match(wrapper, /veil-form/);
  });

  it('does not leak the source page title into the wrapper', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><head><title>Acme acquisition proposal</title></head><body>x</body></html>' });
    const outDir = path.join(dir, 'out-title');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const wrapper = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    assert.ok(!wrapper.includes('Acme'), 'source title must not appear in the public wrapper');
    assert.match(wrapper, /<title>Protected page<\/title>/);
    // The real title is restored from the decrypted document itself
    const html = decryptPayload(extractPayload(wrapper), 'test');
    assert.match(html, /<title>Acme acquisition proposal<\/title>/);
  });

  it('embeds script payload as valid JSON, not HTML-escaped JSON', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><head><title>Quote " Test</title></head><body>x & y</body></html>' });
    const outDir = path.join(dir, 'out-json-payload');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const wrapper = fs.readFileSync(path.join(outDir, 'index.html'), 'utf8');
    const match = wrapper.match(/<script id="veil-payload" type="application\/json">([^<]+)<\/script>/);
    assert.ok(match);
    assert.doesNotMatch(match[1], /&quot;|&lt;|&gt;|&amp;/);
    assert.equal(JSON.parse(match[1]).title, 'Protected page');
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
// Module export tests
// ---------------------------------------------------------------------------

describe('module exports', () => {
  it('requiring veil.js does not run the CLI', () => {
    const r = spawnSync(
      process.execPath,
      ['-e', `require(${JSON.stringify(VEIL)}); console.log('ok')`],
      { encoding: 'utf8', timeout: 30000 }
    );
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^ok$/m);
    assert.doesNotMatch(r.stdout, /Usage: veil/);
    assert.equal(r.stderr, '');
  });

  it('extractPayload returns null for HTML that carries no valid payload', () => {
    assert.equal(extractPayload('<html><body>not a wrapper</body></html>'), null);
    assert.equal(
      extractPayload('<script id="veil-payload" type="application/json">{oops</script>'),
      null
    );
  });
});
