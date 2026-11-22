import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, '..');
const viteConfig = fs.readFileSync(path.join(root, 'vite.config.js'), 'utf8');

describe('Vite Build Configuration & Code Splitting', () => {
  it('configures rollupOptions output manualChunks in vite.config.js', () => {
    assert.match(viteConfig, /rollupOptions:\s*\{/, 'vite.config.js must specify rollupOptions');
    assert.match(viteConfig, /manualChunks\(id\)/, 'vite.config.js must define manualChunks');
  });

  it('splits heavy chart libraries (recharts, d3, victory) into a dedicated chunk', () => {
    assert.match(viteConfig, /node_modules\/recharts/);
    assert.match(viteConfig, /return ['"]recharts['"]/);
  });

  it('splits core framework libraries (react, react-dom, react-router-dom) into vendor chunk', () => {
    assert.match(viteConfig, /node_modules\/react/);
    assert.match(viteConfig, /return ['"]vendor['"]/);
  });
});
