import { TaskCompletionEmailStore } from "../src/notifications/task-completion-email.js";
import { WindowsDpapiProtector } from "../src/security/dpapi.js";
import { resolveStatePaths } from "../src/state/paths.js";

const required = [
  "CODEX_WEIXIN_SMTP_HOST",
  "CODEX_WEIXIN_SMTP_PORT",
  "CODEX_WEIXIN_SMTP_SECURE",
  "CODEX_WEIXIN_SMTP_FROM",
  "CODEX_WEIXIN_SMTP_TO",
  "CODEX_WEIXIN_SMTP_PASSWORD"
];

const missing = required.filter((key) => !process.env[key]?.trim());
if (missing.length) {
  throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
}

const smtpPort = Number(process.env.CODEX_WEIXIN_SMTP_PORT);
const secure = process.env.CODEX_WEIXIN_SMTP_SECURE?.trim().toLowerCase() === "true";

const store = new TaskCompletionEmailStore(resolveStatePaths(), new WindowsDpapiProtector());
await store.configure({
  smtpHost: process.env.CODEX_WEIXIN_SMTP_HOST ?? "",
  smtpPort,
  secure,
  from: process.env.CODEX_WEIXIN_SMTP_FROM ?? "",
  to: process.env.CODEX_WEIXIN_SMTP_TO ?? "",
  password: process.env.CODEX_WEIXIN_SMTP_PASSWORD ?? ""
});

console.log("Task-completion email configuration saved with Windows encryption.");
