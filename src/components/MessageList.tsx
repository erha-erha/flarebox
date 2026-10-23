import {
  Archive,
  ArchiveRestore,
  Check,
  Inbox,
  Mail,
  MailOpen,
  Menu,
  Paperclip,
  RefreshCw,
  Search,
  Star,
  Trash2,
  Undo2,
  X,
} from "lucide-react";
import { forwardRef, useEffect, useRef, useState } from "react";
import type { Mailbox, MessageSummary, View } from "../api";
import { displayName, formatListTime, parseAddresses } from "../utils";
import { Avatar, Spinner } from "./ui";

export type MessageAction = "read" | "unread" | "star" | "unstar" | "archive" | "inbox" | "trash" | "restore" | "delete";

const EMPTY_TEXT: Record<View, [string, string]> = {
  inbox: ["收件箱是空的", "新邮件到达后会出现在这里。"],
  unread: ["全部已读", "没有未读邮件，干得漂亮。"],
  starred: ["还没有星标邮件", "给重要的邮件加星标，方便以后找到。"],
  sent: ["还没有发送过邮件", "点击「写邮件」发出第一封吧。"],
  archive: ["归档是空的", "归档的邮件会离开收件箱，但随时可以在这里找到。"],
  trash: ["回收站是空的", "删除的邮件会在这里保留 30 天。"],
};

interface Props {
  title: string;
  subtitle: string;
  view: View;
  messages: MessageSummary[];
  loading: boolean;
  more: boolean;
  onLoadMore: () => void;
  selectedId: string | null;
  onOpen: (m: MessageSummary) => void;
  checked: Set<string>;
  onCheck: (ids: Set<string>) => void;
  query: string;
  onQuery: (q: string) => void;
  onRefresh: () => void;
  refreshing: boolean;
  onAction: (ids: string[], action: MessageAction) => void;
  onEmptyTrash: () => void;
  mailboxes: Map<number, Mailbox>;
  showMailbox: boolean;
  onMenu: () => void;
}

export const MessageList = forwardRef<HTMLInputElement, Props>(function MessageList(p, searchRef) {
  const [q, setQ] = useState(p.query);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => setQ(p.query), [p.query]);

  const changeQuery = (v: string) => {
    setQ(v);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => p.onQuery(v.trim()), 300);
  };

  const toggle = (id: string) => {
    const next = new Set(p.checked);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    p.onCheck(next);
  };

  const ids = [...p.checked];
  const selecting = ids.length > 0;
  const allRead = p.messages.filter((m) => p.checked.has(m.id)).every((m) => m.is_read);

  return (
    <section className="list-pane">
      <div className="list-head">
        <div className="list-title">
          <button className="icon-btn only-narrow" onClick={p.onMenu} aria-label="菜单">
            <Menu />
          </button>
          <h2>
            {p.title}
            <span className="sub">{p.subtitle}</span>
          </h2>
          {p.view === "trash" && p.messages.length > 0 && (
            <button className="btn btn-sm btn-danger" onClick={p.onEmptyTrash}>
              清空
            </button>
          )}
          <button className="icon-btn" onClick={p.onRefresh} title="刷新" aria-label="刷新">
            {p.refreshing ? <Spinner /> : <RefreshCw />}
          </button>
        </div>
        <div className="search">
          <Search />
          <input
            ref={searchRef}
            className="input"
            placeholder="搜索发件人、主题、内容"
            value={q}
            onChange={(e) => changeQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                changeQuery("");
                (e.target as HTMLInputElement).blur();
              }
            }}
          />
          {!q && <kbd>/</kbd>}
          {q && (
            <button
              className="icon-btn sm"
              style={{ position: "absolute", right: 4, top: 4 }}
              onClick={() => changeQuery("")}
              aria-label="清除搜索"
            >
              <X />
            </button>
          )}
        </div>
      </div>

      {selecting && (
        <div className="bulkbar">
          <button className="icon-btn sm" onClick={() => p.onCheck(new Set())} title="取消选择" aria-label="取消选择">
            <X />
          </button>
          <span>已选 {ids.length} 封</span>
          <button
            className="btn btn-ghost btn-sm"
            onClick={() => p.onCheck(new Set(p.messages.map((m) => m.id)))}
            style={{ color: "inherit" }}
          >
            全选
          </button>
          <span className="spacer" />
          <button
            className="icon-btn sm"
            title={allRead ? "标为未读" : "标为已读"}
            onClick={() => p.onAction(ids, allRead ? "unread" : "read")}
          >
            {allRead ? <Mail /> : <MailOpen />}
          </button>
          {p.view !== "trash" && (
            <button className="icon-btn sm" title="加星标" onClick={() => p.onAction(ids, "star")}>
              <Star />
            </button>
          )}
          {p.view === "archive" || p.view === "trash" ? (
            <button
              className="icon-btn sm"
              title={p.view === "trash" ? "恢复" : "移回收件箱"}
              onClick={() => p.onAction(ids, p.view === "trash" ? "restore" : "inbox")}
            >
              {p.view === "trash" ? <Undo2 /> : <ArchiveRestore />}
            </button>
          ) : (
            p.view !== "sent" && (
              <button className="icon-btn sm" title="归档" onClick={() => p.onAction(ids, "archive")}>
                <Archive />
              </button>
            )
          )}
          <button
            className="icon-btn sm"
            title={p.view === "trash" ? "永久删除" : "删除"}
            onClick={() => p.onAction(ids, p.view === "trash" ? "delete" : "trash")}
          >
            <Trash2 />
          </button>
        </div>
      )}

      <div className={`msg-list scroll${selecting ? " selecting" : ""}`}>
        {p.loading && p.messages.length === 0 ? (
          Array.from({ length: 7 }, (_, i) => (
            <div className="skeleton" key={i}>
              <i className="circle" />
              <div>
                <i style={{ width: "45%" }} />
                <i style={{ width: "80%" }} />
                <i style={{ width: "65%" }} />
              </div>
            </div>
          ))
        ) : p.messages.length === 0 ? (
          <div className="empty">
            <div className="empty-icon">{p.query ? <Search /> : <Inbox />}</div>
            <h3>{p.query ? "没有找到匹配的邮件" : EMPTY_TEXT[p.view][0]}</h3>
            <p>{p.query ? `换个关键词试试，或者检查拼写。` : EMPTY_TEXT[p.view][1]}</p>
          </div>
        ) : (
          <>
            {p.messages.map((m) => {
              const outgoing = m.folder === "sent";
              const to = parseAddresses(m.to_json);
              const who = outgoing
                ? `发给 ${to.map((a) => displayName(a.name, a.address)).join("、") || "（无收件人）"}`
                : displayName(m.from_name, m.from_addr);
              const seed = outgoing ? (to[0]?.address ?? "") : m.from_addr;
              const box = p.mailboxes.get(m.mailbox_id);
              const checked = p.checked.has(m.id);
              return (
                <div
                  key={m.id}
                  className={`msg-item${m.is_read ? "" : " unread"}${p.selectedId === m.id ? " selected" : ""}`}
                  onClick={(e) => {
                    if (e.metaKey || e.ctrlKey || e.shiftKey || selecting) toggle(m.id);
                    else p.onOpen(m);
                  }}
                >
                  <div className="avatar-wrap">
                    <Avatar name={outgoing ? (to[0]?.name || to[0]?.address || "?") : m.from_name || m.from_addr} seed={seed} />
                    <button
                      className={`msg-check${checked ? " checked" : ""}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggle(m.id);
                      }}
                      aria-label="选择"
                    >
                      {checked && <Check strokeWidth={3} />}
                    </button>
                  </div>
                  <div className="msg-body">
                    <div className="msg-row1">
                      <span className="msg-from">{who}</span>
                      <span className="msg-time">{formatListTime(m.created_at)}</span>
                    </div>
                    <div className="msg-subject">
                      <span>{m.subject || "（无主题）"}</span>
                    </div>
                    <div className="msg-snippet">{m.snippet || "（无内容）"}</div>
                    {(m.has_attachments || m.is_starred || (p.showMailbox && box)) && (
                      <div className="msg-meta">
                        {!!m.is_starred && <Star className="star" />}
                        {!!m.has_attachments && <Paperclip />}
                        {p.showMailbox && box && <span className="chip">{box.address}</span>}
                      </div>
                    )}
                  </div>
                  {!selecting && (
                    <div className="msg-actions" onClick={(e) => e.stopPropagation()}>
                      {m.folder === "trash" ? (
                        <button className="icon-btn sm" title="恢复" onClick={() => p.onAction([m.id], "restore")}>
                          <Undo2 />
                        </button>
                      ) : m.folder === "archive" ? (
                        <button className="icon-btn sm" title="移回收件箱" onClick={() => p.onAction([m.id], "inbox")}>
                          <ArchiveRestore />
                        </button>
                      ) : (
                        m.folder !== "sent" && (
                          <button className="icon-btn sm" title="归档" onClick={() => p.onAction([m.id], "archive")}>
                            <Archive />
                          </button>
                        )
                      )}
                      <button
                        className="icon-btn sm"
                        title={m.is_read ? "标为未读" : "标为已读"}
                        onClick={() => p.onAction([m.id], m.is_read ? "unread" : "read")}
                      >
                        {m.is_read ? <Mail /> : <MailOpen />}
                      </button>
                      <button
                        className="icon-btn sm"
                        title={m.folder === "trash" ? "永久删除" : "删除"}
                        onClick={() => p.onAction([m.id], m.folder === "trash" ? "delete" : "trash")}
                      >
                        <Trash2 />
                      </button>
                    </div>
                  )}
                </div>
              );
            })}
            {p.more && (
              <div className="list-foot">
                <button className="btn btn-sm" onClick={p.onLoadMore} disabled={p.loading}>
                  {p.loading ? <Spinner size={14} /> : null}加载更多
                </button>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
});
