import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { TaskCompletionEmailNotifier, TaskCompletionEmailStore } from "../src/notifications/task-completion-email.js";
import { resolveStatePaths } from "../src/state/paths.js";
import type { SecretProtector } from "../src/security/dpapi.js";

class FakeProtector implements SecretProtector {
  async protect(secret: string): Promise<string> {
    return `cipher:${Buffer.from(secret).toString("base64")}`;
  }

  async unprotect(ciphertext: string): Promise<string> {
    assert.match(ciphertext, /^cipher:/);
    return Buffer.from(ciphertext.slice("cipher:".length), "base64").toString("utf8");
  }
}

test("stores the SMTP password encrypted and sends the numbered completion subject", async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "codex-weixin-completion-email-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const paths = resolveStatePaths(root);
  const protector = new FakeProtector();
  const store = new TaskCompletionEmailStore(paths, protector);
  await store.configure({
    smtpHost: "smtp.163.com",
    smtpPort: 465,
    secure: true,
    from: "sender@example.com",
    to: "recipient@example.com",
    password: "private-mail-password"
  });

  const saved = fs.readFileSync(paths.taskCompletionEmailPath, "utf8");
  assert.doesNotMatch(saved, /private-mail-password/);
  assert.match(saved, /cipher:/);

  let transportOptions: Record<string, unknown> | undefined;
  let mail: Record<string, unknown> | undefined;
  const notifier = new TaskCompletionEmailNotifier({
    paths,
    protector,
    transportFactory: (options) => {
      transportOptions = options;
      return {
        async sendMail(input) {
          mail = input;
        }
      };
    }
  });

  await notifier.notify({
    subject: "4-已完成：整理三季度费用明细",
    taskName: "整理三季度费用明细",
    accountIndex: 4,
    accountDisplayName: "Serendipity",
    finalSummary: "费用明细已整理并导出。",
    attachmentCount: 1,
    completedAt: "2026-08-24T06:00:00.000Z"
  });

  assert.deepEqual(transportOptions, {
    host: "smtp.163.com",
    port: 465,
    secure: true,
    auth: { user: "sender@example.com", pass: "private-mail-password" }
  });
  assert.deepEqual(mail, {
    from: "sender@example.com",
    to: "recipient@example.com",
    subject: "4-已完成：整理三季度费用明细",
    text: [
      "微信账号：4（Serendipity）",
      "任务：整理三季度费用明细",
      "完成时间：2026-08-24 14:00",
      "附件数：1",
      "",
      "回复摘要：",
      "费用明细已整理并导出。"
    ].join("\n")
  });
});
