#!/usr/bin/env node
'use strict';

// Browser end-to-end tests for the Veil wrapper runtime.
//
// Run with: npm run test:browser   (requires `npx playwright install chromium`)
//
// These exercise what the Node suite cannot: Web Crypto, document.write,
// the CSP, storage tiers, logout navigation, and the unlock form.

const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const { execFileSync } = require('child_process');
const { chromium } = require('playwright');

const VEIL = path.join(__dirname, 'veil.js');
const PASS = 'correct horse battery';
const ITER = '100000';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.png': 'image/png',
  '.json': 'application/json',
};

// Minimal valid 1x1 PNG
function onePixelPng() {
  const zlib = require('zlib');
  const crc = (buf) => {
    let c = ~0;
    for (const x of buf) {
      c ^= x;
      for (let i = 0; i < 8; i++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
    }
    c = ~c;
    return Buffer.from([(c >>> 24) & 255, (c >>> 16) & 255, (c >>> 8) & 255, c & 255]);
  };
  const chunk = (type, data) => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    return Buffer.concat([len, td, crc(td)]);
  };
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', Buffer.from([0, 0, 0, 1, 0, 0, 0, 1, 8, 2, 0, 0, 0])),
    chunk('IDAT', require('zlib').deflateSync(Buffer.from([0, 255, 0, 0]))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function build(inputFiles, outDir, extraArgs = []) {
  const inDir = fs.mkdtempSync(path.join(os.tmpdir(), 'veil-e2e-in-'));
  for (const [name, content] of Object.entries(inputFiles)) {
    const p = path.join(inDir, name);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content);
  }
  execFileSync(process.execPath, [
    VEIL, inDir, outDir,
    '--passphrase', PASS, '--iterations', ITER, ...extraArgs,
  ], { stdio: 'pipe' });
  fs.rmSync(inDir, { recursive: true, force: true });
}

describe('wrapper runtime (browser)', () => {
  let browser, server, root, baseUrl;
  const SK = 'veil:v2:e2e:mk';

  before(async () => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'veil-e2e-www-'));

    // Site A: two pages, inlined CSS, a same-origin image
    build({
      'index.html':
        '<html><head><title>Secret Dashboard</title>' +
        '<link rel="stylesheet" href="style.css"></head>' +
        '<body><p id="marker-a">alpha content</p><img id="im" src="pic.png"></body></html>',
      'about.html': '<html><head><title>About</title></head><body><p id="marker-b">beta content</p></body></html>',
      'style.css': 'body{background-color:rgb(1,2,3)}',
      'pic.png': onePixelPng(),
    }, path.join(root, 'a'), ['--id', 'e2e']);

    // Site B: same site id, separate build (different MK) — for stale-key tests
    build({
      'index.html': '<html><head><title>B</title></head><body><p id="marker-rebuild">rebuilt content</p></body></html>',
    }, path.join(root, 'b'), ['--id', 'e2e']);

    // No-inline build: local CSS/JS left as references
    build({
      'index.html':
        '<html><head><link rel="stylesheet" href="style.css"></head>' +
        '<body><p id="marker-ni">ni content</p><img id="im" src="pic.png">' +
        '<script src="app.js"></script></body></html>',
      'style.css': 'body{background-color:rgb(4,5,6)}',
      'app.js': 'window.appRan = true;',
      'pic.png': onePixelPng(),
    }, path.join(root, 'ni'), ['--id', 'e2e-ni', '--no-inline']);

    // Corrupt build: copy of site A's index with a flipped ciphertext byte
    const corruptDir = path.join(root, 'corrupt');
    fs.mkdirSync(corruptDir, { recursive: true });
    const wrapper = fs.readFileSync(path.join(root, 'a', 'index.html'), 'utf8');
    const tampered = wrapper.replace(
      /("ct":")([A-Za-z0-9+/])/,
      (m, pre, ch) => pre + (ch === 'A' ? 'B' : 'A')
    );
    assert.notEqual(tampered, wrapper, 'tampering must change the wrapper');
    fs.writeFileSync(path.join(corruptDir, 'index.html'), tampered);

    server = http.createServer((req, res) => {
      const urlPath = decodeURIComponent(new URL(req.url, 'http://x').pathname);
      const file = path.join(root, urlPath);
      if (!file.startsWith(root) || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
        res.writeHead(404);
        return res.end('not found');
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
      res.end(fs.readFileSync(file));
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    browser = await chromium.launch();
  });

  after(async () => {
    if (browser) await browser.close();
    if (server) server.close();
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  async function newPage() {
    const context = await browser.newContext();
    const page = await context.newPage();
    return { context, page };
  }

  async function submitPass(page, pass, { remember = false } = {}) {
    await page.waitForSelector('#veil-prompt:not(.veil-hidden)');
    await page.fill('#veil-pass', pass);
    if (remember) await page.check('#veil-rem');
    await page.click('#veil-btn');
  }

  it('unlocks with the correct passphrase and restores the real title', async () => {
    const { context, page } = await newPage();
    await page.goto(`${baseUrl}/a/index.html`);
    assert.equal(await page.title(), 'Protected page');
    await submitPass(page, PASS);
    await page.waitForSelector('#marker-a');
    assert.equal(await page.title(), 'Secret Dashboard');
    await context.close();
  });

  it('loads same-origin images and applies inlined CSS under the wrapper CSP', async () => {
    const { context, page } = await newPage();
    await page.goto(`${baseUrl}/a/index.html`);
    await submitPass(page, PASS);
    await page.waitForSelector('#marker-a');
    await page.waitForFunction(() => document.getElementById('im').complete);
    const r = await page.evaluate(() => ({
      imgWidth: document.getElementById('im').naturalWidth,
      bg: getComputedStyle(document.body).backgroundColor,
    }));
    assert.equal(r.imgWidth, 1, 'same-origin image must load under the CSP');
    assert.equal(r.bg, 'rgb(1, 2, 3)', 'inlined CSS must apply');
    await context.close();
  });

  it('shows a wrong-passphrase error and stays usable', async () => {
    const { context, page } = await newPage();
    await page.goto(`${baseUrl}/a/index.html`);
    await submitPass(page, 'not the passphrase');
    await page.waitForFunction(() =>
      document.getElementById('veil-error').textContent.includes('Wrong passphrase'));
    // Still recoverable
    await page.fill('#veil-pass', PASS);
    await page.click('#veil-btn');
    await page.waitForSelector('#marker-a');
    await context.close();
  });

  it('distinguishes corrupt page data from a wrong passphrase, and caches nothing', async () => {
    const { context, page } = await newPage();
    await page.goto(`${baseUrl}/corrupt/index.html`);
    await submitPass(page, PASS, { remember: true });
    await page.waitForFunction(() =>
      document.getElementById('veil-error').textContent.includes('failed to decrypt'));
    const err = await page.evaluate(() => document.getElementById('veil-error').textContent);
    assert.ok(!err.includes('Wrong passphrase'), 'must not misreport corrupt data as a wrong passphrase');
    // MK must only be cached after a successful page decrypt
    const r = await page.evaluate((k) => ({
      session: sessionStorage.getItem(k),
      local: localStorage.getItem(k),
    }), SK);
    assert.equal(r.session, null, 'failed decrypt must not populate sessionStorage');
    assert.equal(r.local, null, 'failed decrypt must not populate localStorage');
    await context.close();
  });

  it('unlocks sibling pages from the session cache without re-prompting', async () => {
    const { context, page } = await newPage();
    await page.goto(`${baseUrl}/a/index.html`);
    await submitPass(page, PASS);
    await page.waitForSelector('#marker-a');
    await page.goto(`${baseUrl}/a/about.html`);
    await page.waitForSelector('#marker-b');
    // A cached key decrypts fast enough to finish while the wrapper is still
    // parsing. The decrypted document has to replace the wrapper even then,
    // rather than being appended to it.
    assert.equal(await page.title(), 'About', 'the real title must replace "Protected page"');
    const leftovers = await page.evaluate(() => ({
      prompt: document.querySelectorAll('#veil-prompt').length,
      payload: document.querySelectorAll('#veil-payload').length,
    }));
    assert.deepEqual(leftovers, { prompt: 0, payload: 0 }, 'no wrapper markup may survive the write');
    await context.close();
  });

  it('the lock control is labelled, legible against the decrypted page, and keyboard-operable', async () => {
    const { context, page } = await newPage();
    await page.goto(`${baseUrl}/a/index.html`);
    await submitPass(page, PASS, { remember: true });
    await page.waitForSelector('#marker-a');

    const lock = await page.evaluate(() => {
      const el = document.querySelector('.veil-lock');
      if (!el) return null;
      const s = getComputedStyle(el);
      return {
        text: el.textContent,
        label: el.getAttribute('aria-label'),
        title: el.getAttribute('title'),
        // It sits over a document whose styles the wrapper does not control, so
        // it has to carry its own background rather than inherit one.
        background: s.backgroundColor,
        color: s.color,
        borderColor: s.borderTopColor,
        fontFamily: s.fontFamily,
      };
    });
    assert.ok(lock, 'the decrypted page must carry a lock control');
    assert.equal(lock.text, 'lock', 'the control is labelled in text, not with an emoji');
    assert.ok(/clear the cached key/i.test(lock.label || ''), 'it needs an accessible name saying what it does');
    assert.equal(lock.title, lock.label, 'the tooltip and the accessible name must agree');
    assert.equal(lock.background, 'rgb(14, 14, 13)');
    assert.equal(lock.color, 'rgb(232, 227, 213)');
    assert.equal(lock.borderColor, 'rgb(111, 107, 97)');
    assert.match(lock.fontFamily, /mono/i);

    // Reachable and activatable from the keyboard alone. Tab rather than
    // .focus(), because only real keyboard entry matches :focus-visible.
    for (let i = 0; i < 6; i++) {
      await page.keyboard.press('Tab');
      if (await page.evaluate(() => document.activeElement.classList.contains('veil-lock'))) break;
    }
    const focus = await page.evaluate(() => {
      const el = document.querySelector('.veil-lock');
      if (el !== document.activeElement) return null;
      const s = getComputedStyle(el);
      return { visible: el.matches(':focus-visible'), outline: s.outlineColor + ' ' + s.outlineWidth, shadow: s.boxShadow };
    });
    assert.ok(focus, 'the lock control must be reachable by Tab');
    assert.ok(focus.visible, 'keyboard focus must match :focus-visible');
    assert.equal(focus.outline, 'rgb(193, 67, 46) 2px', 'the inner ring is the accent');
    // The outer ring is the control's own dark, and it has to have real width:
    // the pair is what keeps one contrasting edge over any decrypted-page
    // background, including one painted in the accent itself.
    assert.equal(focus.shadow, 'rgb(14, 14, 13) 0px 0px 0px 4px', 'a 4px outer ring, not inset');

    await page.keyboard.press('Enter');
    await page.waitForSelector('#veil-prompt:not(.veil-hidden)');
    const r = await page.evaluate((k) => ({
      session: sessionStorage.getItem(k),
      local: localStorage.getItem(k),
    }), SK);
    assert.equal(r.session, null, 'locking must clear the session key');
    assert.equal(r.local, null, 'locking must clear the remembered key');
    await context.close();
  });

  it('remember-device persists the key in localStorage and survives session loss', async () => {
    const { context, page } = await newPage();
    await page.goto(`${baseUrl}/a/index.html`);
    await submitPass(page, PASS, { remember: true });
    await page.waitForSelector('#marker-a');
    const stored = await page.evaluate((k) => localStorage.getItem(k), SK);
    assert.ok(stored, 'localStorage must hold the remembered key');
    await page.evaluate((k) => sessionStorage.removeItem(k), SK);
    await page.reload();
    await page.waitForSelector('#marker-a');
    await context.close();
  });

  it('a malformed session value falls back to a valid remembered key without deleting it', async () => {
    const { context, page } = await newPage();
    await page.goto(`${baseUrl}/a/index.html`);
    await submitPass(page, PASS, { remember: true });
    await page.waitForSelector('#marker-a');
    await page.evaluate((k) => sessionStorage.setItem(k, '!!!not-base64!!!'), SK);
    await page.reload();
    await page.waitForSelector('#marker-a');
    const r = await page.evaluate((k) => ({
      session: sessionStorage.getItem(k),
      local: localStorage.getItem(k),
    }), SK);
    assert.equal(r.session, null, 'invalid session value must be cleared');
    assert.ok(r.local, 'valid remembered key must be preserved');
    await context.close();
  });

  it('a well-formed but stale session key falls through to a valid remembered key', async () => {
    // Exercises the async decrypt-failure path in tryCached: the session
    // value parses (canonical base64, 32 bytes) but cannot decrypt the page.
    const { context, page } = await newPage();
    await page.goto(`${baseUrl}/a/index.html`);
    await submitPass(page, PASS, { remember: true });
    await page.waitForSelector('#marker-a');
    await page.evaluate((k) => {
      const junk = new Uint8Array(32).fill(7);
      sessionStorage.setItem(k, btoa(String.fromCharCode(...junk)));
    }, SK);
    await page.reload();
    await page.waitForSelector('#marker-a');
    const r = await page.evaluate((k) => ({
      session: sessionStorage.getItem(k),
      local: localStorage.getItem(k),
    }), SK);
    assert.ok(r.local, 'valid remembered key must survive the stale session key');
    await context.close();
  });

  it('non-canonical and empty stored values are rejected and cleared', async () => {
    const { context, page } = await newPage();
    await page.goto(`${baseUrl}/a/index.html`);
    await submitPass(page, PASS);
    await page.waitForSelector('#marker-a');
    const canonical = await page.evaluate((k) => sessionStorage.getItem(k), SK);
    // Whitespace-injected variant decodes to the same 32 bytes but is not
    // the canonical encoding we store — it must be rejected, not trusted.
    const nonCanonical = canonical.slice(0, 10) + ' \n' + canonical.slice(10);
    await page.evaluate(([k, v]) => {
      sessionStorage.setItem(k, v);
      localStorage.setItem(k, '');
    }, [SK, nonCanonical]);
    await page.reload();
    await page.waitForSelector('#veil-prompt:not(.veil-hidden)');
    const r = await page.evaluate((k) => ({
      session: sessionStorage.getItem(k),
      local: localStorage.getItem(k),
    }), SK);
    assert.equal(r.session, null, 'non-canonical value must be cleared, not used');
    assert.equal(r.local, null, 'empty stored value must be cleared');
    await context.close();
  });

  it('a stale key from an older build clears itself and falls back to the prompt', async () => {
    const { context, page } = await newPage();
    await page.goto(`${baseUrl}/a/index.html`);
    await submitPass(page, PASS);
    await page.waitForSelector('#marker-a');
    // Same site id, different build → cached MK cannot decrypt it
    await page.goto(`${baseUrl}/b/index.html`);
    await submitPass(page, PASS);
    await page.waitForSelector('#marker-rebuild');
    await context.close();
  });

  it('?veil=logout clears keys and lands on a clean URL without looping', async () => {
    const { context, page } = await newPage();
    await page.goto(`${baseUrl}/a/index.html`);
    await submitPass(page, PASS, { remember: true });
    await page.waitForSelector('#marker-a');
    await page.goto(`${baseUrl}/a/index.html?veil=logout&other=1`);
    await page.waitForURL(`${baseUrl}/a/index.html?other=1`);
    await page.waitForSelector('#veil-prompt:not(.veil-hidden)');
    const r = await page.evaluate((k) => ({
      session: sessionStorage.getItem(k),
      local: localStorage.getItem(k),
    }), SK);
    assert.equal(r.session, null);
    assert.equal(r.local, null);
    await context.close();
  });

  it('logout works when veil=logout is not the first veil value', async () => {
    const { context, page } = await newPage();
    await page.goto(`${baseUrl}/a/index.html`);
    await submitPass(page, PASS, { remember: true });
    await page.waitForSelector('#marker-a');
    await page.goto(`${baseUrl}/a/index.html?veil=keep&veil=logout`);
    await page.waitForURL(`${baseUrl}/a/index.html`);
    await page.waitForSelector('#veil-prompt:not(.veil-hidden)');
    const r = await page.evaluate((k) => ({
      session: sessionStorage.getItem(k),
      local: localStorage.getItem(k),
    }), SK);
    assert.equal(r.session, null);
    assert.equal(r.local, null);
    await context.close();
  });

  it('an unrelated query parameter does not log out', async () => {
    const { context, page } = await newPage();
    await page.goto(`${baseUrl}/a/index.html`);
    await submitPass(page, PASS);
    await page.waitForSelector('#marker-a');
    await page.goto(`${baseUrl}/a/index.html?notveil=logout`);
    await page.waitForSelector('#marker-a');
    await context.close();
  });

  it('throwing storage APIs degrade to a working prompt', async () => {
    const { context, page } = await newPage();
    await context.addInitScript(() => {
      Storage.prototype.getItem = () => { throw new Error('storage disabled'); };
      Storage.prototype.setItem = () => { throw new Error('storage disabled'); };
    });
    await page.goto(`${baseUrl}/a/index.html`);
    await submitPass(page, PASS);
    await page.waitForSelector('#marker-a');
    await context.close();
  });

  it('missing Web Crypto shows a clear error instead of hanging', async () => {
    const { context, page } = await newPage();
    await context.addInitScript(() => {
      Object.defineProperty(Crypto.prototype, 'subtle', { get: () => undefined });
    });
    await page.goto(`${baseUrl}/a/index.html`);
    await page.waitForSelector('#veil-prompt:not(.veil-hidden)');
    await page.waitForFunction(() =>
      document.getElementById('veil-error').textContent.includes('HTTPS'));
    assert.equal(await page.evaluate(() => document.getElementById('veil-btn').disabled), true);
    await context.close();
  });

  it('--no-inline: same-origin CSS and images load, external script src is CSP-blocked', async () => {
    const { context, page } = await newPage();
    const cspViolations = [];
    page.on('console', (m) => {
      if (/Content Security Policy/i.test(m.text())) cspViolations.push(m.text());
    });
    await page.goto(`${baseUrl}/ni/index.html`);
    await submitPass(page, PASS);
    await page.waitForSelector('#marker-ni');
    await page.waitForFunction(() => document.getElementById('im').complete);
    const r = await page.evaluate(() => ({
      bg: getComputedStyle(document.body).backgroundColor,
      imgWidth: document.getElementById('im').naturalWidth,
      appRan: window.appRan,
    }));
    assert.equal(r.bg, 'rgb(4, 5, 6)', 'same-origin stylesheet must load');
    assert.equal(r.imgWidth, 1, 'same-origin image must load');
    assert.equal(r.appRan, undefined, 'script src must be blocked by the CSP');
    assert.ok(cspViolations.some((t) => /app\.js|script/i.test(t)), 'expected a CSP violation for the script');
    await context.close();
  });
});
