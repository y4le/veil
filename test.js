#!/usr/bin/env node
'use strict';

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
// Tests decrypt with the real implementation, not a copy of it.
const { extractPayload, decryptPayload, validatePayload } = require('./veil.js');

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

  it('rejects an iteration count that is not a whole number', () => {
    const dir = tmpDir();
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const r = run([siteDir, path.join(dir, 'out'), '--passphrase', 'test', '--iterations', '100000junk']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /positive integer/);
    cleanup(dir);
  });

  it('does not take a following option as an option value', () => {
    const dir = tmpDir();
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const r = run([siteDir, path.join(dir, 'out'), '--passphrase', 'test', '--iterations', '--remember']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--iterations/);
    cleanup(dir);
  });

  it('rejects extra positional arguments', () => {
    const dir = tmpDir();
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const r = run([siteDir, path.join(dir, 'out'), 'extra', '--passphrase', 'test']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /Unexpected argument: extra/);
    cleanup(dir);
  });

  it('rejects an explicitly empty --passphrase instead of prompting', () => {
    const dir = tmpDir();
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const r = run([siteDir, path.join(dir, 'out'), '--passphrase', '', '--iterations', '100000']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /cannot be empty/);
    cleanup(dir);
  });

  it('prints the version with --version', () => {
    const r = run(['--version']);
    assert.equal(r.code, 0);
    assert.match(r.stdout.trim(), /^veil \d+\.\d+\.\d+$/);
  });

  it('warns that --passphrase is visible to other processes', () => {
    const dir = tmpDir();
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const r = run([siteDir, path.join(dir, 'out-warn-pass'), '--passphrase', 'test', '--iterations', '600000']);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /warning: --passphrase is visible in process listings/);
    cleanup(dir);
  });

  it('warns when the iteration count is below the default', () => {
    const dir = tmpDir();
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const r = run([siteDir, path.join(dir, 'out-warn-iter'), '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /warning: 100000 PBKDF2 iterations is below the default 600000/);
    cleanup(dir);
  });

  it('warns when the site id inferred from the output directory is generic', () => {
    const dir = tmpDir();
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const r = run([siteDir, path.join(dir, 'dist'), '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    assert.match(r.stderr, /warning: inferred site id "dist" is generic/);
    cleanup(dir);
  });

  it('does not warn about a generic output directory name when --id is given', () => {
    const dir = tmpDir();
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const r = run([siteDir, path.join(dir, 'dist'), '--passphrase', 'test', '--iterations', '100000', '--id', 'my-project']);
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stderr, /is generic/);
    cleanup(dir);
  });

  it('reads a piped passphrase without printing a prompt', () => {
    const dir = tmpDir();
    const siteDir = setupSite(dir, { 'index.html': '<html><body>piped</body></html>' });
    const outDir = path.join(dir, 'out-piped');
    const r = run([siteDir, outDir, '--iterations', '100000'], { input: 'mypass\n' });
    assert.equal(r.code, 0);
    assert.doesNotMatch(r.stdout, /Passphrase:/);
    const payload = extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'));
    assert.match(decryptPayload(payload, 'mypass'), /piped/);
    cleanup(dir);
  });

  it('rejects an explicitly empty --id', () => {
    const dir = tmpDir();
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const r = run([siteDir, path.join(dir, 'out-empty-id'), '--passphrase', 'test', '--iterations', '100000', '--id', '']);
    assert.equal(r.code, 1);
    assert.match(r.stderr, /--id must not be empty/);
    cleanup(dir);
  });

  it('exits after the piped passphrase line even if the pipe stays open', async () => {
    // rl.close() alone leaves stdin holding the event loop: a programmatic
    // caller that satisfies the one-line protocol but keeps its write end
    // open would wait forever for the child to exit.
    const { spawn } = require('child_process');
    const dir = tmpDir();
    const siteDir = setupSite(dir, { 'index.html': '<html><body>openpipe</body></html>' });
    const outDir = path.join(dir, 'out-open-pipe');
    const child = spawn(process.execPath, [VEIL, siteDir, outDir, '--iterations', '100000'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    child.stdin.write('open-pass\n'); // note: no end() — the pipe stays open
    const code = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error('veil did not exit while the stdin pipe stayed open'));
      }, 10000);
      child.on('exit', (c) => {
        clearTimeout(timer);
        resolve(c);
      });
    });
    assert.equal(code, 0);
    const payload = extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'));
    assert.match(decryptPayload(payload, 'open-pass'), /openpipe/);
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
    for (const [name, marker] of [['SECRET.HTML', 'UPPER SECRET'], ['Report.HtM', 'MIXED SECRET']]) {
      const content = fs.readFileSync(path.join(outDir, name), 'utf8');
      assert.ok(!content.includes(marker), `${name} must not contain plaintext`);
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

  // Confinement tests point at files that really exist outside the input
  // root. A reference to a path that does not exist proves nothing: the
  // resolver fails on the missing file long before the confinement check, so
  // such a test passes even with the check deleted.
  it('blocks traversal to a real file outside the input root', () => {
    const secret = path.join(dir, 'outside-secret.css');
    fs.writeFileSync(secret, 'body{--secret:LEAKME}');
    const siteDir = setupSite(dir, {
      'index.html': '<html><head><link rel="stylesheet" href="../outside-secret.css"></head><body>x</body></html>',
    });
    // The reference must actually reach the sentinel, or the rest is vacuous.
    assert.equal(
      fs.realpathSync(path.resolve(siteDir, '../outside-secret.css')),
      fs.realpathSync(secret),
      'fixture layout must put the sentinel exactly one level above the input root'
    );
    const outDir = path.join(dir, 'out-traversal-real');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8')), 'test');
    assert.ok(!html.includes('LEAKME'), 'a file outside the input root must never be inlined');
    assert.match(html, /href="\.\.\/outside-secret\.css"/, 'the reference is left untouched');
    assert.match(r.stderr, /\.\.\/outside-secret\.css: stylesheet not found inside the input directory/);
    assert.ok(!fs.existsSync(path.join(outDir, 'outside-secret.css')), 'the sentinel must not be copied out');
  });

  it('blocks root-relative traversal escaping the input root', () => {
    const secret = path.join(dir, 'outside-secret.css');
    fs.writeFileSync(secret, 'body{--secret:LEAKME}');
    const siteDir = setupSite(dir, {
      'index.html': '<html><head><link rel="stylesheet" href="/../outside-secret.css"></head><body>x</body></html>',
    });
    // Root-relative hrefs resolve against the input root, so this one lands on
    // the sentinel just above it.
    assert.equal(
      fs.realpathSync(path.join(siteDir, '../outside-secret.css')),
      fs.realpathSync(secret),
      'fixture layout must put the sentinel exactly one level above the input root'
    );
    const outDir = path.join(dir, 'out-traversal-rootrel');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8')), 'test');
    assert.ok(!html.includes('LEAKME'), 'a root-relative escape must never be inlined');
    assert.match(html, /href="\/\.\.\/outside-secret\.css"/, 'the reference is left untouched');
    assert.match(r.stderr, /\/\.\.\/outside-secret\.css: stylesheet not found inside the input directory/);
    assert.ok(!fs.existsSync(path.join(outDir, 'outside-secret.css')), 'the sentinel must not be copied out');
  });

  it('does not confuse a sibling directory sharing the input root prefix', () => {
    // <parent>/site and <parent>/site-secrets: the root's path is a string
    // prefix of the sibling's, so a startsWith() containment check would call
    // the sibling "inside" the root.
    const parent = fs.mkdtempSync(path.join(dir, 'prefix-'));
    const inputDir = path.join(parent, 'site');
    const sibling = path.join(parent, 'site-secrets');
    fs.mkdirSync(inputDir);
    fs.mkdirSync(sibling);
    fs.writeFileSync(path.join(sibling, 'secret.css'), 'body{--secret:LEAKME}');
    fs.writeFileSync(
      path.join(inputDir, 'index.html'),
      '<html><head><link rel="stylesheet" href="../site-secrets/secret.css"></head><body>x</body></html>'
    );
    assert.ok(fs.existsSync(path.resolve(inputDir, '../site-secrets/secret.css')), 'the sentinel must be reachable');
    const outDir = path.join(parent, 'out');
    const r = run([inputDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8')), 'test');
    assert.ok(!html.includes('LEAKME'), 'a prefix-sharing sibling is still outside the input root');
    assert.match(html, /href="\.\.\/site-secrets\/secret\.css"/);
    assert.match(r.stderr, /site-secrets\/secret\.css: stylesheet not found inside the input directory/);
    assert.ok(!fs.existsSync(path.join(outDir, 'secret.css')), 'the sentinel must not be copied out');
  });

  it('inlines a file whose name merely starts with dots', () => {
    // "sub/..weird.css" is an ordinary file inside the root; only its name
    // begins with dots. Confinement must compare resolved paths, not hunt for
    // ".." as a substring.
    const siteDir = setupSite(dir, {
      'index.html': '<html><head><link rel="stylesheet" href="sub/..weird.css"></head><body>x</body></html>',
      'sub/..weird.css': 'body{color:fuchsia}',
    });
    const outDir = path.join(dir, 'out-dotname');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8')), 'test');
    assert.match(html, /<style>body\{color:fuchsia\}/);
    assert.ok(!html.includes('href="sub/..weird.css"'));
  });

  it('inlines a root-level file whose name starts with dots', () => {
    const siteDir = setupSite(dir, {
      'index.html': '<html><head><link rel="stylesheet" href="..weird.css"></head><body>x</body></html>',
      '..weird.css': 'body{color:fuchsia}',
    });
    const outDir = path.join(dir, 'out-dotname-root');
    const r = run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    assert.equal(r.code, 0);
    const html = decryptPayload(extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8')), 'test');
    assert.match(html, /<style>body\{color:fuchsia\}/);
    assert.ok(!html.includes('href="..weird.css"'));
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
    assert.equal(payload.v, 2);
    assert.equal(payload.siteId, 'my-site');
    assert.equal(payload.iterations, 200000);
    assert.equal(payload.remember, false);
    assert.equal(payload.path, 'index.html');
    assert.ok(!('title' in payload), 'v2 payloads have no title field');
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

  it('rejects ct/iv swapped between pages of the same site (path binding)', () => {
    const siteDir = setupSite(dir, {
      'index.html': '<html><body>page one</body></html>',
      'about.html': '<html><body>page two</body></html>',
    });
    const outDir = path.join(dir, 'out-swap');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const p1 = extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'));
    const p2 = extractPayload(fs.readFileSync(path.join(outDir, 'about.html'), 'utf8'));
    // Moving another page's ciphertext+IV into this payload must fail: the
    // page AAD binds the ciphertext to its own output path.
    const swapped = { ...p1, ct: p2.ct, iv: p2.iv };
    assert.throws(() => decryptPayload(swapped, 'test'));
    // Boundary (documented): copying the whole authenticated tuple
    // {path, ct, iv} reproduces the other page's sealed identity and
    // decrypts — indistinguishable from copying the whole file. AEAD does
    // not prevent whole-artifact substitution or rollback.
    const tupleCopy = { ...p1, path: p2.path, ct: p2.ct, iv: p2.iv };
    assert.match(decryptPayload(tupleCopy, 'test'), /page two/);
  });

  it('validatePayload accepts a real payload and rejects field corruption', () => {
    const siteDir = setupSite(dir, { 'index.html': '<html><body>x</body></html>' });
    const outDir = path.join(dir, 'out-validate');
    run([siteDir, outDir, '--passphrase', 'test', '--iterations', '100000']);
    const payload = extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'));
    assert.deepEqual(validatePayload(payload), []);

    const cases = [
      [{ v: 0 }, /v must be/],
      [{ siteId: '' }, /siteId/],
      [{ path: '' }, /path/],
      [{ iterations: 99999 }, /iterations/],
      [{ iterations: 100000.5 }, /iterations/],
      [{ remember: 'yes' }, /remember/],
      [{ salt: Buffer.alloc(8).toString('base64') }, /salt must be 16 bytes/],
      [{ wrapIv: Buffer.alloc(11).toString('base64') }, /wrapIv/],
      [{ wrappedMk: Buffer.alloc(47).toString('base64') }, /wrappedMk/],
      [{ iv: 'AAAA AAAA' }, /iv is not canonical base64/],
      [{ ct: Buffer.alloc(15).toString('base64') }, /ct must be at least 16 bytes/],
      [{ ct: 42 }, /ct must be a base64 string/],
    ];
    for (const [patch, re] of cases) {
      const errors = validatePayload({ ...payload, ...patch });
      assert.ok(errors.some((e) => re.test(e)), `expected ${re} in ${JSON.stringify(errors)}`);
    }
    assert.throws(() => decryptPayload({ ...payload, salt: 'short' }, 'test'), /invalid payload/);
  });

  it('decrypts v1 payloads under their legacy AAD', () => {
    // Hand-build a v1 payload the way the v1 tool did: one colon-delimited
    // AAD shared by the wrap and page domains, title field present, no path.
    const nodeCrypto = require('crypto');
    const aad = Buffer.from('veil:v1:legacy-site');
    const mk = nodeCrypto.randomBytes(32);
    const salt = nodeCrypto.randomBytes(16);
    const kek = nodeCrypto.pbkdf2Sync('legacy-pass', salt, 100000, 32, 'sha256');
    const wrapIv = nodeCrypto.randomBytes(12);
    const wrapC = nodeCrypto.createCipheriv('aes-256-gcm', kek, wrapIv);
    wrapC.setAAD(aad);
    const wrappedMk = Buffer.concat([wrapC.update(mk), wrapC.final(), wrapC.getAuthTag()]);
    const iv = nodeCrypto.randomBytes(12);
    const pageC = nodeCrypto.createCipheriv('aes-256-gcm', mk, iv);
    pageC.setAAD(aad);
    const ct = Buffer.concat([pageC.update('<html><body>legacy</body></html>', 'utf8'), pageC.final(), pageC.getAuthTag()]);
    const payload = {
      v: 1,
      siteId: 'legacy-site',
      salt: salt.toString('base64'),
      iterations: 100000,
      wrappedMk: wrappedMk.toString('base64'),
      wrapIv: wrapIv.toString('base64'),
      remember: false,
      title: 'Old Title',
      ct: ct.toString('base64'),
      iv: iv.toString('base64'),
    };
    assert.match(decryptPayload(payload, 'legacy-pass'), /legacy/);
    // Reading old payloads is Node-API back-compat only: the generated
    // wrapper runtime always builds current-format AADs, so rewrapping a
    // legacy payload must be refused rather than emitting a page that can
    // never unlock.
    const { generateWrapper } = require('./veil.js');
    assert.throws(() => generateWrapper(payload), /only supports format v2/);
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
    assert.equal(JSON.parse(match[1]).path, 'index.html');
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

// ---------------------------------------------------------------------------
// Verify command tests
// ---------------------------------------------------------------------------

describe('verify command', () => {
  let dir;
  const PASS = 'verify-passphrase';
  const SITE_ID = 'verify-site';

  before(() => { dir = tmpDir(); });
  after(() => cleanup(dir));

  /** Build a site and return both trees, asserting the build itself succeeded. */
  function build(files, extraArgs = []) {
    const siteDir = setupSite(dir, files);
    const outDir = fs.mkdtempSync(path.join(dir, 'out-'));
    const r = run([
      siteDir, outDir,
      '--passphrase', PASS, '--iterations', '100000', '--id', SITE_ID,
      ...extraArgs,
    ]);
    assert.equal(r.code, 0, `build failed: ${r.stderr}`);
    return { siteDir, outDir };
  }

  function verify(args) {
    return run(['verify', ...args]);
  }

  /** Run verify in JSON mode; the report must be the only thing on stdout. */
  function report(args) {
    const r = verify([...args, '--json']);
    let parsed;
    try {
      parsed = JSON.parse(r.stdout);
    } catch (err) {
      assert.fail(`stdout is not JSON (${err.message}): ${r.stdout}`);
    }
    return { ...r, report: parsed };
  }

  const codes = (rep) => rep.findings.map((f) => f.code);
  const find = (rep, code) => rep.findings.filter((f) => f.code === code);

  /**
   * Replace a wrapper's payload without going through generateWrapper, for
   * payloads the generator refuses to write (wrong version, broken schema).
   */
  function writeRawPayload(file, payload) {
    const html = fs.readFileSync(file, 'utf8');
    const json = JSON.stringify(payload)
      .replace(/</g, '\\u003C').replace(/>/g, '\\u003E').replace(/&/g, '\\u0026');
    fs.writeFileSync(
      file,
      html.replace(
        /(<script id="veil-payload" type="application\/json">)[^<]+(<\/script>)/,
        (m, open, close) => open + json + close
      )
    );
  }

  const SIMPLE = {
    'index.html': '<html><body><h1>Home</h1></body></html>',
    'about.htm': '<html><body><h1>About</h1></body></html>',
    'blog/post.html': '<html><body><h1>Post</h1></body></html>',
  };

  // -- CLI surface ---------------------------------------------------------

  it('shows verify help and exits 0', () => {
    const r = verify(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /Usage: veil verify <output-dir>/);
    assert.match(r.stdout, /--prompt-passphrase/);
  });

  it('mentions the verify subcommand in the main help', () => {
    const r = run(['--help']);
    assert.equal(r.code, 0);
    assert.match(r.stdout, /veil verify <output-dir>/);
  });

  it('exits 2 when the output directory is missing from the command line', () => {
    const r = verify([]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /requires an output directory/);
  });

  it('exits 2 on an unknown option, an extra positional, or a valueless flag', () => {
    assert.equal(verify(['out', '--nope']).code, 2);
    assert.equal(verify(['out', 'extra']).code, 2);
    assert.equal(verify(['out', '--id']).code, 2);
  });

  it('exits 2 when the output directory does not exist or is a file', () => {
    const missing = verify([path.join(dir, 'no-such-dir')]);
    assert.equal(missing.code, 2);
    assert.match(missing.stderr, /output directory does not exist/);

    const file = path.join(dir, 'a-file');
    fs.writeFileSync(file, 'x');
    const notDir = verify([file]);
    assert.equal(notDir.code, 2);
    assert.match(notDir.stderr, /output path is not a directory/);
  });

  it('exits 2 when the input directory does not exist', () => {
    const { outDir } = build(SIMPLE);
    const r = verify([outDir, '--input', path.join(dir, 'no-such-input')]);
    assert.equal(r.code, 2);
    assert.match(r.stderr, /input directory does not exist/);
  });

  // -- Clean builds --------------------------------------------------------

  it('passes a clean full-site build', () => {
    const { outDir } = build(SIMPLE);
    const r = verify([outDir, '--id', SITE_ID]);
    assert.equal(r.code, 0, r.stdout);
    assert.match(r.stdout, /^PASS/m);
  });

  it('reports a clean build as structured JSON on stdout alone', () => {
    const { outDir } = build(SIMPLE);
    const r = report([outDir, '--id', SITE_ID]);
    assert.equal(r.code, 0);
    assert.equal(r.report.ok, true);
    assert.equal(r.report.reportVersion, 1);
    assert.equal(r.report.stats.encryptedHtml, 3);
    assert.equal(r.report.stats.publicHtml, 0);
    assert.equal(r.report.inputDir, null);
    assert.deepEqual(r.report.scope, { htmlRoots: [], siteId: SITE_ID });
    assert.equal(r.report.checks.decryption.status, 'skipped');
    assert.equal(r.report.checks.correspondence.status, 'skipped');
    assert.equal(r.report.counts.errors, 0);
  });

  it('audits .htm as well as .html', () => {
    const { outDir } = build(SIMPLE);
    const r = report([outDir]);
    const audited = r.report.stats.encryptedHtml;
    assert.equal(audited, 3, 'about.htm must be counted');
  });

  it('reports every path in posix form and sorts findings deterministically', () => {
    const { outDir } = build(SIMPLE);
    fs.writeFileSync(path.join(outDir, 'blog', 'plain.html'), '<html><body>plain</body></html>');
    const first = report([outDir]);
    const second = report([outDir]);
    assert.deepEqual(first.report.findings, second.report.findings);
    for (const f of first.report.findings) {
      if (f.path !== null) assert.doesNotMatch(f.path, /\\/);
    }
    assert.deepEqual(codes(first.report), ['html_not_encrypted', 'iterations_below_default']);
    assert.equal(find(first.report, 'html_not_encrypted')[0].path, 'blog/plain.html');
  });

  // -- Fail-closed scope ---------------------------------------------------

  it('fails when any HTML in scope is unencrypted', () => {
    const { outDir } = build({ ...SIMPLE, 'public/open.html': '<html><body>open</body></html>' },
      ['--html-root', 'blog']);
    const r = report([outDir]);
    assert.equal(r.code, 1);
    assert.equal(r.report.ok, false);
    const unencrypted = find(r.report, 'html_not_encrypted').map((f) => f.path);
    assert.deepEqual(unencrypted, ['about.htm', 'index.html', 'public/open.html']);
  });

  it('accepts public HTML when --html-root declares the protected scope', () => {
    const { outDir } = build({ ...SIMPLE, 'public/open.html': '<html><body>open</body></html>' },
      ['--html-root', 'blog']);
    const r = report([outDir, '--html-root', 'blog']);
    assert.equal(r.code, 0);
    assert.equal(r.report.stats.encryptedHtml, 1);
    assert.equal(r.report.stats.publicHtml, 3);
    assert.deepEqual(
      r.report.publicHtml.map((p) => p.path),
      ['about.htm', 'index.html', 'public/open.html']
    );
    assert.ok(r.report.publicHtml.every((p) => p.allowed));
  });

  it('fails an --html-root that matches nothing, even alongside one that does', () => {
    const { outDir, siteDir } = build(SIMPLE, ['--html-root', 'blog']);
    const r = report([outDir, '--html-root', 'blog', '--html-root', 'blogg']);
    assert.equal(r.code, 1);
    assert.deepEqual(find(r.report, 'html_root_unmatched').length, 1);
    assert.match(find(r.report, 'html_root_unmatched')[0].message, /blogg matches no HTML file in the output tree/);

    const withInput = report([outDir, '--input', siteDir, '--html-root', 'blog', '--html-root', 'blogg']);
    assert.match(
      find(withInput.report, 'html_root_unmatched')[0].message,
      /blogg matches no HTML file in the input tree/
    );
  });

  it('fails an output directory with no HTML at all', () => {
    const empty = fs.mkdtempSync(path.join(dir, 'empty-'));
    const r = report([empty]);
    assert.equal(r.code, 1);
    assert.deepEqual(codes(r.report), ['no_encrypted_pages']);
  });

  // -- Wrapper hygiene -----------------------------------------------------

  it('detects a wrapper moved away from the path it was sealed for', () => {
    const { outDir } = build(SIMPLE);
    fs.renameSync(path.join(outDir, 'blog', 'post.html'), path.join(outDir, 'blog', 'moved.html'));
    const r = report([outDir]);
    assert.equal(r.code, 1);
    const mismatch = find(r.report, 'payload_path_mismatch');
    assert.equal(mismatch.length, 1);
    assert.equal(mismatch[0].path, 'blog/moved.html');
    assert.match(mismatch[0].message, /sealed for "blog\/post\.html"/);
  });

  it('detects a wrapper edited after the build', () => {
    const { outDir } = build(SIMPLE);
    const page = path.join(outDir, 'index.html');
    fs.appendFileSync(page, '\n<!-- injected -->');
    const r = report([outDir]);
    assert.equal(r.code, 1);
    assert.deepEqual(find(r.report, 'wrapper_modified').map((f) => f.path), ['index.html']);
  });

  it('detects a wrapper whose CSP was weakened', () => {
    const { outDir } = build(SIMPLE);
    const page = path.join(outDir, 'index.html');
    fs.writeFileSync(
      page,
      fs.readFileSync(page, 'utf8').replace("default-src 'none'", "default-src *")
    );
    const r = report([outDir]);
    assert.equal(r.code, 1);
    assert.deepEqual(find(r.report, 'wrapper_modified').map((f) => f.path), ['index.html']);
  });

  it('separates a damaged wrapper from an intentionally public page', () => {
    const { outDir } = build(SIMPLE);
    const page = path.join(outDir, 'index.html');
    fs.writeFileSync(
      page,
      fs.readFileSync(page, 'utf8').replace(
        /(<script id="veil-payload" type="application\/json">)[^<]+/,
        '$1{not json'
      )
    );
    const r = report([outDir]);
    assert.equal(r.code, 1);
    const malformed = find(r.report, 'payload_malformed');
    assert.equal(malformed.length, 1);
    assert.match(malformed[0].message, /not valid JSON/);
    assert.equal(r.report.publicHtml.length, 0, 'a damaged wrapper is not public HTML');
  });

  it('reads a page that only writes about Veil as ordinary public HTML', () => {
    const { outDir } = build(SIMPLE, ['--html-root', 'blog']);
    fs.writeFileSync(
      path.join(outDir, 'index.html'),
      '<html><body><p>The payload lives in ' +
      '&lt;script id="veil-payload" type="application/json"&gt;.</p></body></html>'
    );
    const r = report([outDir, '--html-root', 'blog']);
    assert.equal(r.code, 0, JSON.stringify(r.report.findings));
    assert.ok(r.report.publicHtml.some((p) => p.path === 'index.html'));
  });

  it('rejects a page carrying two payload scripts', () => {
    const { outDir } = build(SIMPLE);
    const page = path.join(outDir, 'index.html');
    const html = fs.readFileSync(page, 'utf8');
    const payloadScript = /<script id="veil-payload" type="application\/json">[^<]+<\/script>/.exec(html)[0];
    fs.writeFileSync(page, html.replace(payloadScript, payloadScript + payloadScript));
    const r = report([outDir]);
    assert.equal(r.code, 1);
    assert.match(find(r.report, 'payload_malformed')[0].message, /2 veil-payload scripts/);
  });

  it('rejects a payload that fails schema validation', () => {
    const { outDir } = build(SIMPLE);
    const page = path.join(outDir, 'index.html');
    const payload = extractPayload(fs.readFileSync(page, 'utf8'));
    payload.salt = Buffer.alloc(8).toString('base64');
    writeRawPayload(page, payload);
    const r = report([outDir]);
    assert.equal(r.code, 1);
    assert.match(find(r.report, 'payload_invalid')[0].message, /salt must be 16 bytes/);
  });

  it('refuses to certify a payload from an older or newer format', () => {
    const { outDir } = build(SIMPLE);
    const legacy = path.join(outDir, 'index.html');
    const legacyPayload = extractPayload(fs.readFileSync(legacy, 'utf8'));
    legacyPayload.v = 1;
    delete legacyPayload.path;
    writeRawPayload(legacy, legacyPayload);

    const future = path.join(outDir, 'blog', 'post.html');
    const futurePayload = extractPayload(fs.readFileSync(future, 'utf8'));
    futurePayload.v = 99;
    writeRawPayload(future, futurePayload);

    const r = report([outDir]);
    assert.equal(r.code, 1);
    const unsupported = find(r.report, 'payload_version_unsupported');
    assert.deepEqual(unsupported.map((f) => f.path), ['blog/post.html', 'index.html']);
    assert.match(unsupported.find((f) => f.path === 'index.html').message, /re-encrypt the source/);
    assert.match(unsupported.find((f) => f.path === 'blog/post.html').message, /upgrade veil\.js/);
  });

  // -- Cohort checks -------------------------------------------------------

  it('fails when the site id is not the expected one', () => {
    const { outDir } = build(SIMPLE);
    const r = report([outDir, '--id', 'some-other-site']);
    assert.equal(r.code, 1);
    const mismatch = find(r.report, 'site_id_mismatch');
    assert.equal(mismatch.length, 1, 'one finding per distinct wrong id, not one per page');
    assert.match(mismatch[0].message, /carries site id "verify-site".*3 page\(s\)/);
  });

  it('detects pages mixed in from a different build', () => {
    const { outDir } = build(SIMPLE);
    const other = build(SIMPLE);
    fs.copyFileSync(path.join(other.outDir, 'index.html'), path.join(outDir, 'index.html'));
    const r = report([outDir]);
    assert.equal(r.code, 1);
    const inconsistent = find(r.report, 'site_inconsistent');
    assert.ok(inconsistent.length > 0);
    assert.ok(inconsistent.some((f) => /different salt/.test(f.message)));
    assert.equal(find(r.report, 'iv_reuse').length, 0, 'different key material is not IV reuse');
  });

  it('detects IV reuse under one master key', () => {
    const { outDir } = build(SIMPLE);
    const { generateWrapper } = require('./veil.js');
    const source = extractPayload(fs.readFileSync(path.join(outDir, 'index.html'), 'utf8'));
    const target = extractPayload(fs.readFileSync(path.join(outDir, 'blog', 'post.html'), 'utf8'));
    target.iv = source.iv;
    fs.writeFileSync(path.join(outDir, 'blog', 'post.html'), generateWrapper(target));
    const r = report([outDir]);
    assert.equal(r.code, 1);
    assert.equal(find(r.report, 'iv_reuse').length, 1);
  });

  it('warns, but passes, on an iteration count below the default', () => {
    const { outDir } = build(SIMPLE);
    const r = report([outDir]);
    assert.equal(r.code, 0);
    assert.equal(r.report.counts.warnings, 1);
    assert.match(find(r.report, 'iterations_below_default')[0].message, /below the default 600000/);
  });

  it('reports a symlink in the output tree without abandoning the audit', () => {
    const { outDir } = build(SIMPLE);
    fs.symlinkSync(path.join(outDir, 'index.html'), path.join(outDir, 'alias.html'));
    const r = report([outDir]);
    assert.equal(r.code, 1);
    assert.deepEqual(find(r.report, 'irregular_file').map((f) => f.path), ['alias.html']);
    assert.equal(r.report.stats.encryptedHtml, 3, 'the rest of the tree is still audited');
  });

  it('cannot be blinded to a payload by markup wrapped around it', () => {
    const { outDir } = build(SIMPLE);
    const page = path.join(outDir, 'index.html');
    // `--!>` also ends a comment in a browser, so a tokenizer that only knows
    // `-->` would treat the rest of this document as commented out. The payload
    // is still there, and finding it must not depend on parsing the markup.
    fs.writeFileSync(page, '<!--x--!>' + fs.readFileSync(page, 'utf8'));
    const r = report([outDir]);
    assert.equal(r.code, 1);
    assert.deepEqual(find(r.report, 'wrapper_modified').map((f) => f.path), ['index.html']);
    assert.ok(!r.report.publicHtml.some((p) => p.path === 'index.html'));
  });

  it('does not fail a public page that quotes wrapper markup', () => {
    const { outDir } = build(SIMPLE, ['--html-root', 'blog']);
    // A browser creates no veil-payload element here — the tag text is inside
    // a JavaScript string — but raw matching cannot know that. Out of scope,
    // an undecidable page must be reported, never failed.
    fs.writeFileSync(
      path.join(outDir, 'index.html'),
      '<html><body><script>const example = ' +
      '\'<script id="veil-payload" type="application/json">\';</script>' +
      '<h1>Public</h1></body></html>'
    );
    const r = report([outDir, '--html-root', 'blog']);
    assert.equal(r.code, 0, JSON.stringify(r.report.findings));
    assert.ok(r.report.publicHtml.some((p) => p.path === 'index.html'));
    const warned = find(r.report, 'payload_malformed');
    assert.equal(warned.length, 1);
    assert.equal(warned[0].severity, 'warning');
    assert.match(warned[0].message, /may equally be public HTML/);
  });

  it('still fails a canonical wrapper relocated outside the audited scope', () => {
    const { outDir } = build(SIMPLE, ['--html-root', 'blog']);
    // Byte-exact generated wrapper, so it is unambiguously a wrapper wherever
    // it sits — and it is not sitting where it was sealed for.
    fs.renameSync(path.join(outDir, 'blog', 'post.html'), path.join(outDir, 'moved.html'));
    const r = report([outDir, '--html-root', 'blog']);
    assert.equal(r.code, 1);
    const mismatch = find(r.report, 'payload_path_mismatch');
    assert.deepEqual(mismatch.map((f) => f.path), ['moved.html']);
    assert.equal(mismatch[0].severity, 'error');
    assert.equal(r.report.stats.outOfScopeWrappers, 1);
    assert.ok(!r.report.publicHtml.some((p) => p.path === 'moved.html'));
  });

  it('does not fail a public page that quotes a real payload in raw text', () => {
    const { outDir } = build(SIMPLE, ['--html-root', 'blog']);
    const wrapper = fs.readFileSync(path.join(outDir, 'blog', 'post.html'), 'utf8');
    const payloadScript =
      /<script id="veil-payload" type="application\/json">[^<]+<\/script>/.exec(wrapper)[0];
    // A genuine, schema-valid payload — but inside a textarea, so a browser
    // creates no payload element and the page is ordinary public HTML.
    fs.writeFileSync(
      path.join(outDir, 'index.html'),
      `<html><body><h1>Example</h1><textarea>${payloadScript}</textarea></body></html>`
    );
    const r = report([outDir, '--html-root', 'blog']);
    assert.equal(r.code, 0, JSON.stringify(r.report.findings));
    assert.ok(r.report.publicHtml.some((p) => p.path === 'index.html'));
    assert.equal(r.report.stats.outOfScopeWrappers, 0);
    const warned = find(r.report, 'wrapper_modified');
    assert.equal(warned.length, 1);
    assert.equal(warned[0].severity, 'warning');
  });

  it('does still fail a quoted real payload when the page is in scope', () => {
    const { outDir } = build(SIMPLE);
    const wrapper = fs.readFileSync(path.join(outDir, 'blog', 'post.html'), 'utf8');
    const payloadScript =
      /<script id="veil-payload" type="application\/json">[^<]+<\/script>/.exec(wrapper)[0];
    fs.writeFileSync(
      path.join(outDir, 'index.html'),
      `<html><body><textarea>${payloadScript}</textarea></body></html>`
    );
    const r = report([outDir]);
    assert.equal(r.code, 1);
    assert.equal(find(r.report, 'wrapper_modified')[0].severity, 'error');
  });

  it('does still fail the same ambiguous page when it is in scope', () => {
    const { outDir } = build(SIMPLE);
    fs.writeFileSync(
      path.join(outDir, 'index.html'),
      '<html><body><script>const example = ' +
      '\'<script id="veil-payload" type="application/json">\';</script>' +
      '<h1>Public</h1></body></html>'
    );
    const r = report([outDir]);
    assert.equal(r.code, 1);
    assert.equal(find(r.report, 'payload_malformed')[0].severity, 'error');
  });

  it('does not mistake wrapper markup quoted inside a public page for a wrapper', () => {
    const { outDir } = build(SIMPLE, ['--html-root', 'blog']);
    fs.writeFileSync(
      path.join(outDir, 'index.html'),
      '<html><body>' +
      '<!-- <div id="veil-prompt"></div> -->' +
      '<textarea><div id="veil-prompt"></div></textarea>' +
      '<p>The payload lives in &lt;script id="veil-payload"&gt;.</p>' +
      '</body></html>'
    );
    const r = report([outDir, '--html-root', 'blog']);
    assert.equal(r.code, 0, JSON.stringify(r.report.findings));
    assert.equal(r.report.counts.warnings, 1, 'only the iteration-count warning');
    assert.ok(r.report.publicHtml.some((p) => p.path === 'index.html'));
  });

  it('reports a wrapper whose payload script was emptied out', () => {
    const { outDir } = build(SIMPLE);
    const page = path.join(outDir, 'index.html');
    fs.writeFileSync(
      page,
      fs.readFileSync(page, 'utf8').replace(
        /(<script id="veil-payload" type="application\/json">)[^<]+/,
        '$1'
      )
    );
    const r = report([outDir]);
    assert.equal(r.code, 1);
    assert.match(find(r.report, 'payload_malformed')[0].message, /no readable contents/);
  });

  it("catches a zone's own tampered wrapper when that zone is the audited scope", () => {
    const siteDir = setupSite(dir, {
      'index.html': '<html><body>Home</body></html>',
      'zone-a/secret.html': '<html><body>Zone A</body></html>',
      'zone-b/secret.html': '<html><body>Zone B</body></html>',
    });
    const stage1 = fs.mkdtempSync(path.join(dir, 'evade1-'));
    const stage2 = fs.mkdtempSync(path.join(dir, 'evade2-'));
    assert.equal(run([siteDir, stage1, '--passphrase', 'a-pass', '--iterations', '100000',
      '--id', 'zone-a', '--html-root', 'zone-a']).code, 0);
    assert.equal(run([stage1, stage2, '--passphrase', 'b-pass', '--iterations', '100000',
      '--id', 'zone-b', '--html-root', 'zone-b']).code, 0);

    // Rename the payload script so the page no longer presents as a wrapper.
    const zoneA = path.join(stage2, 'zone-a', 'secret.html');
    fs.writeFileSync(zoneA, fs.readFileSync(zoneA, 'utf8').replace(/veil-payload/g, 'veil_payload'));

    // Auditing zone A — the run that owns that page — fails, which is the
    // guarantee: every zone is verified by its own invocation.
    const a = report([stage2, '--html-root', 'zone-a', '--id', 'zone-a']);
    assert.equal(a.code, 1);
    assert.deepEqual(find(a.report, 'html_not_encrypted').map((f) => f.path), ['zone-a/secret.html']);

    // The same edit is also caught from any zone once --input is supplied,
    // because the page is passthrough for the later stage.
    const b = report([stage2, '--input', stage1, '--html-root', 'zone-b', '--id', 'zone-b']);
    assert.equal(b.code, 1);
    assert.deepEqual(
      find(b.report, 'passthrough_modified').map((f) => f.path),
      ['zone-a/secret.html']
    );
  });

  it('still audits IVs and decryption when pages disagree only about remember', () => {
    const { outDir } = build(SIMPLE);
    const { generateWrapper } = require('./veil.js');
    const page = path.join(outDir, 'index.html');
    const payload = extractPayload(fs.readFileSync(page, 'utf8'));
    payload.remember = !payload.remember;
    fs.writeFileSync(page, generateWrapper(payload));

    const r = report([outDir, '--passphrase', PASS]);
    assert.equal(r.code, 1);
    assert.ok(find(r.report, 'site_inconsistent').some((f) => /different remember/.test(f.message)));
    // remember is not key material, so the decryption pass must still run.
    assert.equal(r.report.checks.decryption.status, 'passed');

    // ...and the pages must still be one IV group, or reused IVs would hide
    // behind a disagreement that has nothing to do with the master key.
    const other = extractPayload(fs.readFileSync(path.join(outDir, 'about.htm'), 'utf8'));
    const flipped = extractPayload(fs.readFileSync(page, 'utf8'));
    other.iv = flipped.iv;
    fs.writeFileSync(path.join(outDir, 'about.htm'), generateWrapper(other));
    const reused = report([outDir]);
    assert.equal(find(reused.report, 'iv_reuse').length, 1);
  });

  // -- Correspondence ------------------------------------------------------

  it('passes correspondence for a clean build, warning about inlined assets', () => {
    const { siteDir, outDir } = build({
      'index.html': '<html><head><link rel="stylesheet" href="/style.css"></head><body>Home</body></html>',
      'style.css': 'body{color:red}',
    });
    const r = report([outDir, '--input', siteDir]);
    assert.equal(r.code, 0);
    assert.equal(r.report.checks.correspondence.status, 'passed');
    assert.deepEqual(find(r.report, 'missing_asset').map((f) => f.path), ['style.css']);
    assert.equal(find(r.report, 'missing_asset')[0].severity, 'warning');
  });

  it('does not report correspondence as passed over a tree it could not fully read', () => {
    const { siteDir, outDir } = build(SIMPLE);
    fs.symlinkSync(path.join(siteDir, 'index.html'), path.join(siteDir, 'link.html'));
    const r = report([outDir, '--input', siteDir]);
    assert.equal(r.code, 1);
    assert.deepEqual(find(r.report, 'irregular_file').map((f) => f.path), ['link.html']);
    assert.equal(r.report.checks.correspondence.status, 'failed');
    assert.equal(r.report.ok, false);

    // The same holds for an output entry the walk had to skip: it never
    // reaches the orphan comparison, so that stage did not fully run.
    const clean = build(SIMPLE);
    fs.symlinkSync(path.join(clean.outDir, 'index.html'), path.join(clean.outDir, 'orphan.html'));
    const out = report([clean.outDir, '--input', clean.siteDir]);
    assert.equal(out.code, 1);
    assert.deepEqual(find(out.report, 'irregular_file').map((f) => f.path), ['orphan.html']);
    assert.equal(out.report.checks.correspondence.status, 'failed');
  });

  it('refuses to compare a build against itself', () => {
    const { outDir } = build(SIMPLE);
    const same = verify([outDir, '--input', outDir]);
    assert.equal(same.code, 2);
    assert.match(same.stderr, /separate tree/);

    const alias = path.join(dir, `alias-${path.basename(outDir)}`);
    fs.symlinkSync(outDir, alias);
    const viaSymlink = verify([outDir, '--input', alias]);
    assert.equal(viaSymlink.code, 2);
    assert.match(viaSymlink.stderr, /separate tree/);

    const nested = verify([path.join(outDir, 'blog'), '--input', outDir]);
    assert.equal(nested.code, 2);
    assert.match(nested.stderr, /separate tree/);
  });

  it('detects a stale file left in the output', () => {
    const { siteDir, outDir } = build(SIMPLE);
    fs.writeFileSync(path.join(outDir, 'stale.html'), '<html><body>old</body></html>');
    fs.writeFileSync(path.join(outDir, 'stale.txt'), 'old');
    const r = report([outDir, '--input', siteDir]);
    assert.equal(r.code, 1);
    assert.deepEqual(find(r.report, 'orphan').map((f) => f.path), ['stale.html', 'stale.txt']);
    assert.equal(r.report.checks.correspondence.status, 'failed');
  });

  it('reports a missing HTML file as an error, not a warning', () => {
    const { siteDir, outDir } = build(SIMPLE);
    fs.rmSync(path.join(outDir, 'blog', 'post.html'));
    const r = report([outDir, '--input', siteDir]);
    assert.equal(r.code, 1);
    const missing = find(r.report, 'missing_output');
    assert.deepEqual(missing.map((f) => f.path), ['blog/post.html']);
    assert.equal(missing[0].severity, 'error');
  });

  it('detects a passthrough file modified after the build', () => {
    const { siteDir, outDir } = build(
      { ...SIMPLE, 'assets/data.txt': 'original', 'public/open.html': '<html><body>open</body></html>' },
      ['--html-root', 'blog']
    );
    fs.writeFileSync(path.join(outDir, 'assets', 'data.txt'), 'tampered');
    fs.writeFileSync(path.join(outDir, 'public', 'open.html'), '<html><body>changed</body></html>');
    const r = report([outDir, '--input', siteDir, '--html-root', 'blog']);
    assert.equal(r.code, 1);
    assert.deepEqual(
      find(r.report, 'passthrough_modified').map((f) => f.path),
      ['assets/data.txt', 'public/open.html']
    );
  });

  it('does not compare a same-size passthrough file by size alone', () => {
    const { siteDir, outDir } = build(
      { ...SIMPLE, 'assets/data.txt': 'original' },
      ['--html-root', 'blog']
    );
    fs.writeFileSync(path.join(outDir, 'assets', 'data.txt'), 'originaL');
    const r = report([outDir, '--input', siteDir, '--html-root', 'blog']);
    assert.equal(r.code, 1);
    assert.deepEqual(find(r.report, 'passthrough_modified').map((f) => f.path), ['assets/data.txt']);
  });

  // -- Decryption ----------------------------------------------------------

  it('decrypts every page with the right passphrase', () => {
    const { outDir } = build(SIMPLE);
    const r = report([outDir, '--passphrase', PASS]);
    assert.equal(r.code, 0);
    assert.equal(r.report.checks.decryption.status, 'passed');
    assert.match(r.stderr, /--passphrase is visible in process listings/);
  });

  it('reads the passphrase from the environment', () => {
    const { outDir } = build(SIMPLE);
    const r = run(['verify', outDir, '--passphrase-env', 'VEIL_TEST_PASS', '--json'], {
      env: { ...process.env, VEIL_TEST_PASS: PASS },
    });
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.stdout).checks.decryption.status, 'passed');
    assert.equal(r.stderr, '');
  });

  it('reports a wrong passphrase as an unwrap failure, once', () => {
    const { outDir } = build(SIMPLE);
    const r = report([outDir, '--passphrase', 'wrong-passphrase']);
    assert.equal(r.code, 1);
    assert.equal(r.report.checks.decryption.status, 'failed');
    assert.equal(find(r.report, 'mk_unwrap_failed').length, 1);
    assert.equal(find(r.report, 'page_decrypt_failed').length, 0);
  });

  it('blames the individual page when only its ciphertext was altered', () => {
    const { outDir } = build(SIMPLE);
    const { generateWrapper } = require('./veil.js');
    const page = path.join(outDir, 'blog', 'post.html');
    const payload = extractPayload(fs.readFileSync(page, 'utf8'));
    const ct = Buffer.from(payload.ct, 'base64');
    ct[0] ^= 0xff;
    payload.ct = ct.toString('base64');
    fs.writeFileSync(page, generateWrapper(payload));
    const r = report([outDir, '--passphrase', PASS]);
    assert.equal(r.code, 1);
    assert.equal(find(r.report, 'mk_unwrap_failed').length, 0);
    assert.deepEqual(find(r.report, 'page_decrypt_failed').map((f) => f.path), ['blog/post.html']);
  });

  it('skips decryption when the pages in scope disagree on key material', () => {
    const { outDir } = build(SIMPLE);
    const other = build(SIMPLE);
    fs.copyFileSync(path.join(other.outDir, 'index.html'), path.join(outDir, 'index.html'));
    const r = report([outDir, '--passphrase', PASS]);
    assert.equal(r.code, 1);
    assert.equal(r.report.checks.decryption.status, 'skipped');
    assert.match(r.report.checks.decryption.reason, /do not share one set of key material/);
  });

  it('exits 2 rather than auditing when a passphrase source is unusable', () => {
    const { outDir } = build(SIMPLE);
    const unset = verify([outDir, '--passphrase-env', 'VEIL_DEFINITELY_UNSET']);
    assert.equal(unset.code, 2);
    assert.match(unset.stderr, /is empty or not set/);

    const both = verify([outDir, '--passphrase', PASS, '--passphrase-env', 'HOME']);
    assert.equal(both.code, 2);
    assert.match(both.stderr, /Use only one of/);

    const empty = verify([outDir, '--passphrase', '']);
    assert.equal(empty.code, 2);
    assert.match(empty.stderr, /cannot be empty/);

    const noTty = verify([outDir, '--prompt-passphrase']);
    assert.equal(noTty.code, 2);
    assert.match(noTty.stderr, /needs a terminal/);
  });

  // -- Chained protected zones ---------------------------------------------

  it('audits one zone of a chained build without faulting the other', () => {
    const siteDir = setupSite(dir, {
      'index.html': '<html><body>Home</body></html>',
      'zone-a/secret.html': '<html><body>Zone A</body></html>',
      'zone-b/secret.html': '<html><body>Zone B</body></html>',
    });
    const stage1 = fs.mkdtempSync(path.join(dir, 'chain1-'));
    const stage2 = fs.mkdtempSync(path.join(dir, 'chain2-'));
    assert.equal(run([
      siteDir, stage1, '--passphrase', 'zone-a-pass', '--iterations', '100000',
      '--id', 'zone-a', '--html-root', 'zone-a',
    ]).code, 0);
    assert.equal(run([
      stage1, stage2, '--passphrase', 'zone-b-pass', '--iterations', '100000',
      '--id', 'zone-b', '--html-root', 'zone-b',
    ]).code, 0);

    const b = report([stage2, '--html-root', 'zone-b', '--id', 'zone-b', '--passphrase', 'zone-b-pass']);
    assert.equal(b.code, 0, JSON.stringify(b.report.findings));
    assert.equal(b.report.stats.encryptedHtml, 1);
    assert.equal(b.report.stats.outOfScopeWrappers, 1, "zone A's wrapper is not public HTML");
    assert.deepEqual(b.report.publicHtml.map((p) => p.path), ['index.html']);
    assert.equal(b.report.checks.decryption.status, 'passed');

    const a = report([stage2, '--html-root', 'zone-a', '--id', 'zone-a', '--passphrase', 'zone-a-pass']);
    assert.equal(a.code, 0, JSON.stringify(a.report.findings));
    assert.equal(a.report.checks.decryption.status, 'passed');

    // Correspondence for the second stage compares against that stage's input,
    // where zone A's wrappers are ordinary passthrough files.
    const withInput = report([stage2, '--input', stage1, '--html-root', 'zone-b', '--id', 'zone-b']);
    assert.equal(withInput.code, 0, JSON.stringify(withInput.report.findings));
    assert.equal(withInput.report.checks.correspondence.status, 'passed');
  });

  // -- End to end ----------------------------------------------------------

  it('verifies a full build end to end with every stage enabled', () => {
    const { siteDir, outDir } = build({
      'index.html': '<html><body><h1>Home</h1></body></html>',
      'docs/guide.html': '<html><body><h1>Guide</h1></body></html>',
      'assets/logo.svg': '<svg xmlns="http://www.w3.org/2000/svg"></svg>',
    });
    const r = run(['verify', outDir, '--input', siteDir, '--id', SITE_ID, '--passphrase-env', 'VEIL_TEST_PASS'], {
      env: { ...process.env, VEIL_TEST_PASS: PASS },
    });
    assert.equal(r.code, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^correspondence: passed$/m);
    assert.match(r.stdout, /^decryption: passed$/m);
    assert.match(r.stdout, /^PASS/m);
  });
});
