import { AtSign, ChevronRight, Cloud, Globe, Inbox, Lock, Plus, Send, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { api, type Bootstrap, type Mailbox, type Settings as SettingsData } from "../api";
import { CloudflareConnect } from "./CloudflareConnect";
import { Avatar, Spinner, Switch, useAsync, useConfirm, useToast } from "./ui";

export type SettingsTab = "domains" | "mailboxes" | "sending" | "receiving" | "account";

const TABS: { key: SettingsTab; label: string; icon: typeof Globe }[] = [
  { key: "domains", label: "域名", icon: Globe },
  { key: "mailboxes", label: "邮箱地址", icon: AtSign },
  { key: "sending", label: "发信", icon: Send },
  { key: "receiving", label: "收信", icon: Inbox },
  { key: "account", label: "账户安全", icon: Lock },
];

export function SettingsPanel({
  data,
  tab,
  onTab,
  onClose,
  onChanged,
  onNewMailbox,
}: {
  data: Bootstrap;
  tab: SettingsTab;
  onTab: (t: SettingsTab) => void;
  onClose: () => void;
  onChanged: () => void;
  onNewMailbox: () => void;
}) {
  const current = TABS.find((t) => t.key === tab)!;
  return (
    <div className="settings">
      <nav className="settings-nav">
        <h3>设置</h3>
        {TABS.map(({ key, label, icon: Icon }) => (
          <button key={key} className={`nav-item${tab === key ? " active" : ""}`} onClick={() => onTab(key)}>
            <Icon />
            <span className="label">{label}</span>
          </button>
        ))}
      </nav>
      <div className="settings-main">
        <div className="settings-main-head">
          <h2>{current.label}</h2>
          <button className="icon-btn sm" onClick={onClose} aria-label="关闭">
            <X />
          </button>
        </div>
        <div className="settings-content scroll">
          {tab === "domains" && <DomainsTab data={data} onChanged={onChanged} />}
          {tab === "mailboxes" && <MailboxesTab data={data} onChanged={onChanged} onNew={onNewMailbox} />}
          {tab === "sending" && <SendingTab settings={data.settings} onChanged={onChanged} />}
          {tab === "receiving" && <ReceivingTab settings={data.settings} onChanged={onChanged} />}
          {tab === "account" && <AccountTab />}
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------- domains

function DomainsTab({ data, onChanged }: { data: Bootstrap; onChanged: () => void }) {
  const confirm = useConfirm();
  const notify = useToast();
  const [manual, setManual] = useState("");
  const [worker, setWorker] = useState(data.settings.worker_name);
  const { busy, run } = useAsync();

  const remove = async (id: number, name: string) => {
    const ok = await confirm({
      title: `移除 ${name}？`,
      body: "FlareBox 将停止接收该域名的邮件（会关闭 Cloudflare 上的 Catch-all 规则）。已收到的邮件和邮箱地址会保留。",
      confirm: "移除",
      danger: true,
    });
    if (!ok) return;
    const r = await run(() => api.deleteDomain(id));
    if (r?.warning) notify(r.warning, "error");
    onChanged();
  };

  return (
    <>
      <CloudflareConnect settings={data.settings} onChanged={onChanged} />

      <div className="card">
        <div className="card-head">
          <h4>已添加的域名</h4>
          <span className="badge">{data.domains.length}</span>
        </div>
        <div className="card-body" style={{ padding: 0 }}>
          {data.domains.length === 0 && <div className="list-row muted">还没有域名。连接 Cloudflare 后点击「一键接入」即可。</div>}
          {data.domains.map((d) => {
            const count = data.mailboxes.filter((m) => m.address.endsWith(`@${d.name}`)).length;
            return (
              <div className="list-row" key={d.id}>
                <div className="logo-mark" style={{ width: 32, height: 32, borderRadius: 9, background: "var(--surface-hover)", color: "var(--text-2)", boxShadow: "none" }}>
                  <Globe style={{ width: 16, height: 16 }} />
                </div>
                <div className="main">
                  <div className="name">{d.name}</div>
                  <div className="sub">
                    <span className={`badge ${d.receiving ? "ok" : ""}`}>{d.receiving ? "收信正常" : "未接收"}</span>
                    <span className={`badge ${d.sending ? "ok" : ""}`}>{d.sending ? "可发信" : "发信未开通"}</span>
                    <span className="badge">{d.zone_id ? "自动接入" : "手动配置"}</span>
                    <span className="badge">{count} 个邮箱</span>
                  </div>
                </div>
                <button className="icon-btn sm" onClick={() => remove(d.id, d.name)} title="移除域名" disabled={busy}>
                  <Trash2 />
                </button>
              </div>
            );
          })}
        </div>
      </div>

      <details className="adv">
        <summary>
          <ChevronRight /> 高级：手动添加域名 / Worker 名称
        </summary>
        <div>
          <div className="card">
            <div className="card-body">
              <div className="field">
                <span className="field-label">手动添加域名</span>
                <span className="field-hint">
                  不想授权 API 令牌？可以手动操作：在 Cloudflare 控制台 → 计算 → Email Service → Email Routing 中启用该域名，并把
                  Catch-all 规则设为「发送到 Worker：{data.settings.worker_name}」，然后在这里添加域名。
                </span>
              </div>
              <div className="row">
                <input className="input grow" placeholder="example.com" value={manual} onChange={(e) => setManual(e.target.value)} />
                <button
                  className="btn"
                  disabled={!manual.trim() || busy}
                  onClick={async () => {
                    if (await run(() => api.addDomain(manual), "域名已添加")) {
                      setManual("");
                      onChanged();
                    }
                  }}
                >
                  <Plus /> 添加
                </button>
              </div>
            </div>
          </div>
          <div className="card">
            <div className="card-body">
              <div className="field">
                <span className="field-label">Worker 名称</span>
                <span className="field-hint">一键接入时，Catch-all 规则会指向这个 Worker。只有部署时改过名字才需要修改。</span>
              </div>
              <div className="row">
                <input className="input mono grow" value={worker} onChange={(e) => setWorker(e.target.value)} />
                <button
                  className="btn"
                  disabled={busy || worker === data.settings.worker_name}
                  onClick={async () => {
                    if (await run(() => api.saveSettings({ worker_name: worker.trim() }), "已保存")) onChanged();
                  }}
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      </details>
    </>
  );
}

// ---------------------------------------------------------------- mailboxes

function MailboxesTab({ data, onChanged, onNew }: { data: Bootstrap; onChanged: () => void; onNew: () => void }) {
  const [editing, setEditing] = useState<Mailbox | null>(null);
  const confirm = useConfirm();
  const { busy, run } = useAsync();

  const remove = async (m: Mailbox) => {
    const ok = await confirm({
      title: `删除 ${m.address}？`,
      body: "该邮箱的所有邮件和附件都会被永久删除，无法恢复。如果开启了「自动创建邮箱」，再次收到发往这个地址的邮件时会重新创建它。",
      confirm: "永久删除",
      danger: true,
    });
    if (ok && (await run(() => api.deleteMailbox(m.id), "邮箱已删除"))) onChanged();
  };

  return (
    <>
      <div className="row">
        <p className="card-desc grow">
          每个域名下可以有任意多个地址。开启「自动创建邮箱」后，别人给任何地址发信都会自动出现在这里。
        </p>
        <button className="btn btn-primary btn-sm" onClick={onNew} disabled={!data.domains.length}>
          <Plus /> 新建邮箱
        </button>
      </div>
      <div className="card">
        {data.mailboxes.length === 0 && <div className="list-row muted">还没有邮箱地址。</div>}
        {data.mailboxes.map((m) =>
          editing?.id === m.id ? (
            <div className="card-body" key={m.id} style={{ borderTop: "1px solid var(--border)" }}>
              <div className="name" style={{ fontWeight: 650, color: "var(--text)" }}>
                {m.address}
              </div>
              <div className="field">
                <label>发件人名称</label>
                <input className="input" value={editing.display_name} onChange={(e) => setEditing({ ...editing, display_name: e.target.value })} placeholder="例如：张三" />
              </div>
              <div className="field">
                <label>同时转发到（可选）</label>
                <input className="input" value={editing.forward_to} onChange={(e) => setEditing({ ...editing, forward_to: e.target.value })} placeholder="you@gmail.com" />
                <span className="field-hint">需要先在 Cloudflare Email Routing 的「目标地址」中验证这个邮箱。</span>
              </div>
              <div className="row" style={{ justifyContent: "flex-end" }}>
                <button className="btn btn-sm" onClick={() => setEditing(null)}>
                  取消
                </button>
                <button
                  className="btn btn-sm btn-primary"
                  disabled={busy}
                  onClick={async () => {
                    if (await run(() => api.updateMailbox(m.id, { display_name: editing.display_name, forward_to: editing.forward_to }), "已保存")) {
                      setEditing(null);
                      onChanged();
                    }
                  }}
                >
                  保存
                </button>
              </div>
            </div>
          ) : (
            <div className="list-row" key={m.id}>
              <Avatar name={m.display_name || m.address} seed={m.address} />
              <div className="main">
                <div className="name">{m.address}</div>
                <div className="sub">
                  {m.display_name ? <span>发件人名称：{m.display_name}</span> : <span>未设置发件人名称</span>}
                  {m.forward_to && <span>· 转发到 {m.forward_to}</span>}
                </div>
              </div>
              <button className="btn btn-sm btn-ghost" onClick={() => setEditing(m)}>
                编辑
              </button>
              <button className="icon-btn sm" onClick={() => remove(m)} title="删除邮箱">
                <Trash2 />
              </button>
            </div>
          ),
        )}
      </div>
    </>
  );
}

// ---------------------------------------------------------------- sending

function SendingTab({ settings, onChanged }: { settings: SettingsData; onChanged: () => void }) {
  const [provider, setProvider] = useState(settings.send_provider);
  const [key, setKey] = useState("");
  const [signature, setSignature] = useState(settings.signature);
  const { busy, run } = useAsync();
  useEffect(() => setProvider(settings.send_provider), [settings.send_provider]);

  const save = async (patch: Parameters<typeof api.saveSettings>[0]) => {
    if (await run(() => api.saveSettings(patch), "已保存")) onChanged();
  };

  return (
    <>
      <div className="card">
        <div className="card-head">
          <h4>发信方式</h4>
        </div>
        <div className="card-body">
          <div className="segmented">
            <button className={provider === "cloudflare" ? "on" : ""} onClick={() => (setProvider("cloudflare"), save({ send_provider: "cloudflare" }))}>
              <Cloud /> Cloudflare
            </button>
            <button className={provider === "resend" ? "on" : ""} onClick={() => (setProvider("resend"), save({ send_provider: "resend" }))}>
              <Send /> Resend
            </button>
          </div>
          {provider === "cloudflare" ? (
            <p className="card-desc">
              使用 Cloudflare Email Service 原生发信，无需第三方账号。需要 Workers 付费计划（$5/月），并在「域名」里完成一键接入（会自动开通发信域名）。
            </p>
          ) : (
            <>
              <p className="card-desc">
                使用 Resend 发信（免费每月 3000 封）。请先在 resend.com 添加并验证你的域名，然后创建 API Key 填到这里。
              </p>
              <div className="row">
                <input
                  className="input mono grow"
                  type="password"
                  placeholder={settings.resend_configured ? "已保存（输入新值可替换）" : "re_xxxxxxxx"}
                  value={key}
                  onChange={(e) => setKey(e.target.value)}
                />
                <button className="btn" disabled={!key.trim() || busy} onClick={() => save({ resend_api_key: key.trim() }).then(() => setKey(""))}>
                  保存
                </button>
              </div>
              {settings.resend_configured && <span className="badge ok" style={{ alignSelf: "flex-start" }}>Resend API Key 已配置</span>}
            </>
          )}
        </div>
      </div>

      <div className="card">
        <div className="card-head">
          <h4>签名</h4>
        </div>
        <div className="card-body">
          <textarea className="textarea" rows={4} placeholder="写新邮件时自动附加在末尾，例如：&#10;张三&#10;产品经理 · Example Inc." value={signature} onChange={(e) => setSignature(e.target.value)} />
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-sm" disabled={busy || signature === settings.signature} onClick={() => save({ signature })}>
              保存签名
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- receiving

function ReceivingTab({ settings, onChanged }: { settings: SettingsData; onChanged: () => void }) {
  const [blocked, setBlocked] = useState(settings.blocked_senders);
  const { busy, run } = useAsync();
  const save = async (patch: Parameters<typeof api.saveSettings>[0]) => {
    if (await run(() => api.saveSettings(patch), "已保存")) onChanged();
  };
  return (
    <>
      <div className="card">
        <div className="setting-row">
          <div className="text">
            <div className="title">自动创建邮箱</div>
            <div className="desc">发往域名下任意地址的邮件都会被接收，并自动创建对应邮箱。关闭后，只接收已创建邮箱的邮件。</div>
          </div>
          <Switch on={settings.auto_create_mailbox} onChange={(v) => save({ auto_create_mailbox: v })} label="自动创建邮箱" />
        </div>
        <div className="setting-row">
          <div className="text">
            <div className="title">默认阻止外部图片</div>
            <div className="desc">防止发件人通过追踪像素得知你何时打开了邮件。可在每封邮件中单独显示。</div>
          </div>
          <Switch on={settings.block_remote_images} onChange={(v) => save({ block_remote_images: v })} label="阻止外部图片" />
        </div>
      </div>
      <div className="card">
        <div className="card-head">
          <h4>黑名单</h4>
        </div>
        <div className="card-body">
          <p className="card-desc">每行一个。可以是完整地址（spam@example.com），也可以是整个域名（@example.com）。这些发件人的邮件会被直接拒收。</p>
          <textarea className="textarea mono" rows={5} value={blocked} onChange={(e) => setBlocked(e.target.value)} placeholder={"spam@example.com\n@ads.example.net"} />
          <div className="row" style={{ justifyContent: "flex-end" }}>
            <button className="btn btn-sm" disabled={busy || blocked === settings.blocked_senders} onClick={() => save({ blocked_senders: blocked })}>
              保存黑名单
            </button>
          </div>
        </div>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- account

function AccountTab() {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const notify = useToast();
  const { busy, run } = useAsync();
  return (
    <div className="card">
      <div className="card-head">
        <h4>修改管理员密码</h4>
      </div>
      <form
        className="card-body"
        onSubmit={async (e) => {
          e.preventDefault();
          if (next !== again) return notify("两次输入的新密码不一致", "error");
          if (await run(() => api.changePassword(current, next), "密码已修改，其它设备已退出登录")) {
            setCurrent("");
            setNext("");
            setAgain("");
          }
        }}
      >
        <div className="field">
          <label>当前密码</label>
          <input className="input" type="password" autoComplete="current-password" value={current} onChange={(e) => setCurrent(e.target.value)} />
        </div>
        <div className="field">
          <label>新密码</label>
          <input className="input" type="password" autoComplete="new-password" value={next} onChange={(e) => setNext(e.target.value)} placeholder="至少 8 位" />
        </div>
        <div className="field">
          <label>确认新密码</label>
          <input className="input" type="password" autoComplete="new-password" value={again} onChange={(e) => setAgain(e.target.value)} />
        </div>
        <div className="row" style={{ justifyContent: "flex-end" }}>
          <button className="btn btn-primary" disabled={busy || !current || next.length < 8}>
            {busy && <Spinner size={16} />} 修改密码
          </button>
        </div>
      </form>
    </div>
  );
}
