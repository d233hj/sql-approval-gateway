import assert from 'node:assert/strict';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import test from 'node:test';

import { randomToken } from '../src/util.js';
import {
  addTestSource,
  bearer,
  cookieAuth,
  cookieFrom,
  request,
  setupAndUnlock,
  startTestGateway,
  submitProposal,
  uniquePassword,
} from './helpers.js';

function bodyOf(response: { json: unknown }): Record<string, unknown> {
  return (response.json ?? {}) as Record<string, unknown>;
}

test('setup leaves LOCKED; unlock issues HttpOnly cookie; lock and re-unlock work', async (t) => {
  const app = await startTestGateway(t);
  const password = uniquePassword();
  const setup = await request(app.url, '/v1/admin/setup', {
    method: 'POST',
    body: { password, confirm: password },
  });
  assert.equal(setup.status, 200, setup.text);
  const setupBody = bodyOf(setup);
  assert.equal(typeof setupBody.agent_token, 'string');
  assert.equal(String(setupBody.agent_token).startsWith('sag_'), true);
  assert.equal(setup.text.includes(password), false);

  const lockedState = await request(app.url, '/v1/admin/state');
  assert.deepEqual(bodyOf(lockedState), {
    configured: true,
    unlocked: false,
    version: '0.1.0',
  });

  const unlock = await request(app.url, '/v1/admin/unlock', {
    method: 'POST',
    headers: { 'X-SAG-Want-Token': '1' },
    body: { password },
  });
  assert.equal(unlock.status, 200, unlock.text);
  const unlockBody = bodyOf(unlock);
  assert.equal(typeof unlockBody.csrfToken, 'string');
  assert.equal(typeof unlockBody.token, 'string');
  assert.equal(String(unlockBody.token).startsWith('sag_'), false);
  const cookieHeader = String(unlock.headers['set-cookie']);
  assert.match(cookieHeader, /HttpOnly/);
  assert.match(cookieHeader, /SameSite=Strict/);
  assert.equal(unlock.text.includes(password), false);

  const unlockedState = await request(app.url, '/v1/admin/state');
  assert.equal(bodyOf(unlockedState).unlocked, true);

  const missingCsrf = await request(app.url, '/v1/admin/lock', {
    method: 'POST',
    headers: { Cookie: cookieFrom(unlock) },
  });
  assert.equal(missingCsrf.status, 403, missingCsrf.text);
  assert.equal(bodyOf(missingCsrf).code, 'CSRF_REJECTED');

  const lock = await request(app.url, '/v1/admin/lock', {
    method: 'POST',
    headers: bearer(String(unlockBody.token)),
  });
  assert.equal(lock.status, 200, lock.text);
  assert.equal(bodyOf(await request(app.url, '/v1/admin/state')).unlocked, false);

  const relock = await request(app.url, '/v1/admin/lock', {
    method: 'POST',
    headers: bearer(String(unlockBody.token)),
  });
  assert.equal(relock.status, 200, 'lock is idempotent once already locked');

  const unlockAgain = await request(app.url, '/v1/admin/unlock', {
    method: 'POST',
    body: { password },
  });
  assert.equal(unlockAgain.status, 200, unlockAgain.text);
  assert.equal('token' in bodyOf(unlockAgain), false, 'token must require X-SAG-Want-Token');
  assert.ok(cookieFrom(unlockAgain).startsWith('sag_session='));
});

test('wrong password returns one generic failure and never a session', async (t) => {
  const app = await startTestGateway(t);
  const password = uniquePassword();
  await request(app.url, '/v1/admin/setup', {
    method: 'POST',
    body: { password, confirm: password },
  });

  const wrongPassword = uniquePassword();
  const failed = await request(app.url, '/v1/admin/unlock', {
    method: 'POST',
    body: { password: wrongPassword },
  });
  assert.equal(failed.status, 401);
  assert.equal(bodyOf(failed).code, 'UNAUTHENTICATED');
  assert.equal(bodyOf(failed).message, 'Authentication failed');
  assert.equal(failed.headers['set-cookie'], undefined);
  assert.equal('csrfToken' in bodyOf(failed), false);
  assert.equal(failed.text.includes(wrongPassword), false);

  const retry = await request(app.url, '/v1/admin/unlock', {
    method: 'POST',
    body: { password },
  });
  assert.equal(retry.status, 200, retry.text);
});

test('concurrent setup has exactly one winner, one 409, and one valid token', async (t) => {
  const app = await startTestGateway(t);
  const firstPassword = uniquePassword();
  const secondPassword = uniquePassword();

  const [first, second] = await Promise.all([
    request(app.url, '/v1/admin/setup', {
      method: 'POST',
      body: { password: firstPassword, confirm: firstPassword },
    }),
    request(app.url, '/v1/admin/setup', {
      method: 'POST',
      body: { password: secondPassword, confirm: secondPassword },
    }),
  ]);

  assert.deepEqual(
    [first.status, second.status].sort((a, b) => a - b),
    [200, 409],
    `${first.text}\n${second.text}`,
  );
  const winner = first.status === 200 ? first : second;
  const loser = first.status === 200 ? second : first;
  const winnerPassword = first.status === 200 ? firstPassword : secondPassword;
  const loserPassword = first.status === 200 ? secondPassword : firstPassword;
  const winnerBody = bodyOf(winner);
  const loserBody = bodyOf(loser);

  assert.equal(loserBody.code, 'ALREADY_CONFIGURED');
  assert.equal('agent_token' in loserBody, false);
  assert.equal(typeof winnerBody.agent_token, 'string');
  const agentToken = String(winnerBody.agent_token);
  assert.equal(agentToken.startsWith('sag_'), true);
  const tokenResponses = [first, second].filter(
    (response) => typeof bodyOf(response).agent_token === 'string',
  );
  assert.equal(tokenResponses.length, 1, 'only the winning setup may expose a token');
  assert.equal(app.gateway.store.listClients().length, 1, 'only one agent client is stored');

  const failedUnlock = await request(app.url, '/v1/admin/unlock', {
    method: 'POST',
    body: { password: loserPassword },
  });
  const successfulUnlock = await request(app.url, '/v1/admin/unlock', {
    method: 'POST',
    body: { password: winnerPassword },
  });
  assert.equal([failedUnlock.status, successfulUnlock.status].filter((s) => s === 200).length, 1);
  assert.equal(failedUnlock.status, 401);
  assert.equal(successfulUnlock.status, 200, successfulUnlock.text);

  const sources = await request(app.url, '/v1/agent/sources', {
    headers: bearer(agentToken),
  });
  assert.equal(sources.status, 200, sources.text);
  assert.deepEqual(sources.json, []);
});

test('SAG_SETUP_PASSWORD_FILE bootstraps once, deletes the file, and writes a token once', async (t) => {
  const password = uniquePassword();
  const app = await startTestGateway(t, { setupPasswordFileContent: password });

  assert.ok(app.setupPasswordFile);
  assert.equal(existsSync(app.setupPasswordFile), false, 'password file must be deleted after read');
  assert.deepEqual(bodyOf(await request(app.url, '/v1/admin/state')), {
    configured: true,
    unlocked: false,
    version: '0.1.0',
  });

  const tokenFile = join(app.dir, 'agent-token.once');
  assert.equal(existsSync(tokenFile), true);
  const agentToken = readFileSync(tokenFile, 'utf8').trim();
  assert.equal(agentToken.startsWith('sag_'), true);
  if (process.platform === 'win32') {
    // Windows ignores the POSIX mode and inherits the data directory ACL, so
    // there is no mode to assert: verify the documented token format and that
    // the file lives directly in the data directory; the ACL is the boundary.
    assert.match(agentToken, /^sag_[A-Za-z0-9_-]{43}$/);
    assert.equal(dirname(tokenFile), app.dir);
  } else {
    assert.equal(statSync(tokenFile).mode & 0o777, 0o600);
  }

  const unlock = await request(app.url, '/v1/admin/unlock', {
    method: 'POST',
    body: { password },
  });
  assert.equal(unlock.status, 200, unlock.text);

  const sources = await request(app.url, '/v1/agent/sources', {
    headers: bearer(agentToken),
  });
  assert.equal(sources.status, 200, sources.text);
  assert.deepEqual(sources.json, []);

  const health = await request(app.url, '/v1/health');
  assert.equal(health.text.includes('agent-token.once'), false);
  assert.equal(health.text.includes(app.dir), false);
  assert.equal(health.text.includes(agentToken), false);
});

test('Host and Origin checks reject foreign values while allowing the loopback origin', async (t) => {
  const app = await startTestGateway(t);
  const port = new URL(app.url).port;

  const badHost = await request(app.url, '/v1/health', {
    headers: { Host: 'attacker.example' },
  });
  assert.equal(badHost.status, 400, badHost.text);
  assert.equal(bodyOf(badHost).code, 'INVALID_HOST');

  const badOrigin = await request(app.url, '/v1/health', {
    headers: { Origin: 'https://attacker.example' },
  });
  assert.equal(badOrigin.status, 403, badOrigin.text);
  assert.equal(bodyOf(badOrigin).code, 'ORIGIN_REJECTED');

  const origin = `http://127.0.0.1:${port}`;
  const goodOrigin = await request(app.url, '/v1/health', {
    headers: { Origin: origin, Host: `127.0.0.1:${port}` },
  });
  assert.equal(goodOrigin.status, 200, goodOrigin.text);
  assert.equal(goodOrigin.headers['access-control-allow-origin'], origin);

  const preflight = await request(app.url, '/v1/agent/proposals', {
    method: 'OPTIONS',
    headers: {
      Origin: 'dsh-app://app',
      'Access-Control-Request-Method': 'POST',
    },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers['access-control-allow-origin'], 'dsh-app://app');
  assert.match(String(preflight.headers['access-control-allow-headers']), /x-sag-csrf/);
});

test('invalid agent tokens are rejected and an agent token cannot approve', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });

  const noAuth = await request(app.url, '/v1/agent/sources');
  assert.equal(noAuth.status, 401);
  assert.equal(bodyOf(noAuth).code, 'UNAUTHENTICATED');

  const invalid = await request(app.url, '/v1/agent/sources', {
    headers: bearer(`sag_${randomToken(32)}`),
  });
  assert.equal(invalid.status, 401);
  assert.equal(bodyOf(invalid).code, 'UNAUTHENTICATED');

  const valid = await request(app.url, '/v1/agent/sources', {
    headers: bearer(auth.agentToken),
  });
  assert.equal(valid.status, 200);
  assert.deepEqual(valid.json, []);

  const approveWithAgent = await request(app.url, '/v1/admin/proposals/any/approve', {
    method: 'POST',
    headers: bearer(auth.agentToken),
  });
  assert.equal(approveWithAgent.status, 401);
  assert.equal(bodyOf(approveWithAgent).code, 'UNAUTHENTICATED');

  const adminSourcesWithAgent = await request(app.url, '/v1/admin/sources', {
    headers: bearer(auth.agentToken),
  });
  assert.equal(adminSourcesWithAgent.status, 401);
});

test('locked approval returns NOT_UNLOCKED; unlocked approval is atomic and pending-only', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const source = await addTestSource(app, auth);

  const lockResponse = await request(app.url, '/v1/admin/lock', {
    method: 'POST',
    headers: bearer(auth.sessionToken),
  });
  assert.equal(lockResponse.status, 200, lockResponse.text);

  const submitted = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: {
      source_id: source.id,
      sql: 'SELECT 2 AS two',
      purpose: 'submitted while locked',
    },
  });
  assert.equal(submitted.status, 201, submitted.text);
  const lockedProposal = bodyOf(submitted);
  assert.equal(lockedProposal.status, 'PENDING_APPROVAL');

  const lockedApprove = await request(app.url, `/v1/admin/proposals/${lockedProposal.id}/approve`, {
    method: 'POST',
  });
  assert.equal(lockedApprove.status, 423, lockedApprove.text);
  assert.equal(bodyOf(lockedApprove).code, 'NOT_UNLOCKED');

  const unlockAgain = await request(app.url, '/v1/admin/unlock', {
    method: 'POST',
    headers: { 'X-SAG-Want-Token': '1' },
    body: { password: auth.password },
  });
  assert.equal(unlockAgain.status, 200, unlockAgain.text);
  const fresh = bodyOf(unlockAgain);

  const approve = await request(app.url, `/v1/admin/proposals/${String(lockedProposal.id)}/approve`, {
    method: 'POST',
    headers: bearer(String(fresh.token)),
  });
  assert.equal(approve.status, 200, approve.text);
  // The test source has no database file configured, so the strict
  // approval-time probe fails before execution: the response carries only the
  // error code, never driver text, and no result rows are stored.
  assert.equal(bodyOf(approve).status, 'FAILED');
  assert.equal(bodyOf(approve).error_code, 'SOURCE_PROBE_FAILED');
  assert.equal(bodyOf(approve).result, null);
  assert.equal('execution' in bodyOf(approve), false);

  const rows = await request(app.url, `/v1/admin/proposals/${String(lockedProposal.id)}/rows`, {
    headers: bearer(String(fresh.token)),
  });
  assert.equal(rows.status, 409, rows.text);
  assert.equal(bodyOf(rows).code, 'INVALID_STATE');

  const duplicate = await request(app.url, `/v1/admin/proposals/${String(lockedProposal.id)}/approve`, {
    method: 'POST',
    headers: bearer(String(fresh.token)),
  });
  assert.equal(duplicate.status, 409, duplicate.text);
  assert.equal(bodyOf(duplicate).code, 'INVALID_STATE');
});

test('simultaneous HTTP approvals produce one success and one conflict', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const source = await addTestSource(app, auth);
  const proposal = await submitProposal(app, auth.agentToken, source.id);

  const [first, second] = await Promise.all([
    request(app.url, `/v1/admin/proposals/${proposal.id}/approve`, {
      method: 'POST',
      headers: bearer(auth.sessionToken),
    }),
    request(app.url, `/v1/admin/proposals/${proposal.id}/approve`, {
      method: 'POST',
      headers: bearer(auth.sessionToken),
    }),
  ]);
  assert.deepEqual([first.status, second.status].sort((a, b) => a - b), [200, 409]);

  const verification = await request(app.url, '/v1/admin/audit/verify', {
    headers: bearer(auth.sessionToken),
  });
  assert.equal(verification.status, 200, verification.text);
  assert.equal(bodyOf(verification).valid, true);
  assert.ok(Number(bodyOf(verification).checked) >= 3);
});

test('source and proposal APIs never return connection information', async (t) => {
  const app = await startTestGateway(t);
  const auth = await setupAndUnlock(app, { wantToken: true });
  const marker = randomToken(24);
  const added = await addTestSource(app, auth, { marker });
  assert.equal(added.dialect, 'sqlite');
  assert.equal(JSON.stringify(added).includes(marker), false);
  assert.equal('connection' in added, false);

  const sources = await request(app.url, '/v1/agent/sources', {
    headers: bearer(auth.agentToken),
  });
  assert.equal(sources.status, 200);
  assert.equal(Array.isArray(sources.json), true);
  assert.deepEqual(Object.keys((sources.json as Array<Record<string, unknown>>)[0]!).sort(), [
    'dialect',
    'id',
    'name',
  ]);
  assert.equal(sources.text.includes(marker), false);
  assert.equal(/"connection"|"password"|"username"|"host"|"database"/.test(sources.text), false);

  const adminSources = await request(app.url, '/v1/admin/sources', {
    headers: { Cookie: auth.cookie },
  });
  assert.equal(adminSources.status, 200, adminSources.text);
  assert.equal(adminSources.text.includes(marker), false);

  const proposal = await submitProposal(app, auth.agentToken, added.id);
  const proposalStatus = await request(app.url, `/v1/agent/proposals/${String(proposal.id)}`, {
    headers: bearer(auth.agentToken),
  });
  assert.equal(proposalStatus.status, 200);
  assert.equal(proposalStatus.text.includes(marker), false);
  assert.equal(/"connection"|"password"|"username"|"host"|"database"/.test(proposalStatus.text), false);

  const health = await request(app.url, '/v1/health');
  const state = await request(app.url, '/v1/admin/state');
  assert.equal(health.text.includes(app.dir), false);
  assert.equal(state.text.includes(app.dir), false);
  assert.equal(health.text.includes(marker), false);

  const vaultText = readFileSync(join(app.dir, 'vault.json'), 'utf8');
  assert.equal(vaultText.includes(marker), false);
});

test('idle session expiry locks the vault and invalidates the cookie', async (t) => {
  let now = Date.parse('2026-07-01T12:00:00.000Z');
  const app = await startTestGateway(t, { clock: () => now });
  const auth = await setupAndUnlock(app);
  assert.equal(bodyOf(await request(app.url, '/v1/admin/state')).unlocked, true);

  // Session bounds are persisted settings; 1 minute is the smallest window.
  app.gateway.store.updateSettings(
    { 'session.idle_minutes': JSON.stringify(1) },
    'admin',
    now,
  );
  now += 60_001;
  const expired = await request(app.url, '/v1/admin/proposals', {
    headers: { Cookie: auth.cookie },
  });
  assert.equal(expired.status, 401, expired.text);
  assert.equal(bodyOf(expired).code, 'UNAUTHENTICATED');
  assert.equal(bodyOf(await request(app.url, '/v1/admin/state')).unlocked, false);
});

test('request body limit and content type are enforced before parsing', async (t) => {
  const app = await startTestGateway(t);
  const hugeBody = JSON.stringify({
    password: 'x'.repeat(300 * 1024),
    confirm: 'x',
  });
  const tooLarge = await request(app.url, '/v1/admin/setup', {
    method: 'POST',
    rawBody: hugeBody,
  });
  assert.equal(tooLarge.status, 413, tooLarge.text);
  assert.equal(bodyOf(tooLarge).code, 'PAYLOAD_TOO_LARGE');

  const wrongType = await request(app.url, '/v1/admin/setup', {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    rawBody: '{}',
  });
  assert.equal(wrongType.status, 415, wrongType.text);
  assert.equal(bodyOf(wrongType).code, 'UNSUPPORTED_MEDIA_TYPE');
});

test('password change invalidates other sessions but keeps the current one', async (t) => {
  const app = await startTestGateway(t);
  const password = uniquePassword();
  const setup = await request(app.url, '/v1/admin/setup', {
    method: 'POST',
    body: { password, confirm: password },
  });
  assert.equal(setup.status, 200);

  const first = await request(app.url, '/v1/admin/unlock', {
    method: 'POST',
    headers: { 'X-SAG-Want-Token': '1' },
    body: { password },
  });
  const second = await request(app.url, '/v1/admin/unlock', {
    method: 'POST',
    headers: { 'X-SAG-Want-Token': '1' },
    body: { password },
  });
  const firstBody = bodyOf(first);
  const secondBody = bodyOf(second);
  assert.equal(typeof firstBody.token, 'string');
  assert.equal(typeof secondBody.token, 'string');

  const newPassword = uniquePassword();
  const changed = await request(app.url, '/v1/admin/password', {
    method: 'POST',
    headers: bearer(String(firstBody.token)),
    body: { current: password, new: newPassword },
  });
  assert.equal(changed.status, 200, changed.text);

  const oldSession = await request(app.url, '/v1/admin/proposals', {
    headers: bearer(String(secondBody.token)),
  });
  assert.equal(oldSession.status, 401, oldSession.text);

  const keptSession = await request(app.url, '/v1/admin/proposals', {
    headers: bearer(String(firstBody.token)),
  });
  assert.equal(keptSession.status, 200, keptSession.text);

  const lock = await request(app.url, '/v1/admin/lock', {
    method: 'POST',
    headers: bearer(String(firstBody.token)),
  });
  assert.equal(lock.status, 200);
  const oldPassword = await request(app.url, '/v1/admin/unlock', {
    method: 'POST',
    body: { password },
  });
  assert.equal(oldPassword.status, 401);
  const newUnlock = await request(app.url, '/v1/admin/unlock', {
    method: 'POST',
    body: { password: newPassword },
  });
  assert.equal(newUnlock.status, 200, newUnlock.text);
});
