import { TaskCompletionEmailNotifier } from "../src/notifications/task-completion-email.js";
import { WindowsDpapiProtector } from "../src/security/dpapi.js";
import { resolveStatePaths } from "../src/state/paths.js";

const notifier = new TaskCompletionEmailNotifier({
  paths: resolveStatePaths(),
  protector: new WindowsDpapiProtector()
});

await notifier.notify({
  subject: "邮件通知配置测试",
  taskName: "邮件通知配置测试",
  accountIndex: 0,
  finalSummary: "本机 Codex 微信 ClawBot 已完成 SMTP 邮件通知连通性测试。",
  attachmentCount: 0,
  completedAt: new Date().toISOString()
});

console.log("Task-completion email test message accepted by SMTP.");
