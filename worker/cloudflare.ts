// Talks to the Cloudflare API with the user's API token so a domain can be
// connected with one click: enable Email Routing (MX/SPF/DKIM), point the
// catch-all rule at this Worker, and onboard the domain for Email Sending.
const API = "https://api.cloudflare.com/client/v4";

export class CfApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly codes: number[] = [],
  ) {
    super(message);
  }
}

interface Envelope<T> {
  success: boolean;
  result: T;
  errors?: { code: number; message: string }[];
  result_info?: { page: number; total_pages: number };
}

async function cfRaw<T>(token: string, path: string, method = "GET", body?: unknown): Promise<Envelope<T>> {
  const res = await fetch(API + path, {
    method,
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let data: Envelope<T>;
  try {
    data = await res.json();
  } catch {
    throw new CfApiError(`Cloudflare API 返回 ${res.status}`, res.status);
  }
  if (!res.ok || !data.success) {
    const errors = data.errors ?? [];
    const message = errors.map((e) => `${e.message} (${e.code})`).join("; ") || `HTTP ${res.status}`;
    throw new CfApiError(message, res.status, errors.map((e) => e.code));
  }
  return data;
}

async function cf<T>(token: string, path: string, method = "GET", body?: unknown): Promise<T> {
  return (await cfRaw<T>(token, path, method, body)).result;
}

export interface Zone {
  id: string;
  name: string;
  status: string;
  account: { id: string; name: string };
}

export async function listZones(token: string): Promise<Zone[]> {
  const zones: Zone[] = [];
  for (let page = 1; page <= 20; page++) {
    const data = await cfRaw<Zone[]>(token, `/zones?per_page=50&page=${page}`);
    zones.push(...data.result);
    if (!data.result_info || page >= data.result_info.total_pages) break;
  }
  return zones.map((z) => ({ id: z.id, name: z.name, status: z.status, account: z.account }));
}

export async function getZone(token: string, zoneId: string): Promise<Zone> {
  return cf<Zone>(token, `/zones/${encodeURIComponent(zoneId)}`);
}

interface RoutingSettings {
  enabled: boolean;
  status?: string;
}

interface CatchAllRule {
  enabled: boolean;
  actions: { type: string; value?: string[] }[];
}

interface SendingSubdomain {
  name: string;
  enabled: boolean;
  tag: string;
}

export interface ZoneStatus {
  zoneId: string;
  name: string;
  routing: { enabled: boolean; status: string } | { error: string };
  catchAll: { toThisWorker: boolean; description: string } | { error: string };
  sending: { enabled: boolean } | { error: string };
}

function describeCatchAll(rule: CatchAllRule): string {
  if (!rule.enabled) return "未启用";
  const action = rule.actions[0];
  if (!action) return "未设置";
  if (action.type === "worker") return `Worker：${action.value?.[0] ?? "?"}`;
  if (action.type === "forward") return `转发到：${action.value?.[0] ?? "?"}`;
  if (action.type === "drop") return "丢弃";
  return action.type;
}

export async function zoneStatus(token: string, zone: { id: string; name: string }, workerName: string): Promise<ZoneStatus> {
  const id = encodeURIComponent(zone.id);
  const [routing, catchAll, sending] = await Promise.allSettled([
    cf<RoutingSettings>(token, `/zones/${id}/email/routing`),
    cf<CatchAllRule>(token, `/zones/${id}/email/routing/rules/catch_all`),
    cf<SendingSubdomain[]>(token, `/zones/${id}/email/sending/subdomains`),
  ]);
  const err = (r: PromiseRejectedResult) => ({ error: (r.reason as Error).message });
  return {
    zoneId: zone.id,
    name: zone.name,
    routing:
      routing.status === "fulfilled"
        ? { enabled: routing.value.enabled, status: routing.value.status ?? "" }
        : err(routing),
    catchAll:
      catchAll.status === "fulfilled"
        ? {
            toThisWorker:
              catchAll.value.enabled &&
              catchAll.value.actions[0]?.type === "worker" &&
              catchAll.value.actions[0]?.value?.[0] === workerName,
            description: describeCatchAll(catchAll.value),
          }
        : err(catchAll),
    sending:
      sending.status === "fulfilled"
        ? { enabled: sending.value.some((s) => s.name === zone.name && s.enabled) }
        : err(sending),
  };
}

export interface ConnectStep {
  key: "routing" | "catch_all" | "sending";
  ok: boolean;
  message: string;
}

export async function connectZone(
  token: string,
  zone: { id: string; name: string },
  workerName: string,
): Promise<{ steps: ConnectStep[]; receiving: boolean; sending: boolean }> {
  const id = encodeURIComponent(zone.id);
  const steps: ConnectStep[] = [];

  // 1. Email Routing (adds MX / SPF / DKIM records on the apex domain)
  let routingOk = false;
  try {
    const settings = await cf<RoutingSettings>(token, `/zones/${id}/email/routing`).catch(() => null);
    if (settings?.enabled) {
      steps.push({ key: "routing", ok: true, message: "邮件路由已启用" });
    } else {
      await cf(token, `/zones/${id}/email/routing/dns`, "POST", {});
      steps.push({ key: "routing", ok: true, message: "已启用邮件路由，并自动添加 MX / SPF / DKIM 记录" });
    }
    routingOk = true;
  } catch (e) {
    steps.push({ key: "routing", ok: false, message: `启用邮件路由失败：${(e as Error).message}` });
  }

  // 2. Catch-all -> this Worker, so every address on the domain arrives here
  let catchAllOk = false;
  if (routingOk) {
    try {
      await cf(token, `/zones/${id}/email/routing/rules/catch_all`, "PUT", {
        name: "FlareBox catch-all",
        enabled: true,
        matchers: [{ type: "all" }],
        actions: [{ type: "worker", value: [workerName] }],
      });
      catchAllOk = true;
      steps.push({ key: "catch_all", ok: true, message: `所有 *@${zone.name} 邮件都会投递到 Worker「${workerName}」` });
    } catch (e) {
      steps.push({ key: "catch_all", ok: false, message: `设置 Catch-all 规则失败：${(e as Error).message}` });
    }
  }

  // 3. Email Sending onboarding (requires Workers Paid). Failure here still leaves receiving working.
  let sendingOk = false;
  try {
    const existing = await cf<SendingSubdomain[]>(token, `/zones/${id}/email/sending/subdomains`);
    const current = existing.find((s) => s.name === zone.name);
    if (current?.enabled) {
      steps.push({ key: "sending", ok: true, message: "发信域名已开通" });
    } else if (current) {
      await cf(token, `/zones/${id}/email/sending/subdomains/${encodeURIComponent(current.tag)}`, "PATCH", { enabled: true });
      steps.push({ key: "sending", ok: true, message: "已重新启用发信域名" });
    } else {
      await cf(token, `/zones/${id}/email/sending/subdomains`, "POST", { name: zone.name });
      steps.push({ key: "sending", ok: true, message: "已开通发信，并自动添加 SPF / DKIM / DMARC 记录" });
    }
    sendingOk = true;
  } catch (e) {
    steps.push({
      key: "sending",
      ok: false,
      message: `开通 Cloudflare 发信失败（需要 Workers 付费计划；也可以改用 Resend 发信）：${(e as Error).message}`,
    });
  }

  return { steps, receiving: routingOk && catchAllOk, sending: sendingOk };
}

/**
 * Turns the catch-all rule off so mail stops arriving at this Worker. DNS records are left in place.
 * A catch-all that routes somewhere else (another Worker, a forward) is never touched.
 */
export async function disconnectZone(token: string, zoneId: string, workerName: string): Promise<boolean> {
  const id = encodeURIComponent(zoneId);
  const rule = await cf<CatchAllRule>(token, `/zones/${id}/email/routing/rules/catch_all`);
  const ours = rule.actions.some((a) => a.type === "worker" && a.value?.[0] === workerName);
  if (!ours) return false;
  await cf(token, `/zones/${id}/email/routing/rules/catch_all`, "PUT", {
    name: "FlareBox catch-all (disabled)",
    enabled: false,
    matchers: [{ type: "all" }],
    actions: [{ type: "drop" }],
  });
  return true;
}

/** Pre-filled "create API token" page in the Cloudflare dashboard. */
export function tokenTemplateUrl(): string {
  const permissions = [
    { key: "zone", type: "read" },
    { key: "zone_settings", type: "edit" },
    { key: "dns", type: "edit" },
    { key: "email_routing_rules", type: "edit" },
    { key: "email_sending", type: "edit" },
  ];
  const params = new URLSearchParams({
    permissionGroupKeys: JSON.stringify(permissions),
    accountId: "*",
    zoneId: "all",
    name: "FlareBox Mail",
  });
  return `https://dash.cloudflare.com/profile/api-tokens?${params}`;
}
