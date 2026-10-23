import { deleteBlobs } from "./storage";

// The schema is created at runtime on first use, so a fresh deploy (Deploy
// button or `wrangler deploy`) works without running D1 migrations by hand.
const SCHEMA_VERSION = 2;

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS sessions (
    token_hash TEXT PRIMARY KEY,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS rate_limits (
    key TEXT PRIMARY KEY,
    count INTEGER NOT NULL,
    reset_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS domains (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    zone_id TEXT,
    receiving INTEGER NOT NULL DEFAULT 0,
    sending INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS mailboxes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    address TEXT NOT NULL UNIQUE,
    display_name TEXT NOT NULL DEFAULT '',
    forward_to TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS messages (
    id TEXT PRIMARY KEY,
    mailbox_id INTEGER NOT NULL,
    folder TEXT NOT NULL,
    prev_folder TEXT,
    trashed_at INTEGER,
    from_addr TEXT NOT NULL,
    from_name TEXT NOT NULL DEFAULT '',
    to_json TEXT NOT NULL DEFAULT '[]',
    cc_json TEXT NOT NULL DEFAULT '[]',
    bcc_json TEXT NOT NULL DEFAULT '[]',
    reply_to TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    snippet TEXT NOT NULL DEFAULT '',
    text_body TEXT,
    html_body TEXT,
    body_in_r2 INTEGER NOT NULL DEFAULT 0,
    message_id TEXT,
    in_reply_to TEXT,
    references_hdr TEXT,
    is_read INTEGER NOT NULL DEFAULT 0,
    is_starred INTEGER NOT NULL DEFAULT 0,
    has_attachments INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL DEFAULT 0,
    raw_key TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_messages_mailbox ON messages (mailbox_id, folder, id)`,
  `CREATE INDEX IF NOT EXISTS idx_messages_folder ON messages (folder, id)`,
  `CREATE TABLE IF NOT EXISTS attachments (
    id TEXT PRIMARY KEY,
    message_id TEXT NOT NULL,
    filename TEXT NOT NULL,
    mime_type TEXT NOT NULL,
    size INTEGER NOT NULL,
    r2_key TEXT NOT NULL,
    content_id TEXT,
    inline INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_attachments_message ON attachments (message_id)`,
  `CREATE TABLE IF NOT EXISTS blobs (
    key TEXT NOT NULL,
    seq INTEGER NOT NULL,
    data TEXT NOT NULL,
    PRIMARY KEY (key, seq)
  )`,
];

let ready: Promise<void> | null = null;

export function ensureSchema(db: D1Database): Promise<void> {
  if (!ready) {
    ready = migrate(db).catch((err) => {
      ready = null;
      throw err;
    });
  }
  return ready;
}

async function migrate(db: D1Database): Promise<void> {
  try {
    const row = await db
      .prepare("SELECT value FROM settings WHERE key = 'schema_version'")
      .first<{ value: string }>();
    if (row && Number(row.value) >= SCHEMA_VERSION) return;
  } catch {
    // settings table does not exist yet
  }
  await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
  await setSetting(db, "schema_version", String(SCHEMA_VERSION));
}

export type SettingKey =
  | "schema_version"
  | "admin_password_hash"
  | "cf_api_token"
  | "worker_name"
  | "send_provider"
  | "resend_api_key"
  | "auto_create_mailbox"
  | "block_remote_images"
  | "blocked_senders"
  | "signature";

export async function getSetting(db: D1Database, key: SettingKey): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export async function getSettings(db: D1Database): Promise<Partial<Record<SettingKey, string>>> {
  const { results } = await db.prepare("SELECT key, value FROM settings").all<{ key: SettingKey; value: string }>();
  return Object.fromEntries(results.map((r) => [r.key, r.value]));
}

export async function setSetting(db: D1Database, key: SettingKey, value: string): Promise<void> {
  await db
    .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

export async function deleteSetting(db: D1Database, key: SettingKey): Promise<void> {
  await db.prepare("DELETE FROM settings WHERE key = ?").bind(key).run();
}

export interface DomainRow {
  id: number;
  name: string;
  zone_id: string | null;
  receiving: number;
  sending: number;
  created_at: number;
}

export interface MailboxRow {
  id: number;
  address: string;
  display_name: string;
  forward_to: string;
  created_at: number;
}

export interface MessageRow {
  id: string;
  mailbox_id: number;
  folder: Folder;
  prev_folder: Folder | null;
  trashed_at: number | null;
  from_addr: string;
  from_name: string;
  to_json: string;
  cc_json: string;
  bcc_json: string;
  reply_to: string;
  subject: string;
  snippet: string;
  text_body: string | null;
  html_body: string | null;
  body_in_r2: number;
  message_id: string | null;
  in_reply_to: string | null;
  references_hdr: string | null;
  is_read: number;
  is_starred: number;
  has_attachments: number;
  size: number;
  raw_key: string | null;
  created_at: number;
}

export interface AttachmentRow {
  id: string;
  message_id: string;
  filename: string;
  mime_type: string;
  size: number;
  r2_key: string;
  content_id: string | null;
  inline: number;
}

export type Folder = "inbox" | "sent" | "archive" | "trash";
export const FOLDERS: Folder[] = ["inbox", "sent", "archive", "trash"];

/** Bodies above this size go to R2 instead of a D1 row (D1 rows are capped at 2 MB). */
export const MAX_INLINE_BODY = 700_000;

export async function findMailbox(db: D1Database, address: string): Promise<MailboxRow | null> {
  return db.prepare("SELECT * FROM mailboxes WHERE address = ?").bind(address).first<MailboxRow>();
}

export async function findDomain(db: D1Database, name: string): Promise<DomainRow | null> {
  return db.prepare("SELECT * FROM domains WHERE name = ?").bind(name).first<DomainRow>();
}

export async function createMailbox(
  db: D1Database,
  address: string,
  displayName = "",
  forwardTo = "",
): Promise<MailboxRow> {
  const row = await db
    .prepare(
      `INSERT INTO mailboxes (address, display_name, forward_to, created_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(address) DO UPDATE SET address = excluded.address
       RETURNING *`,
    )
    .bind(address, displayName, forwardTo, Date.now())
    .first<MailboxRow>();
  return row!;
}

/** Deletes messages (rows, attachments and R2 objects). */
export async function purgeMessages(env: Env, ids: string[]): Promise<void> {
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const marks = chunk.map(() => "?").join(",");
    const { results: atts } = await env.DB.prepare(`SELECT r2_key FROM attachments WHERE message_id IN (${marks})`)
      .bind(...chunk)
      .all<{ r2_key: string }>();
    const { results: msgs } = await env.DB.prepare(`SELECT raw_key, body_in_r2, id FROM messages WHERE id IN (${marks})`)
      .bind(...chunk)
      .all<{ raw_key: string | null; body_in_r2: number; id: string }>();
    const keys = [
      ...atts.map((a) => a.r2_key),
      ...msgs.flatMap((m) => [m.raw_key, m.body_in_r2 ? `body/${m.id}.json` : null]).filter((k): k is string => !!k),
    ];
    await deleteBlobs(env, keys);
    await env.DB.batch([
      env.DB.prepare(`DELETE FROM attachments WHERE message_id IN (${marks})`).bind(...chunk),
      env.DB.prepare(`DELETE FROM messages WHERE id IN (${marks})`).bind(...chunk),
    ]);
  }
}
