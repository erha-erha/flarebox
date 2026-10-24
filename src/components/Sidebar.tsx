import { Archive, Globe, Inbox, LogOut, Mail, MailOpen, Palette, Plus, Send, Settings, SquarePen, Star, Trash2, X } from "lucide-react";
import type { Bootstrap, View } from "../api";
import { avatarStyle } from "../utils";
import { LogoMark } from "./ui";

const NAV: { view: View; label: string; icon: typeof Inbox }[] = [
  { view: "inbox", label: "收件箱", icon: Inbox },
  { view: "unread", label: "未读", icon: MailOpen },
  { view: "starred", label: "星标", icon: Star },
  { view: "sent", label: "已发送", icon: Send },
  { view: "archive", label: "归档", icon: Archive },
  { view: "trash", label: "回收站", icon: Trash2 },
];

export function Sidebar({
  data,
  view,
  mailbox,
  onSelect,
  onCompose,
  onSettings,
  onNewMailbox,
  onLogout,
  onClose,
  appearanceOpen,
  onAppearance,
}: {
  data: Bootstrap;
  view: View;
  mailbox: number | "all";
  onSelect: (view: View, mailbox: number | "all") => void;
  onCompose: () => void;
  onSettings: () => void;
  onNewMailbox: () => void;
  onLogout: () => void;
  onClose: () => void;
  appearanceOpen: boolean;
  onAppearance: () => void;
}) {
  const scoped = data.counts.filter((c) => mailbox === "all" || c.mailbox_id === mailbox);
  const inboxUnread = scoped.filter((c) => c.folder === "inbox").reduce((n, c) => n + c.unread, 0);
  const unreadAll = scoped.filter((c) => c.folder === "inbox" || c.folder === "archive").reduce((n, c) => n + c.unread, 0);
  const starred = scoped.filter((c) => c.folder !== "trash").reduce((n, c) => n + (c.starred ?? 0), 0);
  const trash = scoped.filter((c) => c.folder === "trash").reduce((n, c) => n + c.total, 0);
  const badge = (v: View) =>
    v === "inbox" && inboxUnread ? (
      <span className="count">{inboxUnread > 999 ? "999+" : inboxUnread}</span>
    ) : v === "unread" && unreadAll ? (
      <span className="count subtle">{unreadAll}</span>
    ) : v === "starred" && starred ? (
      <span className="count subtle">{starred}</span>
    ) : v === "trash" && trash ? (
      <span className="count subtle">{trash}</span>
    ) : null;

  const unreadByMailbox = new Map<number, number>();
  for (const c of data.counts) {
    if (c.folder === "inbox") unreadByMailbox.set(c.mailbox_id, (unreadByMailbox.get(c.mailbox_id) ?? 0) + c.unread);
  }
  const byDomain = new Map<string, typeof data.mailboxes>();
  for (const m of data.mailboxes) {
    const d = m.address.split("@")[1];
    byDomain.set(d, [...(byDomain.get(d) ?? []), m]);
  }

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="logo">
          <LogoMark />
          FlareBox
        </div>
        <button className="icon-btn sm only-narrow" onClick={onClose} aria-label="关闭菜单">
          <X />
        </button>
      </div>

      <button className="btn btn-primary compose-btn" onClick={onCompose}>
        <SquarePen /> 写邮件
      </button>

      <div className="scroll" style={{ flex: 1, minHeight: 0, margin: "0 -4px", padding: "0 4px" }}>
        <nav className="nav">
          {NAV.map(({ view: v, label, icon: Icon }) => (
            <button
              key={v}
              className={`nav-item${view === v ? " active" : ""}`}
              onClick={() => onSelect(v, mailbox)}
            >
              <Icon />
              <span className="label">{label}</span>
              {badge(v)}
            </button>
          ))}
        </nav>

        <div className="nav-section">
          <span>邮箱</span>
          <button className="icon-btn" onClick={onNewMailbox} title="新建邮箱" aria-label="新建邮箱">
            <Plus />
          </button>
        </div>
        <nav className="nav">
          <button
            className={`nav-item${mailbox === "all" ? " active" : ""}`}
            onClick={() => onSelect(view, "all")}
          >
            <Mail />
            <span className="label">全部邮箱</span>
          </button>
          {[...byDomain.entries()].map(([domain, boxes]) => (
            <div key={domain}>
              <div className="nav-domain">
                <Globe /> {domain}
              </div>
              {boxes.map((m) => {
                const unread = unreadByMailbox.get(m.id) ?? 0;
                return (
                  <button
                    key={m.id}
                    className={`nav-item${mailbox === m.id ? " active" : ""}`}
                    onClick={() => onSelect(view, m.id)}
                    title={m.address}
                  >
                    <span className="mbx-dot" style={{ background: avatarStyle(m.address).background }} />
                    <span className="label">{m.display_name || m.address.split("@")[0]}</span>
                    {unread > 0 && <span className="count subtle">{unread}</span>}
                  </button>
                );
              })}
            </div>
          ))}
          {data.mailboxes.length === 0 && (
            <div className="muted" style={{ fontSize: 12.5, padding: "6px 12px" }}>
              {data.domains.length ? "收到邮件后会自动出现在这里" : "接入域名后即可创建邮箱"}
            </div>
          )}
        </nav>
      </div>

      <div className="sidebar-foot">
        <button className="nav-item" onClick={onSettings}>
          <Settings />
          <span className="label">设置</span>
        </button>
        <button
          className={`nav-item appearance-toggle${appearanceOpen ? " active" : ""}`}
          onClick={onAppearance}
          aria-expanded={appearanceOpen}
          title="外观：主题与背景图片"
        >
          <Palette />
          <span className="label">外观</span>
        </button>
        <button className="icon-btn" onClick={onLogout} title="退出登录" aria-label="退出登录">
          <LogOut />
        </button>
      </div>
    </aside>
  );
}
