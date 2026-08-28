import nodemailer from 'nodemailer';

const truthy = value => ['1', 'true', 'yes'].includes(String(value || '').toLowerCase());

export function smtpConfig(env = process.env) {
  const host = String(env.SHIPWITNESS_SMTP_HOST || '').trim();
  const from = String(env.SHIPWITNESS_SMTP_FROM || '').trim();
  if (!host && !from) return { enabled: false };
  if (!host || !from) throw new Error('SMTP 配置不完整：必须同时设置 SHIPWITNESS_SMTP_HOST 和 SHIPWITNESS_SMTP_FROM');
  const port = Number(env.SHIPWITNESS_SMTP_PORT || 587);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('SHIPWITNESS_SMTP_PORT 必须是有效端口');
  const user = String(env.SHIPWITNESS_SMTP_USER || '').trim();
  const password = String(env.SHIPWITNESS_SMTP_PASSWORD || '');
  if (Boolean(user) !== Boolean(password)) throw new Error('SMTP 用户名和密码必须同时配置');
  return { enabled: true, host, port, secure: truthy(env.SHIPWITNESS_SMTP_SECURE), requireTLS: env.SHIPWITNESS_SMTP_REQUIRE_TLS == null ? true : truthy(env.SHIPWITNESS_SMTP_REQUIRE_TLS), from, auth: user ? { user, pass: password } : undefined };
}

export function createSmtpSender(config = smtpConfig()) {
  if (!config.enabled) return null;
  const transport = nodemailer.createTransport({ host: config.host, port: config.port, secure: config.secure, requireTLS: config.requireTLS, auth: config.auth, disableFileAccess: true, disableUrlAccess: true });
  return async message => {
    const result = await transport.sendMail({ from: config.from, to: message.to, subject: message.subject, text: message.text, html: message.html });
    return { messageId: String(result.messageId || ''), accepted: Array.isArray(result.accepted) ? result.accepted.map(String) : [] };
  };
}
