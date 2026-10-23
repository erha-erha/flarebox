import { createMailbox, findDomain, findMailbox, getSettings, MAX_INLINE_BODY, type MailboxRow } from "./db";
import { getBlob, putBlob } from "./storage";
import { domainOf, fromBase64, htmlToText, isEmail, makeSnippet, newId, normalizeEmail, safeFilename, toBase64 } from "./util";

export interface OutgoingAttachment {
  filename: string;
  type: string;
  /** base64 (data: URL prefixes are tolerated) */
  content: string;
}

export interface SendRequest {
  from: string;
  to: string[];
  cc?: string[];
  bcc?: string[];
  subject: string;
  html?: string;
  text?: string;
  attachments?: OutgoingAttachment[];
  /** id of the message being replied to / forwarded, for threading headers */
  replyToId?: string;
  /** attachments of an existing message to include (forwarding) */
  forwardAttachmentIds?: string[];
}

export class SendError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// Total size limit of Cloudflare Email Service (5 MiB including attachments).
const MAX_TOTAL_BYTES = 5 * 1024 * 1024;

const CF_ERROR_HINTS: Record<string, string> = {
  E_SENDER_NOT_VERIFIED: "发件域名还没有在 Cloudflare Email Service 中完成验证。",
  E_SENDER_DOMAIN_NOT_AVAILABLE: "发件域名还没有开通 Cloudflare 发信。请在「设置 → 域名」里点击「一键接入」，或到 Cloudflare 控制台 Email Sending 页面添加该域名。",
  E_RECIPIENT_NOT_ALLOWED: "当前账户只能发给已验证的目标地址。开通 Workers 付费计划并接入发信域名后，即可发给任意收件人。",
  E_RECIPIENT_SUPPRESSED: "收件人在抑制列表中（之前退信或投诉过）。",
  E_ACCOUNT_SUSPENDED: "Cloudflare 账户的发信功能已被暂停。",
  E_CONTENT_TOO_LARGE: "邮件超过 5 MB 上限，请减小附件。",
  E_RATE_LIMIT_EXCEEDED: "发送太频繁，请稍后再试。",
  E_DAILY_LIMIT_EXCEEDED: "已达到今日发信额度。",
  E_TOO_MANY_RECIPIENTS: "收件人总数不能超过 50 个。",
  E_TOO_MANY_ATTACHMENTS: "附件数量不能超过 32 个。",
};

function cleanList(list: string[] | undefined): string[] {
  const out: string[] = [];
  for (const raw of list ?? []) {
    const addr = normalizeEmail(raw);
    if (!addr) continue;
    if (!isEmail(addr)) throw new SendError(`收件人地址无效：${raw}`);
    if (!out.includes(addr)) out.push(addr);
  }
  return out;
}

export async function sendMail(env: Env, req: SendRequest): Promise<{ id: string }> {
  const fromAddr = normalizeEmail(req.from ?? "");
  if (!isEmail(fromAddr)) throw new SendError("发件地址无效");
  const domain = await findDomain(env.DB, domainOf(fromAddr));
  if (!domain) throw new SendError("发件域名未添加到 FlareBox");
  // Any address on a connected domain can send; create its mailbox on first use.
  const mailbox = (await findMailbox(env.DB, fromAddr)) ?? (await createMailbox(env.DB, fromAddr));

  const to = cleanList(req.to);
  const cc = cleanList(req.cc);
  const bcc = cleanList(req.bcc);
  if (to.length + cc.length + bcc.length === 0) throw new SendError("请至少填写一个收件人");
  if (to.length + cc.length + bcc.length > 50) throw new SendError(CF_ERROR_HINTS.E_TOO_MANY_RECIPIENTS);

  const subject = (req.subject ?? "").slice(0, 998);
  const html = req.html?.trim() ? req.html : undefined;
  const text = req.text?.trim() ? req.text : html ? htmlToText(html) : "";

  const attachments = (req.attachments ?? []).map((a) => ({
    filename: safeFilename(a.filename),
    type: a.type || "application/octet-stream",
    bytes: fromBase64(a.content),
  }));
  for (const attId of (req.forwardAttachmentIds ?? []).slice(0, 32)) {
    const row = await env.DB.prepare("SELECT filename, mime_type, r2_key FROM attachments WHERE id = ?")
      .bind(String(attId))
      .first<{ filename: string; mime_type: string; r2_key: string }>();
    const bytes = row ? await getBlob(env, row.r2_key) : null;
    if (row && bytes) attachments.push({ filename: row.filename, type: row.mime_type, bytes });
  }
  if (attachments.length > 32) throw new SendError(CF_ERROR_HINTS.E_TOO_MANY_ATTACHMENTS);
  const totalBytes = attachments.reduce((n, a) => n + a.bytes.byteLength, 0) + (html?.length ?? 0) + text.length;
  if (totalBytes > MAX_TOTAL_BYTES) throw new SendError(CF_ERROR_HINTS.E_CONTENT_TOO_LARGE);

  // Threading headers when replying
  const headers: Record<string, string> = {};
  if (req.replyToId) {
    const orig = await env.DB.prepare("SELECT message_id, references_hdr FROM messages WHERE id = ?")
      .bind(req.replyToId)
      .first<{ message_id: string | null; references_hdr: string | null }>();
    if (orig?.message_id) {
      headers["In-Reply-To"] = orig.message_id;
      headers["References"] = [orig.references_hdr, orig.message_id].filter(Boolean).join(" ").slice(-1900);
    }
  }

  const settings = await getSettings(env.DB);
  const provider = settings.send_provider === "resend" ? "resend" : "cloudflare";
  const message: OutboundMessage = { mailbox, to, cc, bcc, subject, html, text, headers, attachments };
  const messageId =
    provider === "resend"
      ? await sendViaResend(settings.resend_api_key, message)
      : await sendViaCloudflare(env, message);

  return { id: await storeSent(env, message, messageId) };
}

interface OutboundMessage {
  mailbox: MailboxRow;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html?: string;
  text: string;
  headers: Record<string, string>;
  attachments: { filename: string; type: string; bytes: Uint8Array }[];
}

async function sendViaCloudflare(env: Env, m: OutboundMessage): Promise<string | null> {
  const build = (withHeaders: boolean): EmailMessageBuilder => ({
    from: m.mailbox.display_name ? { email: m.mailbox.address, name: m.mailbox.display_name } : m.mailbox.address,
    to: m.to,
    ...(m.cc.length ? { cc: m.cc } : {}),
    ...(m.bcc.length ? { bcc: m.bcc } : {}),
    subject: m.subject,
    text: m.text,
    ...(m.html ? { html: m.html } : {}),
    ...(withHeaders && Object.keys(m.headers).length ? { headers: m.headers } : {}),
    ...(m.attachments.length
      ? {
          attachments: m.attachments.map((a) => ({
            disposition: "attachment" as const,
            filename: a.filename,
            type: a.type,
            content: a.bytes,
          })),
        }
      : {}),
  }) as EmailMessageBuilder;

  try {
    try {
      return (await env.EMAIL.send(build(true))).messageId;
    } catch (err) {
      // Threading headers are optional; retry without them if the platform refuses.
      if (String((err as { code?: string }).code ?? "").startsWith("E_HEADER")) {
        return (await env.EMAIL.send(build(false))).messageId;
      }
      throw err;
    }
  } catch (err) {
    const code = (err as { code?: string }).code ?? "";
    const hint = CF_ERROR_HINTS[code];
    throw new SendError(hint ? `${hint}（${code}）` : `Cloudflare 发信失败：${(err as Error).message}`, 502);
  }
}

async function sendViaResend(apiKey: string | undefined, m: OutboundMessage): Promise<string | null> {
  if (!apiKey) throw new SendError("当前发信方式为 Resend，但还没有填写 Resend API Key（设置 → 发信）");
  const from = m.mailbox.display_name
    ? `${m.mailbox.display_name.replace(/["<>]/g, "")} <${m.mailbox.address}>`
    : m.mailbox.address;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      from,
      to: m.to,
      cc: m.cc.length ? m.cc : undefined,
      bcc: m.bcc.length ? m.bcc : undefined,
      subject: m.subject,
      html: m.html,
      text: m.text,
      headers: Object.keys(m.headers).length ? m.headers : undefined,
      attachments: m.attachments.length
        ? m.attachments.map((a) => ({ filename: a.filename, content: toBase64(a.bytes), content_type: a.type }))
        : undefined,
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string };
  if (!res.ok) throw new SendError(`Resend 发信失败：${data.message ?? res.statusText}`, 502);
  return data.id ? `<${data.id}@resend.dev>` : null;
}

async function storeSent(env: Env, m: OutboundMessage, messageId: string | null): Promise<string> {
  const id = newId();
  const stmts: D1PreparedStatement[] = [];
  for (const a of m.attachments) {
    const attId = newId();
    const key = `att/${id}/${attId}`;
    await putBlob(env, key, a.bytes, a.type);
    stmts.push(
      env.DB.prepare(
        "INSERT INTO attachments (id, message_id, filename, mime_type, size, r2_key, content_id, inline) VALUES (?, ?, ?, ?, ?, ?, NULL, 0)",
      ).bind(attId, id, a.filename, a.type, a.bytes.byteLength, key),
    );
  }
  const bodyTooBig = (m.html?.length ?? 0) + m.text.length > MAX_INLINE_BODY;
  if (bodyTooBig) {
    await putBlob(env, `body/${id}.json`, JSON.stringify({ html: m.html ?? null, text: m.text }), "application/json");
  }
  stmts.unshift(
    env.DB.prepare(
      `INSERT INTO messages (id, mailbox_id, folder, from_addr, from_name, to_json, cc_json, bcc_json, subject, snippet,
        text_body, html_body, body_in_r2, message_id, in_reply_to, references_hdr, is_read, has_attachments, size, created_at)
       VALUES (?, ?, 'sent', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
    ).bind(
      id,
      m.mailbox.id,
      m.mailbox.address,
      m.mailbox.display_name,
      JSON.stringify(m.to.map((address) => ({ name: "", address }))),
      JSON.stringify(m.cc.map((address) => ({ name: "", address }))),
      JSON.stringify(m.bcc.map((address) => ({ name: "", address }))),
      m.subject,
      makeSnippet(m.text),
      bodyTooBig ? null : m.text,
      bodyTooBig ? null : (m.html ?? null),
      bodyTooBig ? 1 : 0,
      messageId,
      m.headers["In-Reply-To"] ?? null,
      m.headers["References"] ?? null,
      m.attachments.length ? 1 : 0,
      (m.html?.length ?? 0) + m.text.length + m.attachments.reduce((n, a) => n + a.bytes.byteLength, 0),
      Date.now(),
    ),
  );
  await env.DB.batch(stmts);
  return id;
}
