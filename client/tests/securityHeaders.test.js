import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const nginx = fs.readFileSync(path.join(root, 'client/nginx.conf'), 'utf8');
const caddy = fs.readFileSync(path.join(root, 'Caddyfile'), 'utf8');
const indexHtml = fs.readFileSync(path.join(root, 'client/index.html'), 'utf8');

/** The text of `location / { ... }` (the single-page app block). */
const spaBlock = nginx.slice(nginx.indexOf('location / {'));
const header = (name) => new RegExp(`add_header ${name} "([^"]*)" always;`).exec(spaBlock)?.[1];

describe('UI security headers (client/nginx.conf)', () => {
  it('sets the baseline headers on every SPA response, even error responses (always)', () => {
    assert.equal(header('X-Content-Type-Options'), 'nosniff');
    assert.equal(header('X-Frame-Options'), 'DENY');
    assert.equal(header('Referrer-Policy'), 'no-referrer');
    assert.equal(header('Cross-Origin-Opener-Policy'), 'same-origin');
    assert.match(header('Permissions-Policy'), /camera=\(\)/);
  });

  it('has a Content-Security-Policy that blocks inline/eval scripts, framing and plugins', () => {
    const csp = header('Content-Security-Policy');
    assert.ok(csp, 'CSP present');
    const directive = (name) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(`${name} `));
    assert.equal(directive('script-src'), "script-src 'self'");
    assert.ok(!/unsafe-eval|unsafe-inline/.test(directive('script-src')));
    assert.match(directive('frame-ancestors'), /'none'/);
    assert.match(directive('object-src'), /'none'/);
    assert.match(directive('base-uri'), /'self'/);
    assert.match(directive('default-src'), /'self'/);
    // The sandboxed email preview inherits the policy; remote images must keep working there
    assert.match(directive('img-src'), /https:/);
    assert.equal(directive('connect-src'), "connect-src 'self'");
  });

  it('does not double the API headers: Helmet already covers /api/', () => {
    const apiBlock = nginx.slice(nginx.indexOf('location /api/'), nginx.indexOf('location / {'));
    assert.ok(!apiBlock.includes('add_header'));
  });

  it('adds HSTS where TLS is terminated (Caddy) and a referrer fallback in index.html', () => {
    assert.match(caddy, /Strict-Transport-Security "max-age=31536000; includeSubDomains"/);
    assert.match(indexHtml, /<meta name="referrer" content="no-referrer"/);
  });
});
