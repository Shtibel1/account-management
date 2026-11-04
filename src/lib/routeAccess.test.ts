import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_AFTER_LOGIN, homeRedirectPath } from './routeAccess';

test('home page: signed-in users go to the app, expired sessions to login, new visitors stay', () => {
  assert.equal(homeRedirectPath(true, true), DEFAULT_AFTER_LOGIN);
  assert.equal(homeRedirectPath(true, false), DEFAULT_AFTER_LOGIN);
  assert.equal(homeRedirectPath(false, true), '/login');
  assert.equal(homeRedirectPath(false, false), null);
});
