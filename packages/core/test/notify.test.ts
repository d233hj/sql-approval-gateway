import assert from 'node:assert/strict';
import test from 'node:test';

import type { NewProposalNotification } from '../src/notify.js';
import {
  TOAST_BODY_TEXT_LIMIT,
  TOAST_MIN_INTERVAL_MS,
  TOAST_SPAWN_OPTIONS,
  TOAST_TITLE,
  buildToastBody,
  buildToastScript,
  createToastRateLimitState,
  shouldNotify,
} from '../src/notify.js';
import {
  addTestSource,
  bearer,
  request,
  setupAndUnlock,
  startTestGateway,
} from './helpers.js';

function bodyOf(response: { json: unknown }): Record<string, unknown> {
  return (response.json ?? {}) as Record<string, unknown>;
}

test('buildToastScript uses ToastText02 with the fixed Chinese title and no double quotes', () => {
  const script = buildToastScript({
    sourceName: 'ERP 生产库',
    purpose: '核对本月产量',
    proposalId: '11111111-1111-1111-1111-111111111111',
  });

  assert.match(script, /Windows\.UI\.Notifications\.ToastNotificationManager/);
  assert.match(script, /ToastText02/);
  assert.equal(script.includes(`'${TOAST_TITLE}'`), true);
  assert.equal(script.includes("'ERP 生产库：核对本月产量'"), true);
  // Every literal is single-quoted; no user content can reach a double-quoted
  // command string because the script contains none at all.
  assert.equal(script.includes('"'), false);
  // The proposal id is correlation metadata, never rendered.
  assert.equal(script.includes('11111111-1111-1111-1111-111111111111'), false);
});

test('buildToastScript doubles single quotes so PowerShell content cannot break out', () => {
  const purpose = "O'Brien 的 '营收'";
  const script = buildToastScript({
    sourceName: "财务'库",
    purpose,
    proposalId: 'p-1',
  });

  // `'` becomes `''`, so the whole body remains one quoted literal.
  assert.equal(script.includes("'财务''库：O''Brien 的 ''营收'''"), true);
  assert.equal(script.includes("O'Brien"), false);
  assert.equal(script.includes('"'), false);
  assert.equal(buildToastBody({ sourceName: "财务'库", purpose, proposalId: 'p-1' }), "财务'库：O'Brien 的 '营收'");
});

test('buildToastScript truncates the purpose at 80 code points without splitting emoji', () => {
  const purpose = '🙂'.repeat(TOAST_BODY_TEXT_LIMIT + 20);
  const script = buildToastScript({
    sourceName: '来源',
    purpose,
    proposalId: 'p-2',
  });

  const emojiCount = Array.from(script).filter((char) => char === '🙂').length;
  assert.equal(emojiCount, TOAST_BODY_TEXT_LIMIT);
  assert.equal(script.includes("'来源："), true);
  assert.equal(
    buildToastBody({ sourceName: '来源', purpose: '目'.repeat(81), proposalId: 'p-2' }),
    `来源：${'目'.repeat(80)}`,
  );
});

test('toast spawn keeps console flags that were proven to break WinRT toasts off', () => {
  // Regression guard for a real failure on Windows 11 (2026-11-18): with
  // `detached` or `windowsHide` set, powershell.exe exited 0 without showing
  // anything. `-WindowStyle Hidden` hides the window instead.
  assert.equal(TOAST_SPAWN_OPTIONS.detached, false);
  assert.equal(TOAST_SPAWN_OPTIONS.windowsHide, false);
  assert.equal(TOAST_SPAWN_OPTIONS.stdio, 'ignore');
});

test('shouldNotify allows at most one toast per three seconds globally', () => {
  const state = createToastRateLimitState();
  const env = { SAG_TOAST: '1' };

  assert.equal(shouldNotify(10_000, { platform: 'win32', env, state }), true);
  assert.equal(shouldNotify(10_001, { platform: 'win32', env, state }), false);
  assert.equal(shouldNotify(12_999, { platform: 'win32', env, state }), false);
  assert.equal(shouldNotify(10_000 + TOAST_MIN_INTERVAL_MS, { platform: 'win32', env, state }), true);
  assert.equal(shouldNotify(15_999, { platform: 'win32', env, state }), false);
  assert.equal(shouldNotify(16_000, { platform: 'win32', env, state }), true);
});

test('shouldNotify is false on non-Windows platforms and does not consume the budget', () => {
  const state = createToastRateLimitState();
  const env = { SAG_TOAST: '1' };

  assert.equal(shouldNotify(1_000, { platform: 'linux', env, state }), false);
  assert.equal(shouldNotify(1_001, { platform: 'darwin', env, state }), false);
  assert.equal(state.lastNotifiedAt, Number.NEGATIVE_INFINITY);
  assert.equal(shouldNotify(1_002, { platform: 'win32', env, state }), true);
});

test('toasts are opt-in: SAG_TOAST=1 enables, unset and 0 stay off', () => {
  assert.equal(
    shouldNotify(5_000, {
      platform: 'win32',
      env: { SAG_TOAST: '0' },
      state: createToastRateLimitState(),
    }),
    false,
  );
  assert.equal(
    shouldNotify(5_001, { platform: 'win32', env: {}, state: createToastRateLimitState() }),
    false,
  );
  assert.equal(
    shouldNotify(5_002, {
      platform: 'win32',
      env: { SAG_TOAST: '1' },
      state: createToastRateLimitState(),
    }),
    true,
  );
});

test('one new proposal notifies once and request_key replays do not notify again', async (t) => {
  const notifications: NewProposalNotification[] = [];
  const app = await startTestGateway(t, {
    notifyNewProposal: (input) => {
      notifications.push(input);
    },
  });
  const auth = await setupAndUnlock(app);
  const source = await addTestSource(app, auth, { name: "客户'营收库" });

  const payload = {
    source_id: source.id,
    sql: 'SELECT 1 AS one',
    purpose: "O'Brien 的营收汇总",
    request_key: 'notify-request-1',
  };
  const first = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: payload,
  });
  assert.equal(first.status, 201, first.text);
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0]?.sourceName, source.name);
  assert.equal(notifications[0]?.purpose, payload.purpose);
  assert.equal(notifications[0]?.proposalId, bodyOf(first).id);

  const replay = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: payload,
  });
  assert.equal(replay.status, 200, replay.text);
  assert.equal(bodyOf(replay).id, bodyOf(first).id);
  assert.equal(notifications.length, 1, 'idempotent replay must not notify twice');

  const second = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: { ...payload, request_key: 'notify-request-2' },
  });
  assert.equal(second.status, 201, second.text);
  assert.equal(notifications.length, 2);
});

test('a throwing notifier never breaks proposal creation', async (t) => {
  const app = await startTestGateway(t, {
    notifyNewProposal: () => {
      throw new Error('toast boom');
    },
  });
  const auth = await setupAndUnlock(app);
  const source = await addTestSource(app, auth);

  const created = await request(app.url, '/v1/agent/proposals', {
    method: 'POST',
    headers: bearer(auth.agentToken),
    body: {
      source_id: source.id,
      sql: 'SELECT 1 AS one',
      purpose: 'throw test',
    },
  });
  assert.equal(created.status, 201, created.text);
  assert.equal(typeof bodyOf(created).id, 'string');
});
