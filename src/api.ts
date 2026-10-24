export type Folder = "inbox" | "sent" | "archive" | "trash";
export type View = Folder | "starred" | "unread";

export interface Domain {
  id: number;
  name: string;
  zone_id: string | null;
  receiving: number;
  sending: number;
}

export interface Mailbox {
  id: number;
  address: string;
  display_name: string;
  forward_to: string;
  created_at: number;
}

export interface FolderCount {
  mailbox_id: number;
  folder: Folder;
  total: number;
  unread: number;
  starred: number;
  /** Newest message (received or sent) in this mailbox/folder, epoch ms. */
  last_at: number;
}

export interface Settings {
  send_provider: "cloudflare" | "resend";
  resend_configured: boolean;
  auto_create_mailbox: boolean;
  block_remote_images: boolean;
  blocked_senders: string;
  signature: string;
  worker_name: string;
  cf_connected: boolean;
  cf_token_hint: string;
}

export interface Bootstrap {
  domains: Domain[];
  mailboxes: Mailbox[];
  counts: FolderCount[];
  settings: Settings;
}

export interface Address {
  name: string;
  address: string;
}

export interface MessageSummary {
  id: string;
  mailbox_id: number;
  folder: Folder;
  from_addr: string;
  from_name: string;
  to_json: string;
  subject: string;
  snippet: string;
  is_read: number;
  is_starred: number;
  has_attachments: number;
  created_at: number;
}

export interface MessageDetail extends MessageSummary {
  cc_json: string;
  bcc_json: string;
  reply_to: string;
  text_body: string | null;
  html_body: string | null;
  message_id: string | null;
  size: number;
}

export interface Attachment {
  id: string;
  filename: string;
  mime_type: string;
  size: number;
  content_id: string | null;
  inline: number;
}

export interface ZoneInfo {
  id: string;
  name: string;
  status: string;
  account: { id: string; name: string };
  added: boolean;
  routing: { enabled: boolean; status: string } | { error: string };
  catchAll: { toThisWorker: boolean; description: string } | { error: string };
  sending: { enabled: boolean } | { error: string };
}

export interface ConnectStep {
  key: "routing" | "catch_all" | "sending";
  ok: boolean;
  message: string;
}

export interface SendPayload {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  text: string;
  attachments: { filename: string; type: string; content: string }[];
  replyToId?: string;
  forwardAttachmentIds?: string[];
}

export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let onUnauthorized: () => void = () => {};
export function setUnauthorizedHandler(fn: () => void) {
  onUnauthorized = fn;
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(`/api${path}`, {
    method,
    credentials: "same-origin",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && !path.startsWith("/login") && !path.startsWith("/password")) onUnauthorized();
    throw new ApiError((data as { error?: string }).error ?? `请求失败（${res.status}）`, res.status);
  }
  return data as T;
}

export const api = {
  status: () =>
    request<{ initialized: boolean; authenticated: boolean; setup_token_required: boolean }>("GET", "/status"),
  setup: (password: string, setup_token: string) => request<{ ok: true }>("POST", "/setup", { password, setup_token }),
  login: (password: string) => request<{ ok: true }>("POST", "/login", { password }),
  logout: () => request<{ ok: true }>("POST", "/logout", {}),
  changePassword: (current: string, next: string) => request<{ ok: true }>("POST", "/password", { current, next }),

  bootstrap: () => request<Bootstrap>("GET", "/bootstrap"),
  saveSettings: (patch: Partial<Settings> & { resend_api_key?: string }) =>
    request<{ settings: Settings }>("PUT", "/settings", patch),

  messages: (params: { folder: View; mailbox: number | "all"; q?: string; before?: string }) => {
    const qs = new URLSearchParams({ folder: params.folder, mailbox: String(params.mailbox) });
    if (params.q) qs.set("q", params.q);
    if (params.before) qs.set("before", params.before);
    return request<{ messages: MessageSummary[]; more: boolean }>("GET", `/messages?${qs}`);
  },
  message: (id: string) => request<{ message: MessageDetail; attachments: Attachment[] }>("GET", `/messages/${id}`),
  batch: (ids: string[], action: "read" | "unread" | "star" | "unstar" | "archive" | "inbox" | "trash" | "restore" | "delete") =>
    request<{ ok: true }>("POST", "/messages/batch", { ids, action }),
  emptyTrash: () => request<{ ok: true; deleted: number }>("POST", "/folders/trash/empty", {}),
  send: (payload: SendPayload) => request<{ id: string }>("POST", "/send", payload),

  createMailbox: (address: string, display_name: string, forward_to: string) =>
    request<{ mailbox: Mailbox }>("POST", "/mailboxes", { address, display_name, forward_to }),
  updateMailbox: (id: number, patch: { display_name?: string; forward_to?: string }) =>
    request<{ mailbox: Mailbox }>("PATCH", `/mailboxes/${id}`, patch),
  deleteMailbox: (id: number) => request<{ ok: true }>("DELETE", `/mailboxes/${id}`),

  addDomain: (name: string) => request<{ domain: Domain }>("POST", "/domains", { name }),
  deleteDomain: (id: number) => request<{ ok: true; warning: string }>("DELETE", `/domains/${id}`),

  cfTokenUrl: () => request<{ url: string }>("GET", "/cf/token-url"),
  cfSaveToken: (token: string) => request<{ ok: true; zones: number }>("POST", "/cf/token", { token }),
  cfDisconnect: () => request<{ ok: true }>("DELETE", "/cf/token"),
  cfZones: () => request<{ worker: string; zones: ZoneInfo[] }>("GET", "/cf/zones"),
  cfConnect: (zoneId: string) =>
    request<{ steps: ConnectStep[]; receiving: boolean; sending: boolean }>("POST", `/cf/zones/${zoneId}/connect`, {}),
};

export const attachmentUrl = (id: string, download = false) => `/api/attachments/${id}${download ? "?download=1" : ""}`;
export const rawUrl = (id: string) => `/api/messages/${id}/raw`;
