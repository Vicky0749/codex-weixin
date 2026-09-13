import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { AccountManager } from "../src/server/account-manager.js";
import { startLocalHttpServer } from "../src/server/http-server.js";
import { defaultConfig } from "../src/state/config.js";
import { resolveStatePaths } from "../src/state/paths.js";
import { saveAccount } from "../src/weixin/accounts.js";
import type { MonitorOptions } from "../src/weixin/monitor.js";

test("watchdog health requires a recent successful WeChat poll", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-health-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  saveAccount(paths, {
    accountId: "account-one",
    token: "token-one",
    baseUrl: "https://example.test",
    cdnBaseUrl: "https://cdn.example.test",
    savedAt: new Date().toISOString(),
    enabled: true
  });

  let monitorOptions: MonitorOptions | undefined;
  const manager = new AccountManager({
    paths,
    configProvider: () => defaultConfig(root),
    clientFactory: () => ({}) as never,
    bridgeFactory: () => ({
      handleMessage: async () => {},
      cancelActiveTurns: async () => {},
      getActiveTaskCount: () => 0,
      replaceRuntime: () => {},
      allowSender: () => {},
      removeSender: () => {}
    }) as never,
    monitor: async (options) => {
      monitorOptions = options;
      await new Promise<void>((resolve) => options.signal?.addEventListener("abort", () => resolve(), { once: true }));
    },
    runnerFactory: () => ({ close() {} }) as never
  });

  await manager.startAccount("account-one", false);

  const healthyDuringInitialPoll = manager.getWatchdogHealth();
  assert.equal(healthyDuringInitialPoll.ok, true);
  assert.deepEqual(healthyDuringInitialPoll.staleAccountIds, []);

  const staleBeforeFirstPoll = manager.getWatchdogHealth(Date.now() + 180_000);
  assert.equal(staleBeforeFirstPoll.ok, false);
  assert.deepEqual(staleBeforeFirstPoll.staleAccountIds, ["account-one"]);

  await monitorOptions?.onPollSuccess?.();
  const healthy = manager.getWatchdogHealth();
  assert.equal(healthy.ok, true);
  assert.deepEqual(healthy.staleAccountIds, []);

  const staleAfterSilence = manager.getWatchdogHealth(Date.now() + 180_000);
  assert.equal(staleAfterSilence.ok, false);
  assert.deepEqual(staleAfterSilence.staleAccountIds, ["account-one"]);

  await manager.stopAccount("account-one", false);
});

test("health endpoint rejects a stale bridge for the local supervisor", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-health-http-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const health = {
    ok: false,
    checkedAt: new Date().toISOString(),
    enabledAccountCount: 1,
    activeTaskCount: 0,
    staleAccountIds: ["account-one"]
  };
  const server = await startLocalHttpServer({
    paths: resolveStatePaths(root),
    accountManager: { getWatchdogHealth: () => health } as never,
    port: 0
  });
  t.after(() => server.close());

  const response = await fetch(`${server.url}/api/health`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), health);
});
