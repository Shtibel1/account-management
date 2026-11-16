import { test } from 'node:test';
import assert from 'node:assert/strict';
import { APP_ROUTE_PREFIXES, ACCOUNTANTS_PATH, PUBLIC_INDEXABLE_PAGES, jsonLd, pageMetadata, PRODUCT, SCAN_SITE, resolveSiteBaseUrl } from './seo';
import { classifyPath } from './routeAccess';
import { SECURITY_HEADER_RULES } from './securityHeaders';

test('site base URL: NEXT_PUBLIC_SITE_URL, then the Amplify branch domain, then local dev', () => {
  assert.equal(resolveSiteBaseUrl({ siteUrl: 'https://example.co.il/some/path' }), 'https://example.co.il');
  assert.equal(resolveSiteBaseUrl({ siteUrl: 'ftp://example.co.il', amplifyAppId: 'd1qccb7exs3uyj', amplifyBranch: 'qa' }), 'https://qa.d1qccb7exs3uyj.amplifyapp.com');
  assert.equal(resolveSiteBaseUrl({ amplifyAppId: 'd1qccb7exs3uyj', amplifyBranch: 'feat/x' }), 'https://feat-x.d1qccb7exs3uyj.amplifyapp.com');
  assert.equal(resolveSiteBaseUrl({}), 'http://localhost:3001');
});

test('sitemap pages are public, indexable and never an app route', () => {
  for (const { path } of PUBLIC_INDEXABLE_PAGES) {
    assert.equal(classifyPath(path), 'public', path);
    assert.ok(!APP_ROUTE_PREFIXES.some((p) => path === p || path.startsWith(p + '/')), path);
  }
  assert.ok(PUBLIC_INDEXABLE_PAGES.some((p) => p.path === ACCOUNTANTS_PATH));
  assert.ok(!PUBLIC_INDEXABLE_PAGES.some((p) => p.path === '/login' || p.path === '/signup'));
});

test('the accountants page is public (no login redirect)', () => {
  assert.equal(classifyPath('/accountants'), 'public');
  assert.equal(classifyPath('/accountants/'), 'public');
});

test('every app route prefix gets an X-Robots-Tag noindex header', () => {
  for (const prefix of APP_ROUTE_PREFIXES) {
    const rule = SECURITY_HEADER_RULES.find((r) => r.source === `${prefix}/:path*` && r.headers.some((h) => h.key === 'X-Robots-Tag'));
    assert.ok(rule, prefix);
  }
  assert.ok(!SECURITY_HEADER_RULES.some((r) => r.source.startsWith('/accountants') || r.source.startsWith('/login')));
});

test('pageMetadata: canonical, Open Graph site name and robots per audience', () => {
  const m = pageMetadata({ title: 'T', description: 'D', path: '/accountants', siteName: PRODUCT });
  assert.deepEqual(m.alternates, { canonical: '/accountants' });
  assert.equal((m.openGraph as { siteName?: string }).siteName, PRODUCT);
  assert.deepEqual(m.robots, { index: true, follow: true });
  const login = pageMetadata({ title: 'T', description: 'D', path: '/login', siteName: PRODUCT, noindex: true });
  assert.deepEqual(login.robots, { index: false, follow: true });
  const scan = pageMetadata({ title: 'T', description: 'D', path: '/', siteName: SCAN_SITE });
  assert.equal((scan.openGraph as { siteName?: string }).siteName, SCAN_SITE);
});

test('jsonLd escapes "<" so the script tag cannot be closed early', () => {
  const out = jsonLd({ name: '</script><b>' });
  assert.ok(!out.includes('<'));
  assert.deepEqual(JSON.parse(out), { name: '</script><b>' });
});
