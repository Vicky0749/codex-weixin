import nodemailer from "nodemailer";

import type { SecretProtector } from "../security/dpapi.js";
import { readJsonFile, writeJsonFile } from "../state/json-store.js";
import type { StatePaths } from "../state/paths.js";

type StoredTaskCompletionEmailConfig = {
  version: 1;
  smtpHost: string;
  smtpPort: number;
  secure: boolean;
  from: string;
  to: string;
  encryptedPassword: string;
};

export type TaskCompletionEmailConfig = {
  smtpHost: string;
  smtpPort: number;
  secure: boolean;
  from: string;
  to: string;
  password: string;
};

export type TaskCompletionNotice = {
  subject: string;
  taskName: string;
  accountIndex: number;
  accountDisplayName?: string;
  finalSummary: string;
  attachmentCount: number;
  completedAt: string;
};

export type MailTransport = {
  sendMail: (input: { from: string; to: string; subject: string; text: string }) => Promise<unknown>;
};

export type MailTransportFactory = (options: {
  host: string;
  port: number;
  secure: boolean;
  auth: { user: string; pass: string };
}) => MailTransport;

export class TaskCompletionEmailStore {
  constructor(
    private readonly paths: StatePaths,
    private readonly protector: SecretProtector
  ) {}

  async configure(config: TaskCompletionEmailConfig): Promise<void> {
    const normalized = normalizeConfig(config);
    const stored: StoredTaskCompletionEmailConfig = {
      version: 1,
      smtpHost: normalized.smtpHost,
      smtpPort: normalized.smtpPort,
      secure: normalized.secure,
      from: normalized.from,
      to: normalized.to,
      encryptedPassword: await this.protector.protect(normalized.password)
    };
    writeJsonFile(this.paths.taskCompletionEmailPath, stored);
  }

  async read(): Promise<TaskCompletionEmailConfig | undefined> {
    const stored = readJsonFile<unknown>(this.paths.taskCompletionEmailPath, undefined);
    if (!isStoredConfig(stored)) return undefined;
    return {
      smtpHost: stored.smtpHost,
      smtpPort: stored.smtpPort,
      secure: stored.secure,
      from: stored.from,
      to: stored.to,
      password: await this.protector.unprotect(stored.encryptedPassword)
    };
  }
}

export class TaskCompletionEmailNotifier {
  private readonly store: TaskCompletionEmailStore;
  private readonly transportFactory: MailTransportFactory;

  constructor(options: {
    paths: StatePaths;
    protector: SecretProtector;
    transportFactory?: MailTransportFactory;
  }) {
    this.store = new TaskCompletionEmailStore(options.paths, options.protector);
    this.transportFactory = options.transportFactory ?? ((options) => nodemailer.createTransport(options));
  }

  async notify(notice: TaskCompletionNotice): Promise<void> {
    const config = await this.store.read();
    if (!config) return;
    const transport = this.transportFactory({
      host: config.smtpHost,
      port: config.smtpPort,
      secure: config.secure,
      auth: { user: config.from, pass: config.password }
    });
    await transport.sendMail({
      from: config.from,
      to: config.to,
      subject: notice.subject,
      text: formatNoticeText(notice)
    });
  }
}

export function formatCompletionSubject(accountIndex: number, taskName: string): string {
  return `${accountIndex}-已完成：${taskName}`;
}

function formatNoticeText(notice: TaskCompletionNotice): string {
  const account = notice.accountDisplayName
    ? `${notice.accountIndex}（${notice.accountDisplayName}）`
    : String(notice.accountIndex);
  return [
    `微信账号：${account}`,
    `任务：${notice.taskName}`,
    `完成时间：${formatCompletionTime(notice.completedAt)}`,
    `附件数：${notice.attachmentCount}`,
    "",
    "回复摘要：",
    notice.finalSummary || "(无文本回复)"
  ].join("\n");
}

function normalizeConfig(config: TaskCompletionEmailConfig): TaskCompletionEmailConfig {
  const smtpHost = config.smtpHost.trim();
  const from = config.from.trim();
  const to = config.to.trim();
  const password = config.password.trim();
  if (!smtpHost || !from || !to || !password) {
    throw new Error("SMTP host, sender, recipient, and password are required");
  }
  if (!Number.isInteger(config.smtpPort) || config.smtpPort < 1 || config.smtpPort > 65535) {
    throw new Error("SMTP port is invalid");
  }
  return { smtpHost, smtpPort: config.smtpPort, secure: config.secure, from, to, password };
}

function isStoredConfig(value: unknown): value is StoredTaskCompletionEmailConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as Record<string, unknown>;
  return config.version === 1
    && typeof config.smtpHost === "string"
    && typeof config.smtpPort === "number"
    && typeof config.secure === "boolean"
    && typeof config.from === "string"
    && typeof config.to === "string"
    && typeof config.encryptedPassword === "string";
}

function formatCompletionTime(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const parts = Object.fromEntries(formatter.formatToParts(date)
    .filter((part) => part.type !== "literal")
    .map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}`;
}
