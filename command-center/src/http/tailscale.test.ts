import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAILSCALE_LOGIN_HEADER, isTailscaleOwner, normalizeTailscaleLogin, tailscaleLoginFromEnv } from './tailscale.ts';

const LOGIN = 'owner@example.com';

/** A request as the predicate sees it: node's lower-cased headers and the TCP peer (null: none known). */
function req(headers: Record<string, string | string[] | undefined>, remoteAddress: string | null = '127.0.0.1') {
  return { headers, socket: { remoteAddress: remoteAddress ?? undefined } } as unknown as Parameters<typeof isTailscaleOwner>[0];
}

test('off until a login is configured, whatever the request says', () => {
  const owner = req({ [TAILSCALE_LOGIN_HEADER]: LOGIN });
  assert.equal(isTailscaleOwner(owner, undefined), false);
  assert.equal(isTailscaleOwner(owner, ''), false);
  assert.equal(isTailscaleOwner(owner, '   '), false);
});

test('on for the configured login from a loopback peer, in any letter case', () => {
  for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isTailscaleOwner(req({ [TAILSCALE_LOGIN_HEADER]: LOGIN }, peer), LOGIN), true, peer);
  }
  assert.equal(isTailscaleOwner(req({ [TAILSCALE_LOGIN_HEADER]: 'Owner@Example.COM' }), LOGIN), true);
  assert.equal(isTailscaleOwner(req({ [TAILSCALE_LOGIN_HEADER]: LOGIN }), '  OWNER@example.com '), true);
});

test('off when the peer is not loopback: the proxy is on this machine, a LAN peer is not it', () => {
  for (const peer of ['192.168.1.20', '100.64.0.7', '10.0.0.1', '::ffff:192.168.1.20', null]) {
    assert.equal(isTailscaleOwner(req({ [TAILSCALE_LOGIN_HEADER]: LOGIN }, peer), LOGIN), false, String(peer));
  }
});

test('off when the header is missing, repeated, or names someone else', () => {
  assert.equal(isTailscaleOwner(req({}), LOGIN), false);
  assert.equal(isTailscaleOwner(req({ [TAILSCALE_LOGIN_HEADER]: '' }), LOGIN), false);
  assert.equal(isTailscaleOwner(req({ [TAILSCALE_LOGIN_HEADER]: 'guest@example.com' }), LOGIN), false);
  assert.equal(isTailscaleOwner(req({ [TAILSCALE_LOGIN_HEADER]: `${LOGIN}.evil.example` }), LOGIN), false);
  assert.equal(isTailscaleOwner(req({ [TAILSCALE_LOGIN_HEADER]: `guest@example.com, ${LOGIN}` }), LOGIN), false);
  assert.equal(isTailscaleOwner(req({ [TAILSCALE_LOGIN_HEADER]: [LOGIN] }), LOGIN), false);
  // The other identity headers are not the login.
  assert.equal(isTailscaleOwner(req({ 'tailscale-user-name': LOGIN }), LOGIN), false);
});

test('tailscaleLoginFromEnv trims and lower-cases, and a blank value leaves identity off', () => {
  assert.equal(tailscaleLoginFromEnv({}), undefined);
  assert.equal(tailscaleLoginFromEnv({ CC_TAILSCALE_LOGIN: '' }), undefined);
  assert.equal(tailscaleLoginFromEnv({ CC_TAILSCALE_LOGIN: '   ' }), undefined);
  assert.equal(tailscaleLoginFromEnv({ CC_TAILSCALE_LOGIN: ' Owner@Example.com ' }), LOGIN);
  assert.equal(normalizeTailscaleLogin(undefined), undefined);
});
