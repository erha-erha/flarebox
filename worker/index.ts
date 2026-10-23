import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import {
  checkPassword,
  clearRateLimit,
  clearSessionCookie,
  createSession,
  destroyAllSessions,
  destroySession,
  hashPassword,
  isInitialized,
  rateLimit,
  SESSION_COOKIE,
  sessionCookie,
  validateSession,
} from "./auth";
import { CfApiError, connectZone, disconnectZone, getZone, listZones, tokenTemplateUrl, zoneStatus } from "./cloudflare";
import {
  createMailbox,
  deleteSetting,
  ensureSchema,
  findDomain,
  FOLDERS,
  getSetting,
  getSettings,
  purgeMessages,
  setSetting,
  type AttachmentRow,
  type DomainRow,
  type Folder,
  type MailboxRow,
  type MessageRow,
} from "./db";
import { handleInbound } from "./inbound";
import { getBlob } from "./storage";
import { sendMail, SendError, type SendRequest } from "./send";
import { domainOf, isEmail, normalizeEmail, safeEqual } from "./util";

type App = { Bindings: Env };
const app = new Hono<App>().basePath("/api");

class HttpError extends Error {
  constructor(
    readonly status: 400 | 401 | 403 | 404 | 409 | 429 | 502,
    message: string,
  ) {
    super(message);
  }
}

app.onError((err, c) => {
  if (err instanceof HttpError) return c.json({ error: err.message }, err.status);
  if (err instanceof SendError) return c.json({ error: err.message }, err.status as 400);
  if (err instanceof CfApiError) {
    const hint =
      err.status === 403 || err.codes.includes(10000) || err.codes.includes(9109)
        ? "（API 令牌权限不足，请检查令牌权限）"
        : "";
    return c.json({ error: `Cloudflare API 错误：${err.message}${hint}` }, 502);
  }
  console.error(err);
  return c.json({ error: "服务器内部错误" }, 500);
});

// Schema bootstrap + basic CSRF protection for state-changing requests.
app.use("*", async (c, next) => {
  await ensureSchema(c.env.DB);
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const origin = c.req.header("Origin");
    if (origin && origin !== new URL(c.req.url).origin) throw new HttpError(403, "来源校验失败");
  }
  await next();
});

const isSecure = (c: Context<App>) => new URL(c.req.url).protocol === "https:";
const clientIp = (c: Context<App>) => c.req.header("CF-Connecting-IP") ?? "local";

async function body<T>(c: Context<App>): Promise<T> {
  try {
    return await c.req.json<T>();
  } catch {
    throw new HttpError(400, "请求格式错误");
  }
}

// ---------------------------------------------------------------- auth

app.get("/status", async (c) => {
  const authenticated = await validateSession(c.env, getCookie(c, SESSION_COOKIE));
  const initialized = await isInitialized(c.env);
  return c.json({ initialized, authenticated, setup_token_required: !initialized && !!c.env.SETUP_TOKEN });
});

app.post("/setup", async (c) => {
  if (await isInitialized(c.env)) throw new HttpError(409, "已经设置过管理员密码");
  if (!(await rateLimit(c.env, `setup:${clientIp(c)}`, 10, 15 * 60 * 1000))) throw new HttpError(429, "尝试次数过多，请稍后再试");
  const { password, setup_token } = await body<{ password: string; setup_token?: string }>(c);
  // A fresh public deploy must not be claimable by whoever opens it first.
  if (c.env.SETUP_TOKEN && !safeEqual(setup_token ?? "", c.env.SETUP_TOKEN)) {
    throw new HttpError(403, "安装码不正确，请使用部署时输出的设置链接");
  }
  if (!password || password.length < 8) throw new HttpError(400, "密码至少需要 8 位");
  await setSetting(c.env.DB, "admin_password_hash", await hashPassword(password));
  c.header("Set-Cookie", sessionCookie(await createSession(c.env), isSecure(c)));
  return c.json({ ok: true });
});

app.post("/login", async (c) => {
  const key = `login:${clientIp(c)}`;
  if (!(await rateLimit(c.env, key, 10, 15 * 60 * 1000))) throw new HttpError(429, "尝试次数过多，请 15 分钟后再试");
  const { password } = await body<{ password: string }>(c);
  if (!(await checkPassword(c.env, password ?? ""))) throw new HttpError(401, "密码不正确");
  await clearRateLimit(c.env, key);
  c.header("Set-Cookie", sessionCookie(await createSession(c.env), isSecure(c)));
  return c.json({ ok: true });
});

app.post("/logout", async (c) => {
  await destroySession(c.env, getCookie(c, SESSION_COOKIE));
  c.header("Set-Cookie", clearSessionCookie(isSecure(c)));
  return c.json({ ok: true });
});

// Everything below requires a session.
app.use("*", async (c, next) => {
  if (!(await validateSession(c.env, getCookie(c, SESSION_COOKIE)))) throw new HttpError(401, "请先登录");
  await next();
});

app.post("/password", async (c) => {
  const { current, next } = await body<{ current: string; next: string }>(c);
  if (!(await checkPassword(c.env, current ?? ""))) throw new HttpError(400, "当前密码不正确");
  if (!next || next.length < 8) throw new HttpError(400, "新密码至少需要 8 位");
  await setSetting(c.env.DB, "admin_password_hash", await hashPassword(next));
  await destroyAllSessions(c.env);
  c.header("Set-Cookie", sessionCookie(await createSession(c.env), isSecure(c)));
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- overview

app.get("/bootstrap", async (c) => {
  const db = c.env.DB;
  const [domains, mailboxes, counts, settings] = await Promise.all([
    db.prepare("SELECT * FROM domains ORDER BY name").all<DomainRow>(),
    db.prepare("SELECT * FROM mailboxes ORDER BY address").all<MailboxRow>(),
    db
      .prepare(
        `SELECT mailbox_id, folder, COUNT(*) AS total, SUM(CASE WHEN is_read = 0 THEN 1 ELSE 0 END) AS unread,
                SUM(is_starred) AS starred
         FROM messages GROUP BY mailbox_id, folder`,
      )
      .all<{ mailbox_id: number; folder: Folder; total: number; unread: number; starred: number }>(),
    getSettings(db),
  ]);
  return c.json({
    domains: domains.results,
    mailboxes: mailboxes.results,
    counts: counts.results,
    settings: publicSettings(settings, c.env),
  });
});

function publicSettings(s: Awaited<ReturnType<typeof getSettings>>, env: Env) {
  return {
    send_provider: s.send_provider === "resend" ? "resend" : "cloudflare",
    resend_configured: !!s.resend_api_key,
    auto_create_mailbox: s.auto_create_mailbox !== "0",
    block_remote_images: s.block_remote_images !== "0",
    blocked_senders: s.blocked_senders ?? "",
    signature: s.signature ?? "",
    worker_name: s.worker_name || env.WORKER_NAME,
    cf_connected: !!s.cf_api_token,
    cf_token_hint: s.cf_api_token ? `…${s.cf_api_token.slice(-4)}` : "",
  };
}

app.put("/settings", async (c) => {
  const input = await body<Record<string, unknown>>(c);
  const db = c.env.DB;
  if (input.send_provider === "cloudflare" || input.send_provider === "resend") {
    await setSetting(db, "send_provider", input.send_provider);
  }
  if (typeof input.resend_api_key === "string") {
    if (input.resend_api_key.trim()) await setSetting(db, "resend_api_key", input.resend_api_key.trim());
    else await deleteSetting(db, "resend_api_key");
  }
  if (typeof input.auto_create_mailbox === "boolean") {
    await setSetting(db, "auto_create_mailbox", input.auto_create_mailbox ? "1" : "0");
  }
  if (typeof input.block_remote_images === "boolean") {
    await setSetting(db, "block_remote_images", input.block_remote_images ? "1" : "0");
  }
  if (typeof input.blocked_senders === "string") await setSetting(db, "blocked_senders", input.blocked_senders.slice(0, 20000));
  if (typeof input.signature === "string") await setSetting(db, "signature", input.signature.slice(0, 5000));
  if (typeof input.worker_name === "string" && /^[a-z0-9][a-z0-9-]{0,62}$/.test(input.worker_name)) {
    await setSetting(db, "worker_name", input.worker_name);
  }
  return c.json({ settings: publicSettings(await getSettings(db), c.env) });
});

// ---------------------------------------------------------------- messages

const LIST_COLUMNS = `m.id, m.mailbox_id, m.folder, m.from_addr, m.from_name, m.to_json, m.subject, m.snippet,
  m.is_read, m.is_starred, m.has_attachments, m.created_at`;

app.get("/messages", async (c) => {
  const q = c.req.query();
  const where: string[] = [];
  const args: (string | number)[] = [];
  const view = q.folder ?? "inbox";
  if (view === "starred") {
    where.push("m.is_starred = 1", "m.folder != 'trash'");
  } else if (view === "unread") {
    where.push("m.is_read = 0", "m.folder IN ('inbox', 'archive')");
  } else if (FOLDERS.includes(view as Folder)) {
    where.push("m.folder = ?");
    args.push(view);
  } else {
    throw new HttpError(400, "未知的文件夹");
  }
  if (q.mailbox && q.mailbox !== "all") {
    where.push("m.mailbox_id = ?");
    args.push(Number(q.mailbox));
  }
  if (q.q?.trim()) {
    const like = `%${q.q.trim().replace(/[%_\\]/g, (ch) => "\\" + ch)}%`;
    const cols = ["m.subject", "m.from_addr", "m.from_name", "m.snippet", "m.to_json"];
    where.push(`(${cols.map((col) => `${col} LIKE ? ESCAPE '\\'`).join(" OR ")})`);
    args.push(...cols.map(() => like));
  }
  if (q.before) {
    where.push("m.id < ?");
    args.push(q.before);
  }
  const limit = Math.min(Number(q.limit) || 50, 100);
  const { results } = await c.env.DB.prepare(
    `SELECT ${LIST_COLUMNS} FROM messages m WHERE ${where.join(" AND ")} ORDER BY m.id DESC LIMIT ?`,
  )
    .bind(...args, limit + 1)
    .all();
  const more = results.length > limit;
  return c.json({ messages: results.slice(0, limit), more });
});

async function loadMessage(c: Context<App>, id: string): Promise<MessageRow> {
  const row = await c.env.DB.prepare("SELECT * FROM messages WHERE id = ?").bind(id).first<MessageRow>();
  if (!row) throw new HttpError(404, "邮件不存在");
  return row;
}

app.get("/messages/:id", async (c) => {
  const msg = await loadMessage(c, c.req.param("id"));
  let { text_body: text, html_body: html } = msg;
  if (msg.body_in_r2) {
    const blob = await getBlob(c.env, `body/${msg.id}.json`);
    const parsed: { html: string | null; text: string } = blob
      ? JSON.parse(new TextDecoder().decode(blob))
      : { html: null, text: "" };
    text = parsed.text;
    html = parsed.html;
  }
  const { results: attachments } = await c.env.DB.prepare(
    "SELECT id, filename, mime_type, size, content_id, inline FROM attachments WHERE message_id = ?",
  )
    .bind(msg.id)
    .all<Omit<AttachmentRow, "r2_key" | "message_id">>();
  if (!msg.is_read) {
    await c.env.DB.prepare("UPDATE messages SET is_read = 1 WHERE id = ?").bind(msg.id).run();
    msg.is_read = 1;
  }
  return c.json({
    message: { ...msg, text_body: text, html_body: html, raw_key: undefined },
    attachments,
  });
});

type BatchAction = "read" | "unread" | "star" | "unstar" | "archive" | "inbox" | "trash" | "restore" | "delete";

async function applyAction(env: Env, ids: string[], action: BatchAction): Promise<void> {
  if (!ids.length) return;
  if (action === "delete") return purgeMessages(env, ids);
  const marks = ids.map(() => "?").join(",");
  const sql: Record<Exclude<BatchAction, "delete">, string> = {
    read: "is_read = 1",
    unread: "is_read = 0",
    star: "is_starred = 1",
    unstar: "is_starred = 0",
    archive: "prev_folder = folder, folder = 'archive'",
    inbox: "prev_folder = folder, folder = 'inbox'",
    trash:
      "prev_folder = CASE WHEN folder = 'trash' THEN prev_folder ELSE folder END, folder = 'trash', trashed_at = strftime('%s', 'now') * 1000",
    restore: "folder = COALESCE(prev_folder, 'inbox'), prev_folder = NULL",
  };
  await env.DB.prepare(`UPDATE messages SET ${sql[action]} WHERE id IN (${marks})`).bind(...ids).run();
}

app.post("/messages/batch", async (c) => {
  const { ids, action } = await body<{ ids: string[]; action: BatchAction }>(c);
  const valid: BatchAction[] = ["read", "unread", "star", "unstar", "archive", "inbox", "trash", "restore", "delete"];
  if (!Array.isArray(ids) || !valid.includes(action)) throw new HttpError(400, "参数错误");
  for (let i = 0; i < ids.length; i += 90) await applyAction(c.env, ids.slice(i, i + 90).map(String), action);
  return c.json({ ok: true });
});

app.post("/folders/trash/empty", async (c) => {
  const { results } = await c.env.DB.prepare("SELECT id FROM messages WHERE folder = 'trash'").all<{ id: string }>();
  await purgeMessages(c.env, results.map((r) => r.id));
  return c.json({ ok: true, deleted: results.length });
});

app.get("/messages/:id/raw", async (c) => {
  const msg = await loadMessage(c, c.req.param("id"));
  if (!msg.raw_key) throw new HttpError(404, "这封邮件没有保存原始文件");
  const blob = await getBlob(c.env, msg.raw_key);
  if (!blob) throw new HttpError(404, "原始文件不存在");
  return new Response(blob, {
    headers: {
      "Content-Type": "message/rfc822",
      "Content-Disposition": `attachment; filename="${msg.id}.eml"`,
    },
  });
});

app.get("/attachments/:id", async (c) => {
  const att = await c.env.DB.prepare("SELECT * FROM attachments WHERE id = ?")
    .bind(c.req.param("id"))
    .first<AttachmentRow>();
  if (!att) throw new HttpError(404, "附件不存在");
  const blob = await getBlob(c.env, att.r2_key);
  if (!blob) throw new HttpError(404, "附件文件不存在");
  const download = c.req.query("download") === "1";
  // Only render types that cannot run script inline; everything else downloads.
  const inlineSafe = /^(image\/(png|jpe?g|gif|webp|avif|bmp)|application\/pdf|text\/plain|audio\/|video\/)/i.test(
    att.mime_type,
  );
  return new Response(blob, {
    headers: {
      "Content-Type": inlineSafe ? att.mime_type : "application/octet-stream",
      "Content-Disposition": `${download || !inlineSafe ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(att.filename)}`,
      "Cache-Control": "private, max-age=86400",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

app.post("/send", async (c) => {
  const result = await sendMail(c.env, await body<SendRequest>(c));
  return c.json(result);
});

// ---------------------------------------------------------------- mailboxes

app.post("/mailboxes", async (c) => {
  const input = await body<{ address: string; display_name?: string; forward_to?: string }>(c);
  const address = normalizeEmail(input.address ?? "");
  if (!isEmail(address)) throw new HttpError(400, "邮箱地址格式不正确");
  if (!(await findDomain(c.env.DB, domainOf(address)))) throw new HttpError(400, "请先添加该域名");
  const exists = await c.env.DB.prepare("SELECT id FROM mailboxes WHERE address = ?").bind(address).first();
  if (exists) throw new HttpError(409, "这个邮箱已经存在");
  const forward = normalizeEmail(input.forward_to ?? "");
  if (forward && !isEmail(forward)) throw new HttpError(400, "转发地址格式不正确");
  const mailbox = await createMailbox(c.env.DB, address, (input.display_name ?? "").trim().slice(0, 100), forward);
  return c.json({ mailbox });
});

app.patch("/mailboxes/:id", async (c) => {
  const input = await body<{ display_name?: string; forward_to?: string }>(c);
  const forward = normalizeEmail(input.forward_to ?? "");
  if (forward && !isEmail(forward)) throw new HttpError(400, "转发地址格式不正确");
  const row = await c.env.DB.prepare(
    "UPDATE mailboxes SET display_name = COALESCE(?, display_name), forward_to = COALESCE(?, forward_to) WHERE id = ? RETURNING *",
  )
    .bind(
      input.display_name === undefined ? null : input.display_name.trim().slice(0, 100),
      input.forward_to === undefined ? null : forward,
      Number(c.req.param("id")),
    )
    .first<MailboxRow>();
  if (!row) throw new HttpError(404, "邮箱不存在");
  return c.json({ mailbox: row });
});

app.delete("/mailboxes/:id", async (c) => {
  const id = Number(c.req.param("id"));
  const { results } = await c.env.DB.prepare("SELECT id FROM messages WHERE mailbox_id = ?").bind(id).all<{ id: string }>();
  await purgeMessages(c.env, results.map((r) => r.id));
  await c.env.DB.prepare("DELETE FROM mailboxes WHERE id = ?").bind(id).run();
  return c.json({ ok: true });
});

// ---------------------------------------------------------------- domains

app.post("/domains", async (c) => {
  const { name } = await body<{ name: string }>(c);
  const domain = (name ?? "").trim().toLowerCase().replace(/^@/, "");
  if (!/^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/.test(domain)) {
    throw new HttpError(400, "域名格式不正确");
  }
  const row = await c.env.DB.prepare(
    `INSERT INTO domains (name, receiving, sending, created_at) VALUES (?, 1, 1, ?)
     ON CONFLICT(name) DO UPDATE SET name = excluded.name RETURNING *`,
  )
    .bind(domain, Date.now())
    .first<DomainRow>();
  return c.json({ domain: row });
});

app.delete("/domains/:id", async (c) => {
  const domain = await c.env.DB.prepare("SELECT * FROM domains WHERE id = ?")
    .bind(Number(c.req.param("id")))
    .first<DomainRow>();
  if (!domain) throw new HttpError(404, "域名不存在");
  const token = await getSetting(c.env.DB, "cf_api_token");
  let warning = "";
  if (domain.zone_id && token) {
    try {
      await disconnectZone(token, domain.zone_id);
    } catch (e) {
      warning = `已从 FlareBox 移除，但关闭 Cloudflare Catch-all 失败：${(e as Error).message}`;
    }
  }
  await c.env.DB.prepare("DELETE FROM domains WHERE id = ?").bind(domain.id).run();
  return c.json({ ok: true, warning });
});

// ---------------------------------------------------------------- Cloudflare one-click

async function requireToken(c: Context<App>): Promise<string> {
  const token = await getSetting(c.env.DB, "cf_api_token");
  if (!token) throw new HttpError(400, "请先连接 Cloudflare");
  return token;
}

async function workerName(env: Env): Promise<string> {
  return (await getSetting(env.DB, "worker_name")) || env.WORKER_NAME;
}

app.get("/cf/token-url", (c) => c.json({ url: tokenTemplateUrl() }));

app.post("/cf/token", async (c) => {
  const { token } = await body<{ token: string }>(c);
  const value = (token ?? "").trim();
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(value)) throw new HttpError(400, "API 令牌格式不正确");
  const zones = await listZones(value); // throws if the token is invalid
  await setSetting(c.env.DB, "cf_api_token", value);
  return c.json({ ok: true, zones: zones.length });
});

app.delete("/cf/token", async (c) => {
  await deleteSetting(c.env.DB, "cf_api_token");
  return c.json({ ok: true });
});

app.get("/cf/zones", async (c) => {
  const token = await requireToken(c);
  const [zones, worker, { results: domains }] = await Promise.all([
    listZones(token),
    workerName(c.env),
    c.env.DB.prepare("SELECT * FROM domains").all<DomainRow>(),
  ]);
  const statuses = await Promise.all(zones.map((z) => zoneStatus(token, z, worker)));
  return c.json({
    worker,
    zones: zones.map((z, i) => ({
      ...z,
      ...statuses[i],
      added: domains.some((d) => d.name === z.name),
    })),
  });
});

app.post("/cf/zones/:zoneId/connect", async (c) => {
  const token = await requireToken(c);
  const zone = await getZone(token, c.req.param("zoneId"));
  const result = await connectZone(token, zone, await workerName(c.env));
  if (result.receiving || result.sending) {
    await c.env.DB.prepare(
      `INSERT INTO domains (name, zone_id, receiving, sending, created_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(name) DO UPDATE SET zone_id = excluded.zone_id, receiving = excluded.receiving, sending = excluded.sending`,
    )
      .bind(zone.name, zone.id, result.receiving ? 1 : 0, result.sending ? 1 : 0, Date.now())
      .run();
  }
  return c.json(result);
});

app.all("*", (c) => c.json({ error: "Not found" }, 404));

// ---------------------------------------------------------------- handlers

const TRASH_RETENTION_MS = 30 * 24 * 3600 * 1000;

export default {
  fetch: app.fetch,

  async email(message, env) {
    await handleInbound(message, env);
  },

  async scheduled(_event, env) {
    await ensureSchema(env.DB);
    const cutoff = Date.now() - TRASH_RETENTION_MS;
    const { results } = await env.DB.prepare("SELECT id FROM messages WHERE folder = 'trash' AND trashed_at < ? LIMIT 1000")
      .bind(cutoff)
      .all<{ id: string }>();
    await purgeMessages(env, results.map((r) => r.id));
    await env.DB.prepare("DELETE FROM sessions WHERE expires_at < ?").bind(Date.now()).run();
  },
} satisfies ExportedHandler<Env>;
