import { Check, CircleAlert, CircleCheck, Cloud, ExternalLink, KeyRound, RefreshCw, Zap } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { api, type ConnectStep, type Settings, type ZoneInfo } from "../api";
import { Spinner, useConfirm, useToast } from "./ui";

const PERMISSIONS = [
  ["区域 Zone", "读取", "列出你的域名"],
  ["区域设置 Zone Settings", "编辑", "启用邮件路由"],
  ["DNS", "编辑", "自动添加 MX / SPF / DKIM"],
  ["电子邮件路由规则 Email Routing Rules", "编辑", "把邮件交给 FlareBox"],
  ["电子邮件发送 Email Sending", "编辑", "开通域名发信（可选）"],
];

function StatusBadge({ ok, label, error }: { ok: boolean | null; label: string; error?: string }) {
  if (error) {
    return (
      <span className="badge err" title={error}>
        <CircleAlert /> {label}：无权限
      </span>
    );
  }
  return ok ? (
    <span className="badge ok">
      <Check /> {label}已开通
    </span>
  ) : (
    <span className="badge">{label}未开通</span>
  );
}

export function CloudflareConnect({ settings, onChanged }: { settings: Settings; onChanged: () => void }) {
  const notify = useToast();
  const confirm = useConfirm();
  const [token, setToken] = useState("");
  const [saving, setSaving] = useState(false);
  const [zones, setZones] = useState<ZoneInfo[] | null>(null);
  const [zonesError, setZonesError] = useState("");
  const [loadingZones, setLoadingZones] = useState(false);
  const [busyZone, setBusyZone] = useState<string | null>(null);
  const [results, setResults] = useState<Record<string, ConnectStep[]>>({});

  const loadZones = useCallback(async () => {
    setLoadingZones(true);
    setZonesError("");
    try {
      setZones((await api.cfZones()).zones);
    } catch (e) {
      setZonesError((e as Error).message);
    } finally {
      setLoadingZones(false);
    }
  }, []);

  useEffect(() => {
    if (settings.cf_connected) loadZones();
  }, [settings.cf_connected, loadZones]);

  const openTokenPage = async () => {
    const win = window.open("about:blank", "_blank");
    try {
      const { url } = await api.cfTokenUrl();
      if (win) win.location.href = url;
      else window.location.href = url;
    } catch (e) {
      win?.close();
      notify((e as Error).message, "error");
    }
  };

  const saveToken = async () => {
    setSaving(true);
    try {
      const r = await api.cfSaveToken(token.trim());
      notify(`已连接 Cloudflare，发现 ${r.zones} 个域名`, "success");
      setToken("");
      onChanged();
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setSaving(false);
    }
  };

  const disconnect = async () => {
    if (!(await confirm({ title: "断开 Cloudflare？", body: "只会删除保存在 FlareBox 中的 API 令牌，已接入的域名照常收发。", confirm: "断开", danger: true }))) return;
    await api.cfDisconnect();
    setZones(null);
    onChanged();
  };

  const connect = async (z: ZoneInfo) => {
    const currentCatchAll =
      "description" in z.catchAll && !z.catchAll.toThisWorker && z.catchAll.description !== "未启用" ? z.catchAll.description : "";
    const ok = await confirm({
      title: `一键接入 ${z.name}`,
      confirm: currentCatchAll ? "仍然接入并替换" : "开始接入",
      danger: !!currentCatchAll,
      body: (
        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          <span>FlareBox 将自动完成：</span>
          <div className="connect-steps">
            <div className="connect-step ok">
              <CircleCheck />
              启用 Email Routing，并添加 MX / SPF / DKIM 记录
            </div>
            <div className="connect-step ok">
              <CircleCheck />
              设置 Catch-all：所有 *@{z.name} 的邮件都进入 FlareBox
            </div>
            <div className="connect-step ok">
              <CircleCheck />
              开通 Cloudflare 发信（需要 Workers 付费计划）
            </div>
          </div>
          {currentCatchAll ? (
            <div className="callout err">
              <CircleAlert />
              <span>
                这个域名的 Catch-all 现在是<strong>「{currentCatchAll}」</strong>。接入后它会被替换为 FlareBox，原来的处理方式将<strong>不再收到</strong>
                未单独设置规则的地址的邮件。如果只想让部分地址进入 FlareBox，请改为在 Cloudflare 为这些地址添加「发送到 Worker」规则，然后在下方「高级」中手动添加域名。
              </span>
            </div>
          ) : (
            <div className="callout warn">
              <CircleAlert />
              <span>
                如果这个域名正在使用其它邮箱服务（如企业微信、腾讯企业邮、Google Workspace），接入后<strong>收信会切换到 FlareBox</strong>。
              </span>
            </div>
          )}
        </div>
      ),
    });
    if (!ok) return;
    setBusyZone(z.id);
    try {
      const r = await api.cfConnect(z.id);
      setResults((prev) => ({ ...prev, [z.id]: r.steps }));
      if (r.receiving && r.sending) notify(`${z.name} 接入完成，可以收发邮件了`, "success");
      else if (r.receiving) notify(`${z.name} 已可以收信，发信未开通（见下方说明）`, "info");
      else notify(`${z.name} 接入未完成，请查看下方说明`, "error");
      onChanged();
      loadZones();
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusyZone(null);
    }
  };

  if (!settings.cf_connected) {
    return (
      <div className="hero-connect">
        <div className="row">
          <div className="logo-mark" style={{ background: "linear-gradient(135deg,#fbad41,#f38020)" }}>
            <Cloud />
          </div>
          <div className="grow">
            <h4>连接 Cloudflare，一键接入域名</h4>
            <div className="muted" style={{ fontSize: 13 }}>
              授权一次，之后点一下就能把任意域名变成邮箱：自动配好 DNS、收信路由和发信。
            </div>
          </div>
        </div>

        <div>
          <div style={{ fontWeight: 650, color: "var(--text)", marginBottom: 8 }}>
            <span className="num">1</span>在 Cloudflare 创建授权令牌
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: 10, paddingLeft: 30 }}>
            <div className="muted" style={{ fontSize: 13 }}>
              点击下方按钮，Cloudflare 会打开已预填好权限的页面，确认后点「继续以显示摘要」→「创建令牌」，然后复制令牌。
            </div>
            <ul className="perm-list">
              {PERMISSIONS.map(([name, level, why]) => (
                <li key={name} title={why}>
                  <Check />
                  <span>
                    <code>{name}</code> · {level}
                  </span>
                </li>
              ))}
            </ul>
            <div>
              <button className="btn" onClick={openTokenPage}>
                <KeyRound /> 打开 Cloudflare 授权页 <ExternalLink style={{ width: 14, height: 14 }} />
              </button>
            </div>
          </div>
        </div>

        <div>
          <div style={{ fontWeight: 650, color: "var(--text)", marginBottom: 8 }}>
            <span className="num">2</span>粘贴令牌
          </div>
          <div className="row" style={{ paddingLeft: 30 }}>
            <input
              className="input mono grow"
              placeholder="粘贴 API 令牌"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && token.trim() && saveToken()}
            />
            <button className="btn btn-primary" onClick={saveToken} disabled={!token.trim() || saving}>
              {saving ? <Spinner size={16} /> : <Zap />} 连接
            </button>
          </div>
        </div>
        <div className="muted" style={{ fontSize: 12 }}>
          令牌只保存在你自己账户的 D1 数据库里，随时可以在 Cloudflare 控制台撤销。
        </div>
      </div>
    );
  }

  return (
    <div className="card">
      <div className="card-head">
        <div className="logo-mark" style={{ width: 28, height: 28, borderRadius: 8, background: "linear-gradient(135deg,#fbad41,#f38020)" }}>
          <Cloud style={{ width: 15, height: 15 }} />
        </div>
        <h4>
          Cloudflare 已连接 <span className="muted" style={{ fontWeight: 500, fontSize: 12.5 }}>令牌 {settings.cf_token_hint}</span>
        </h4>
        <button className="icon-btn sm" onClick={loadZones} title="刷新状态">
          {loadingZones ? <Spinner size={15} /> : <RefreshCw />}
        </button>
        <button className="btn btn-sm btn-ghost" onClick={disconnect}>
          断开
        </button>
      </div>
      <div className="card-body" style={{ padding: 0 }}>
        <p className="card-desc" style={{ padding: "0 16px" }}>
          选择要用作邮箱的域名，点击「一键接入」。
        </p>
        {zonesError && (
          <div className="callout err" style={{ margin: "0 16px" }}>
            <CircleAlert />
            <span>{zonesError}</span>
          </div>
        )}
        {!zones && loadingZones && (
          <div className="list-row">
            <Spinner /> <span className="muted">正在读取你的域名…</span>
          </div>
        )}
        {zones?.length === 0 && (
          <div className="list-row muted">这个令牌下没有域名。请先把域名添加到 Cloudflare，或检查令牌的区域范围。</div>
        )}
        <div>
          {zones?.map((z) => {
            const receivingOk = "toThisWorker" in z.catchAll && z.catchAll.toThisWorker && "enabled" in z.routing && z.routing.enabled;
            const sendingOk = "enabled" in z.sending && z.sending.enabled;
            const fullyConnected = receivingOk && sendingOk && z.added;
            return (
              <div key={z.id} style={{ borderTop: "1px solid var(--border)" }}>
                <div className="list-row" style={{ borderTop: "none" }}>
                  <div className="main">
                    <div className="name">{z.name}</div>
                    <div className="sub">
                      <StatusBadge ok={receivingOk} label="收信" error={"error" in z.catchAll ? z.catchAll.error : "error" in z.routing ? z.routing.error : undefined} />
                      <StatusBadge ok={sendingOk} label="发信" error={"error" in z.sending ? z.sending.error : undefined} />
                      {"description" in z.catchAll && !receivingOk && z.catchAll.description !== "未启用" && (
                        <span className="badge warn" title="当前 Catch-all 规则">
                          当前：{z.catchAll.description}
                        </span>
                      )}
                      {z.status !== "active" && <span className="badge warn">域名状态：{z.status}</span>}
                    </div>
                  </div>
                  {fullyConnected ? (
                    <button className="btn btn-sm" onClick={() => connect(z)} disabled={busyZone === z.id} title="重新执行接入">
                      {busyZone === z.id ? <Spinner size={14} /> : <Check />} 已接入
                    </button>
                  ) : (
                    <button className="btn btn-sm btn-primary" onClick={() => connect(z)} disabled={busyZone !== null}>
                      {busyZone === z.id ? <Spinner size={14} /> : <Zap />} 一键接入
                    </button>
                  )}
                </div>
                {results[z.id] && (
                  <div className="connect-steps" style={{ padding: "0 16px 14px" }}>
                    {results[z.id].map((s) => (
                      <div key={s.key} className={`connect-step ${s.ok ? "ok" : "fail"}`}>
                        {s.ok ? <CircleCheck /> : <CircleAlert />}
                        <span>{s.message}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
