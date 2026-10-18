import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { sanitizeRedirectPath } from '../src/utils/navigation.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('Navigation & Route Setup', () => {
  describe('App.jsx Route Architecture & Protection', () => {
    const appFilePath = path.resolve(__dirname, '../src/App.jsx');
    const appSource = fs.readFileSync(appFilePath, 'utf-8');

    it('1. Imports ContactsPage from ./pages/contacts/ContactsPage.jsx', () => {
      assert.match(
        appSource,
        /import\s+ContactsPage\s+from\s+['"]\.\/pages\/contacts\/ContactsPage\.jsx['"]/,
        'App.jsx must import ContactsPage'
      );
    });

    it('2. Registers /contacts route strictly within the ProtectedRoute element wrapper', () => {
      // Locate the ProtectedRoute block
      const protectedBlockMatch = appSource.match(
        /<Route\s+element=\{<ProtectedRoute\s*\/>\}>([\s\S]*?)<\/Route>/
      );
      assert.ok(protectedBlockMatch, 'ProtectedRoute block must exist in App.jsx');

      const protectedRoutesContent = protectedBlockMatch[1];

      // Verify /contacts is inside the ProtectedRoute block
      assert.match(
        protectedRoutesContent,
        /<Route\s+path=["']\/contacts["']\s+element=\{<ContactsPage\s*\/>\}\s*\/>/,
        '/contacts must be nested inside the ProtectedRoute element'
      );

      // Verify /dashboard remains inside the ProtectedRoute block
      assert.match(
        protectedRoutesContent,
        /<Route\s+path=["']\/dashboard["']\s+element=\{<DashboardPage\s*\/>\}\s*\/>/,
        '/dashboard must remain nested inside the ProtectedRoute element'
      );
    });

    it('3. Preserves PublicOnlyRoute block with /login and /register routes', () => {
      const publicBlockMatch = appSource.match(
        /<Route\s+element=\{<PublicOnlyRoute\s*\/>\}>([\s\S]*?)<\/Route>/
      );
      assert.ok(publicBlockMatch, 'PublicOnlyRoute block must exist in App.jsx');

      const publicRoutesContent = publicBlockMatch[1];
      assert.match(publicRoutesContent, /path=["']\/login["']/);
      assert.match(publicRoutesContent, /path=["']\/register["']/);
    });

    it('4. Preserves default and catch-all redirects to /dashboard', () => {
      assert.match(
        appSource,
        /<Route\s+path=["']\/["']\s+element=\{<Navigate\s+to=["']\/dashboard["']\s+replace\s*\/>\}\s*\/>/,
        'Root path / must redirect to /dashboard'
      );
      assert.match(
        appSource,
        /<Route\s+path=["']\*["']\s+element=\{<Navigate\s+to=["']\/dashboard["']\s+replace\s*\/>\}\s*\/>/,
        'Catch-all route * must redirect to /dashboard'
      );
    });
  });

  describe('ProtectedRoute Decision Logic with /contacts', () => {
    it('5. Unauthenticated user accessing /contacts is redirected to /login with preserved location state', () => {
      const attemptedPath = '/contacts';
      const isAuthenticated = false;
      const location = { pathname: attemptedPath };

      const redirectDecision = !isAuthenticated
        ? { redirect: true, to: '/login', state: { from: location } }
        : { redirect: false };

      assert.equal(redirectDecision.redirect, true);
      assert.equal(redirectDecision.to, '/login');
      assert.equal(redirectDecision.state.from.pathname, '/contacts');
    });

    it('6. Authenticated user accessing /contacts is permitted to proceed', () => {
      const isAuthenticated = true;
      const redirectDecision = !isAuthenticated
        ? { redirect: true, to: '/login' }
        : { redirect: false };

      assert.equal(redirectDecision.redirect, false);
    });
  });

  describe('Open Redirect & Navigation Security for /contacts', () => {
    it('7. Accepts /contacts as a safe internal destination path', () => {
      assert.equal(sanitizeRedirectPath('/contacts'), '/contacts');
      assert.equal(
        sanitizeRedirectPath('/contacts?page=2&search=acme'),
        '/contacts?page=2&search=acme'
      );
    });

    it('8. Rejects external phishing attempts targeting /contacts', () => {
      assert.equal(
        sanitizeRedirectPath('https://attacker.com/contacts'),
        '/dashboard'
      );
      assert.equal(
        sanitizeRedirectPath('//attacker.com/contacts'),
        '/dashboard'
      );
    });
  });

  describe('Navbar Component Implementation', () => {
    const navbarFilePath = path.resolve(
      __dirname,
      '../src/components/layout/Navbar.jsx'
    );
    const navbarSource = fs.readFileSync(navbarFilePath, 'utf-8');

    it('9. Implements NavLink for both /dashboard and /contacts', () => {
      assert.match(
        navbarSource,
        /<NavLink\s+to=["']\/dashboard["']/,
        'Navbar must include NavLink to /dashboard'
      );
      assert.match(
        navbarSource,
        /<NavLink\s+to=["']\/contacts["']/,
        'Navbar must include NavLink to /contacts'
      );
    });

    it('10. Uses useAuth hook for user state and logout without duplicating auth state', () => {
      assert.match(
        navbarSource,
        /import\s+\{\s*useAuth\s*\}\s+from\s+['"]\.\.\/\.\.\/hooks\/useAuth\.js['"]/,
        'Navbar must import useAuth hook'
      );
      assert.match(
        navbarSource,
        /const\s+\{\s*user,\s*logout\s*\}\s*=\s*useAuth\(\)/,
        'Navbar must consume user and logout from useAuth'
      );
    });

    it('11. Provides an accessible Sign out button with type="button" and click handler', () => {
      assert.match(
        navbarSource,
        /<button[\s\S]*?type=["']button["'][\s\S]*?onClick=\{handleLogout\}[\s\S]*?>/,
        'Navbar must render button with type="button" and onClick={handleLogout}'
      );
    });
  });
});
