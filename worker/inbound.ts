import PostalMime from "postal-mime";
import { createMailbox, ensureSchema, findDomain, findMailbox, getSettings, MAX_INLINE_BODY } from "./db";
import { hasR2, putBlob } from "./storage";
import { domainOf, htmlToText, makeSnippet, newId, normalizeEmail, stripSubaddress } from "./util";

type Address = { name: string; address: string };

const MAX_D1_RAW = 3 * 1024 * 1024;

function flattenAddresses(list: Array<{ name?: string; address?: string; group?: unknown[] }> | undefined): Address[] {
  if (!Array.isArray(list)) return [];
  const out: Address[] = [];
  for (const item of list) {
    if (item.group) out.push(...flattenAddresses(item.group as Address[]));
    else if (item.address) out.push({ name: item.name ?? "", address: item.address });
  }
  return out;
}

function isBlocked(sender: string, blocklist: string | undefined): boolean {
  if (!blocklist) return false;
  const from = sender.toLowerCase();
  return blocklist
    .split(/[\n,]/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .some((rule) => (rule.startsWith("@") ? from.endsWith(rule) : from === rule));
}

/** Email Routing hands every message for a connected domain to this handler. */
export async function handleInbound(message: ForwardableEmailMessage, env: Env): Promise<void> {
  await ensureSchema(env.DB);

  const recipient = normalizeEmail(message.to);
  const domain = await findDomain(env.DB, domainOf(recipient));
  if (!domain) {
    message.setReject("Recipient domain is not managed by this server");
    return;
  }

  const settings = await getSettings(env.DB);
  if (isBlocked(message.from, settings.blocked_senders)) {
    message.setReject("Sender is blocked");
    return;
  }

  let mailbox = (await findMailbox(env.DB, recipient)) ?? (await findMailbox(env.DB, stripSubaddress(recipient)));
  if (!mailbox) {
    if (settings.auto_create_mailbox === "0") {
      message.setReject("No such mailbox");
      return;
    }
    mailbox = await createMailbox(env.DB, stripSubaddress(recipient));
  }

  const raw = await new Response(message.raw).arrayBuffer();
  const email = await PostalMime.parse(raw);

  const id = newId();
  // Without R2, only keep the original .eml for reasonably small messages to save D1 space.
  const rawKey = hasR2(env) || raw.byteLength <= MAX_D1_RAW ? `raw/${id}.eml` : null;
  if (rawKey) await putBlob(env, rawKey, raw, "message/rfc822");

  const attachmentStmts: D1PreparedStatement[] = [];
  for (const att of email.attachments ?? []) {
    const attId = newId();
    const key = `att/${id}/${attId}`;
    const content = att.content;
    const size = typeof content === "string" ? content.length : content.byteLength;
    const mimeType = att.mimeType || "application/octet-stream";
    await putBlob(env, key, content, mimeType);
    const contentId = att.contentId ? att.contentId.replace(/^<|>$/g, "") : null;
    attachmentStmts.push(
      env.DB.prepare(
        "INSERT INTO attachments (id, message_id, filename, mime_type, size, r2_key, content_id, inline) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).bind(attId, id, att.filename || "attachment", mimeType, size, key, contentId, att.disposition === "inline" ? 1 : 0),
    );
  }

  const html = email.html ?? null;
  const text = email.text ?? (html ? htmlToText(html) : "");
  const bodyTooBig = (html?.length ?? 0) + text.length > MAX_INLINE_BODY;
  if (bodyTooBig) {
    await putBlob(env, `body/${id}.json`, JSON.stringify({ html, text }), "application/json");
  }

  const from = email.from?.address
    ? { name: email.from.name ?? "", address: email.from.address }
    : { name: "", address: message.from };
  const replyTo = flattenAddresses(email.replyTo)[0]?.address ?? "";
  const visibleAttachments = (email.attachments ?? []).filter((a) => a.disposition !== "inline" || !a.contentId);

  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO messages (id, mailbox_id, folder, from_addr, from_name, to_json, cc_json, reply_to, subject, snippet,
        text_body, html_body, body_in_r2, message_id, in_reply_to, references_hdr, has_attachments, size, raw_key, created_at)
       VALUES (?, ?, 'inbox', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      id,
      mailbox.id,
      from.address.toLowerCase(),
      from.name,
      JSON.stringify(flattenAddresses(email.to)),
      JSON.stringify(flattenAddresses(email.cc)),
      replyTo,
      email.subject ?? "",
      makeSnippet(text),
      bodyTooBig ? null : text,
      bodyTooBig ? null : html,
      bodyTooBig ? 1 : 0,
      email.messageId ?? null,
      email.inReplyTo ?? null,
      email.references ?? null,
      visibleAttachments.length > 0 ? 1 : 0,
      message.rawSize,
      rawKey,
      Date.now(),
    ),
    ...attachmentStmts,
  ]);

  if (mailbox.forward_to) {
    try {
      await message.forward(mailbox.forward_to);
    } catch (err) {
      console.warn(`Forward to ${mailbox.forward_to} failed (is it a verified destination address?)`, err);
    }
  }
}
