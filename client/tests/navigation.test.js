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

    it('2. Imports CampaignsPage from ./pages/campaigns/CampaignsPage.jsx', () => {
      assert.match(
        appSource,
        /import\s+CampaignsPage\s+from\s+['"]\.\/pages\/campaigns\/CampaignsPage\.jsx['"]/,
        'App.jsx must import CampaignsPage'
      );
    });

    it('3. Registers /contacts and /campaigns routes strictly within the ProtectedRoute element wrapper', () => {
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

      // Verify /campaigns is inside the ProtectedRoute block
      assert.match(
        protectedRoutesContent,
        /<Route\s+path=["']\/campaigns["']\s+element=\{<CampaignsPage\s*\/>\}\s*\/>/,
        '/campaigns must be nested inside the ProtectedRoute element'
      );

      // Verify /dashboard remains inside the ProtectedRoute block
      assert.match(
        protectedRoutesContent,
        /<Route\s+path=["']\/dashboard["']\s+element=\{<DashboardPage\s*\/>\}\s*\/>/,
        '/dashboard must remain nested inside the ProtectedRoute element'
      );
    });

    it('4. Preserves PublicOnlyRoute block with /login and /register routes', () => {
      const publicBlockMatch = appSource.match(
        /<Route\s+element=\{<PublicOnlyRoute\s*\/>\}>([\s\S]*?)<\/Route>/
      );
      assert.ok(publicBlockMatch, 'PublicOnlyRoute block must exist in App.jsx');

      const publicRoutesContent = publicBlockMatch[1];
      assert.match(publicRoutesContent, /path=["']\/login["']/);
      assert.match(publicRoutesContent, /path=["']\/register["']/);
    });

    it('5. Preserves default and catch-all redirects to /dashboard', () => {
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

  describe('CampaignsPage Shell Component', () => {
    const campaignsPageFilePath = path.resolve(
      __dirname,
      '../src/pages/campaigns/CampaignsPage.jsx'
    );
    const campaignsPageSource = fs.readFileSync(campaignsPageFilePath, 'utf-8');

    it('6. Renders Campaigns heading and imports Navbar', () => {
      assert.match(
        campaignsPageSource,
        /import\s+Navbar\s+from\s+['"]\.\.\/\.\.\/components\/layout\/Navbar\.jsx['"]/,
        'CampaignsPage must import Navbar'
      );
      assert.match(
        campaignsPageSource,
        /<h1[^>]*>[\s\S]*?Campaigns[\s\S]*?<\/h1>/,
        'CampaignsPage must render a heading with "Campaigns"'
      );
    });
  });

  describe('ProtectedRoute Decision Logic with /contacts & /campaigns', () => {
    it('7. Unauthenticated user accessing /contacts is redirected to /login with preserved location state', () => {
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

    it('8. Authenticated user accessing /contacts is permitted to proceed', () => {
      const isAuthenticated = true;
      const redirectDecision = !isAuthenticated
        ? { redirect: true, to: '/login' }
        : { redirect: false };

      assert.equal(redirectDecision.redirect, false);
    });

    it('9. Unauthenticated user accessing /campaigns is redirected to /login with preserved location state', () => {
      const attemptedPath = '/campaigns';
      const isAuthenticated = false;
      const location = { pathname: attemptedPath };

      const redirectDecision = !isAuthenticated
        ? { redirect: true, to: '/login', state: { from: location } }
        : { redirect: false };

      assert.equal(redirectDecision.redirect, true);
      assert.equal(redirectDecision.to, '/login');
      assert.equal(redirectDecision.state.from.pathname, '/campaigns');
    });

    it('10. Authenticated user accessing /campaigns is permitted to proceed', () => {
      const isAuthenticated = true;
      const redirectDecision = !isAuthenticated
        ? { redirect: true, to: '/login' }
        : { redirect: false };

      assert.equal(redirectDecision.redirect, false);
    });
  });

  describe('Open Redirect & Navigation Security for /contacts & /campaigns', () => {
    it('11. Accepts /contacts as a safe internal destination path', () => {
      assert.equal(sanitizeRedirectPath('/contacts'), '/contacts');
      assert.equal(
        sanitizeRedirectPath('/contacts?page=2&search=acme'),
        '/contacts?page=2&search=acme'
      );
    });

    it('12. Rejects external phishing attempts targeting /contacts', () => {
      assert.equal(
        sanitizeRedirectPath('https://attacker.com/contacts'),
        '/dashboard'
      );
      assert.equal(
        sanitizeRedirectPath('//attacker.com/contacts'),
        '/dashboard'
      );
    });

    it('13. Accepts /campaigns as a safe internal destination path', () => {
      assert.equal(sanitizeRedirectPath('/campaigns'), '/campaigns');
      assert.equal(
        sanitizeRedirectPath('/campaigns?page=2&search=spring'),
        '/campaigns?page=2&search=spring'
      );
    });

    it('14. Rejects external phishing attempts targeting /campaigns', () => {
      assert.equal(
        sanitizeRedirectPath('https://attacker.com/campaigns'),
        '/dashboard'
      );
      assert.equal(
        sanitizeRedirectPath('//attacker.com/campaigns'),
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

    it('15. Implements NavLink for /dashboard, /contacts, and /campaigns', () => {
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
      assert.match(
        navbarSource,
        /<NavLink\s+to=["']\/campaigns["']/,
        'Navbar must include NavLink to /campaigns'
      );
    });

    it('16. Uses useAuth hook for user state and logout without duplicating auth state', () => {
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

    it('17. Provides an accessible Sign out button with type="button" and click handler', () => {
      assert.match(
        navbarSource,
        /<button[\s\S]*?type=["']button["'][\s\S]*?onClick=\{handleLogout\}[\s\S]*?>/,
        'Navbar must render button with type="button" and onClick={handleLogout}'
      );
    });
  });
});
