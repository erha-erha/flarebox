import {
  Archive,
  ArrowDownAZ,
  EyeOff,
  Globe,
  Inbox,
  LogOut,
  Mail,
  MailOpen,
  Palette,
  Plus,
  Send,
  Settings,
  SquarePen,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { useState } from "react";
import type { Bootstrap, Mailbox, View } from "../api";
import { avatarStyle } from "../utils";
import { LogoMark } from "./ui";

const DAY_MS = 24 * 3600 * 1000;

/** useState that remembers its value in this browser (per-viewer view preferences). */
function useStoredState<T>(key: string, initial: T): [T, (value: T) => void] {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw === null ? initial : (JSON.parse(raw) as T);
    } catch {
      return initial;
    }
  });
  const set = (next: T) => {
    setValue(next);
    try {
      localStorage.setItem(key, JSON.stringify(next));
    } catch {
      /* storage unavailable */
    }
  };
  return [value, set];
}

const mailboxLabel = (m: Mailbox) => m.display_name || m.address.split("@")[0];

/** A–Z bucket for a mailbox; digits, symbols and non-Latin names share "#". */
function letterOf(m: Mailbox): string {
  const c = mailboxLabel(m).charAt(0).toUpperCase();
  return c >= "A" && c <= "Z" ? c : "#";
}

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

  const [groupByLetter, setGroupByLetter] = useStoredState("fb-mbx-az", false);
  const [hideInactive, setHideInactive] = useStoredState("fb-mbx-hide-inactive", false);
  const [inactiveDays, setInactiveDays] = useStoredState("fb-mbx-inactive-days", 30);
  const [daysDraft, setDaysDraft] = useState(String(inactiveDays));
  const [openLetter, setOpenLetter] = useState<string | null>(null);

  const unreadByMailbox = new Map<number, number>();
  const lastActivity = new Map<number, number>();
  for (const c of data.counts) {
    if (c.folder === "inbox") unreadByMailbox.set(c.mailbox_id, (unreadByMailbox.get(c.mailbox_id) ?? 0) + c.unread);
    lastActivity.set(c.mailbox_id, Math.max(lastActivity.get(c.mailbox_id) ?? 0, c.last_at ?? 0));
  }

  // Inactive: no mail in or out for `inactiveDays` (a mailbox that never had mail counts from its creation).
  // The mailbox being viewed always stays visible.
  const cutoff = Date.now() - inactiveDays * DAY_MS;
  const visible = hideInactive
    ? data.mailboxes.filter((m) => m.id === mailbox || (lastActivity.get(m.id) ?? m.created_at ?? 0) >= cutoff)
    : data.mailboxes;
  const hiddenCount = data.mailboxes.length - visible.length;
  const multiDomain = new Set(data.mailboxes.map((m) => m.address.split("@")[1])).size > 1;

  const byDomain = new Map<string, Mailbox[]>();
  for (const m of visible) {
    const d = m.address.split("@")[1];
    byDomain.set(d, [...(byDomain.get(d) ?? []), m]);
  }
  const byLetter = new Map<string, Mailbox[]>();
  for (const m of [...visible].sort((a, b) => mailboxLabel(a).localeCompare(mailboxLabel(b)) || a.address.localeCompare(b.address))) {
    const l = letterOf(m);
    byLetter.set(l, [...(byLetter.get(l) ?? []), m]);
  }
  const letters = [...byLetter.keys()].sort((a, b) => (a === "#" ? 1 : b === "#" ? -1 : a.localeCompare(b)));

  const changeDays = (value: string) => {
    setDaysDraft(value);
    const n = Math.floor(Number(value));
    if (n >= 1) setInactiveDays(Math.min(n, 3650));
  };

  const mailboxItem = (m: Mailbox, showDomain: boolean) => {
    const unread = unreadByMailbox.get(m.id) ?? 0;
    return (
      <button
        key={m.id}
        className={`nav-item${mailbox === m.id ? " active" : ""}`}
        onClick={() => onSelect(view, m.id)}
        title={m.address}
      >
        <span className="mbx-dot" style={{ background: avatarStyle(m.address).background }} />
        <span className="label">
          {mailboxLabel(m)}
          {showDomain && <span className="mbx-domain">@{m.address.split("@")[1]}</span>}
        </span>
        {unread > 0 && <span className="count subtle">{unread}</span>}
      </button>
    );
  };

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
          <span className="nav-section-tools">
            <button
              className={`icon-btn${groupByLetter ? " on" : ""}`}
              onClick={() => setGroupByLetter(!groupByLetter)}
              title={groupByLetter ? "按字母分组：已开启" : "按字母分组（邮箱多时更好找）"}
              aria-label="按字母分组"
              aria-pressed={groupByLetter}
            >
              <ArrowDownAZ />
            </button>
            <button
              className={`icon-btn${hideInactive ? " on" : ""}`}
              onClick={() => setHideInactive(!hideInactive)}
              title={hideInactive ? "隐藏不活跃邮箱：已开启" : "隐藏不活跃邮箱"}
              aria-label="隐藏不活跃邮箱"
              aria-pressed={hideInactive}
            >
              <EyeOff />
            </button>
            <button className="icon-btn" onClick={onNewMailbox} title="新建邮箱" aria-label="新建邮箱">
              <Plus />
            </button>
          </span>
        </div>
        {hideInactive && (
          <div className="mbx-filter">
            <span className="nowrap">
              <input
                type="number"
                min={1}
                max={3650}
                value={daysDraft}
                onChange={(e) => changeDays(e.target.value)}
                onBlur={() => setDaysDraft(String(inactiveDays))}
                aria-label="不活跃天数"
              />
              天无往来算不活跃
            </span>
            {hiddenCount > 0 && <span className="muted nowrap">已隐藏 {hiddenCount} 个</span>}
          </div>
        )}
        <nav className="nav">
          <button
            className={`nav-item${mailbox === "all" ? " active" : ""}`}
            onClick={() => onSelect(view, "all")}
          >
            <Mail />
            <span className="label">全部邮箱</span>
            {groupByLetter && visible.length > 0 && <span className="count subtle">{visible.length}</span>}
          </button>
          {groupByLetter ? (
            <>
              <div className="az-grid">
                {letters.map((l) => {
                  const boxes = byLetter.get(l) ?? [];
                  const unread = boxes.some((m) => (unreadByMailbox.get(m.id) ?? 0) > 0);
                  const current = boxes.some((m) => m.id === mailbox);
                  return (
                    <button
                      key={l}
                      className={`az-chip${openLetter === l ? " open" : ""}${current ? " current" : ""}`}
                      onClick={() => setOpenLetter(openLetter === l ? null : l)}
                      title={`${l} 开头：${boxes.length} 个邮箱`}
                      aria-expanded={openLetter === l}
                    >
                      <span className="az-letter">{l}</span>
                      <span className="az-count">{boxes.length}</span>
                      {unread && <span className="az-unread" />}
                    </button>
                  );
                })}
              </div>
              {openLetter && byLetter.has(openLetter) && (
                <div className="az-list">{byLetter.get(openLetter)!.map((m) => mailboxItem(m, multiDomain))}</div>
              )}
            </>
          ) : (
            [...byDomain.entries()].map(([domain, boxes]) => (
              <div key={domain}>
                <div className="nav-domain">
                  <Globe /> {domain}
                </div>
                {boxes.map((m) => mailboxItem(m, false))}
              </div>
            ))
          )}
          {data.mailboxes.length > 0 && visible.length === 0 && (
            <div className="muted" style={{ fontSize: 12.5, padding: "6px 12px" }}>
              没有活跃的邮箱，{hiddenCount} 个不活跃的已隐藏
            </div>
          )}
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
