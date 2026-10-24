import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, type Attachment, type Bootstrap, type Mailbox, type MessageDetail, type MessageSummary, type View } from "../api";
import { displayName, formatFullTime, parseAddresses, quoteHeader, textToHtml } from "../utils";
import { AppearancePanel, useAppearance, Wallpaper, type Theme } from "./Appearance";
import { Composer, type Draft } from "./Composer";
import { MessageList, type MessageAction } from "./MessageList";
import { NewMailboxModal } from "./NewMailbox";
import { Reader, type ReplyMode } from "./Reader";
import { SettingsPanel, type SettingsTab } from "./Settings";
import { Sidebar } from "./Sidebar";
import { Modal, Spinner, useConfirm, useToast } from "./ui";
import { NothingSelected, Welcome } from "./Welcome";

const VIEW_TITLES: Record<View, string> = {
  inbox: "收件箱",
  unread: "未读",
  starred: "星标邮件",
  sent: "已发送",
  archive: "归档",
  trash: "回收站",
};
const POLL_MS = 30_000;

function useTheme(): [Theme, (t: Theme) => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    try {
      return (localStorage.getItem("fb-theme") as Theme) || "auto";
    } catch {
      return "auto";
    }
  });
  useEffect(() => {
    const root = document.documentElement;
    if (theme === "auto") delete root.dataset.theme;
    else root.dataset.theme = theme;
    try {
      localStorage.setItem("fb-theme", theme);
    } catch {
      /* storage unavailable */
    }
  }, [theme]);
  return [theme, setTheme];
}

/** Whether a message leaves the current view after an action. */
function leavesView(action: MessageAction, view: View): boolean {
  switch (action) {
    case "archive":
      return view === "inbox";
    case "inbox":
      return view === "archive" || view === "trash";
    case "trash":
      return view !== "trash";
    case "restore":
      return view === "trash";
    case "delete":
      return true;
    case "unstar":
      return view === "starred";
    default:
      return false;
  }
}

export function MailApp({ onLogout }: { onLogout: () => void }) {
  const notify = useToast();
  const confirm = useConfirm();
  const [theme, setTheme] = useTheme();
  const appearance = useAppearance();
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  const [data, setData] = useState<Bootstrap | null>(null);
  const [view, setView] = useState<View>("inbox");
  const [mailbox, setMailbox] = useState<number | "all">("all");
  const [query, setQuery] = useState("");
  const [messages, setMessages] = useState<MessageSummary[]>([]);
  const [more, setMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [draft, setDraft] = useState<Draft | null>(null);
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const [newMailbox, setNewMailbox] = useState(false);
  const [drawer, setDrawer] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);
  const messagesRef = useRef(messages);
  messagesRef.current = messages;
  const detailRef = useRef<{ message: MessageDetail; attachments: Attachment[] } | null>(null);
  const listReq = useRef(0);
  const lastInboxTotal = useRef<number | null>(null);

  const mailboxMap = useMemo(() => new Map<number, Mailbox>((data?.mailboxes ?? []).map((m) => [m.id, m])), [data]);

  // ------------------------------------------------------------ loading

  const loadBootstrap = useCallback(async () => {
    try {
      const b = await api.bootstrap();
      setData(b);
      const inboxTotal = b.counts.filter((c) => c.folder === "inbox").reduce((n, c) => n + c.total, 0);
      if (lastInboxTotal.current !== null && inboxTotal > lastInboxTotal.current) {
        notify(`收到 ${inboxTotal - lastInboxTotal.current} 封新邮件`, "info");
      }
      lastInboxTotal.current = inboxTotal;
      const unread = b.counts.filter((c) => c.folder === "inbox").reduce((n, c) => n + c.unread, 0);
      document.title = unread ? `(${unread}) FlareBox 邮箱` : "FlareBox 邮箱";
    } catch (e) {
      notify((e as Error).message, "error");
    }
  }, [notify]);

  const fetchList = useCallback(
    async (mode: "replace" | "append" | "merge" = "replace") => {
      const req = ++listReq.current;
      if (mode !== "merge") setLoading(true);
      try {
        const before = mode === "append" ? messagesRef.current.at(-1)?.id : undefined;
        const r = await api.messages({ folder: view, mailbox, q: query, before });
        if (req !== listReq.current) return;
        if (mode === "append") {
          setMessages((prev) => [...prev, ...r.messages]);
          setMore(r.more);
        } else if (mode === "merge") {
          // Keep pages the user already loaded; refresh the first page in place.
          setMessages((prev) => {
            const fresh = new Set(r.messages.map((m) => m.id));
            const oldest = r.messages.at(-1)?.id;
            const rest = prev.filter((m) => !fresh.has(m.id) && (!oldest || m.id < oldest));
            if (!rest.length) setMore(r.more);
            return [...r.messages, ...rest];
          });
        } else {
          setMessages(r.messages);
          setMore(r.more);
        }
      } catch (e) {
        if (req === listReq.current) notify((e as Error).message, "error");
      } finally {
        if (req === listReq.current) setLoading(false);
      }
    },
    [view, mailbox, query, notify],
  );

  useEffect(() => {
    loadBootstrap();
  }, [loadBootstrap]);

  useEffect(() => {
    setChecked(new Set());
    setMessages([]);
    fetchList("replace");
  }, [fetchList]);

  const refresh = useCallback(
    async (silent = false) => {
      if (!silent) setRefreshing(true);
      await Promise.all([loadBootstrap(), fetchList("merge")]);
      setRefreshing(false);
    },
    [loadBootstrap, fetchList],
  );

  useEffect(() => {
    const tick = () => document.visibilityState === "visible" && refresh(true);
    const id = setInterval(tick, POLL_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [refresh]);

  // ------------------------------------------------------------ actions

  const selectView = (v: View, m: number | "all") => {
    setView(v);
    setMailbox(m);
    setSelected(null);
    setDrawer(false);
  };

  const open = (m: MessageSummary) => {
    setSelected(m.id);
    if (!m.is_read) setMessages((list) => list.map((x) => (x.id === m.id ? { ...x, is_read: 1 } : x)));
  };

  const doAction = useCallback(
    async (ids: string[], action: MessageAction, opts: { silent?: boolean } = {}) => {
      if (!ids.length) return;
      if (action === "delete") {
        const ok = await confirm({
          title: ids.length > 1 ? `永久删除 ${ids.length} 封邮件？` : "永久删除这封邮件？",
          body: "邮件和附件将被彻底删除，无法恢复。",
          confirm: "永久删除",
          danger: true,
        });
        if (!ok) return;
      }
      const leaving = leavesView(action, view);
      const list = messagesRef.current;
      if (leaving) {
        if (selected && ids.includes(selected)) {
          const idx = list.findIndex((m) => m.id === selected);
          const next = list.slice(idx + 1).find((m) => !ids.includes(m.id)) ?? list.slice(0, idx).reverse().find((m) => !ids.includes(m.id));
          setSelected(window.innerWidth > 760 && next ? next.id : null);
        }
        setMessages(list.filter((m) => !ids.includes(m.id)));
      } else {
        const patch: Partial<MessageSummary> =
          action === "read" ? { is_read: 1 } : action === "unread" ? { is_read: 0 } : action === "star" ? { is_starred: 1 } : action === "unstar" ? { is_starred: 0 } : {};
        setMessages(list.map((m) => (ids.includes(m.id) ? { ...m, ...patch } : m)));
        if (action === "unread" && selected && ids.includes(selected)) setSelected(null);
      }
      setChecked(new Set());
      try {
        await api.batch(ids, action);
        if (!opts.silent && (action === "archive" || action === "trash")) {
          const n = ids.length;
          notify(action === "archive" ? `已归档 ${n} 封邮件` : `已移到回收站`, "success", {
            label: "撤销",
            run: async () => {
              await api.batch(ids, "restore");
              refresh(true);
            },
          });
        }
        if (action === "delete") notify("已永久删除", "success");
      } catch (e) {
        notify((e as Error).message, "error");
        fetchList("replace");
      }
      loadBootstrap();
    },
    [confirm, view, selected, notify, refresh, fetchList, loadBootstrap],
  );

  const emptyTrash = async () => {
    const ok = await confirm({ title: "清空回收站？", body: "回收站中的所有邮件都会被永久删除。", confirm: "清空", danger: true });
    if (!ok) return;
    try {
      const r = await api.emptyTrash();
      notify(`已删除 ${r.deleted} 封邮件`, "success");
      setSelected(null);
      refresh(true);
      fetchList("replace");
    } catch (e) {
      notify((e as Error).message, "error");
    }
  };

  // ------------------------------------------------------------ compose

  const signatureHtml = () => (data?.settings.signature ? `<br><div>-- <br>${textToHtml(data.settings.signature)}</div>` : "");

  const compose = useCallback(() => {
    if (!data) return;
    const from = mailbox !== "all" ? (mailboxMap.get(mailbox)?.address ?? "") : (data.mailboxes[0]?.address ?? "");
    setDraft({ key: Date.now(), title: "新邮件", from, to: [], cc: [], bcc: [], subject: "", html: `<div><br></div>${signatureHtml()}` });
    setDrawer(false);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data, mailbox, mailboxMap]);

  const reply = useCallback(
    (mode: ReplyMode, m: MessageDetail, attachments: Attachment[]) => {
      const box = mailboxMap.get(m.mailbox_id);
      const me = box?.address ?? "";
      const outgoing = m.folder === "sent";
      const to = parseAddresses(m.to_json).map((a) => a.address.toLowerCase());
      const cc = parseAddresses(m.cc_json).map((a) => a.address.toLowerCase());
      const fromLabel = `${displayName(m.from_name, m.from_addr)} <${m.from_addr}>`;
      const body = textToHtml(m.text_body ?? "");
      if (mode === "forward") {
        const header = [
          "---------- 转发的邮件 ----------",
          `发件人：${fromLabel}`,
          `日期：${formatFullTime(m.created_at)}`,
          `主题：${m.subject}`,
          `收件人：${to.join(", ")}`,
        ]
          .map((l) => textToHtml(l))
          .join("<br>");
        setDraft({
          key: Date.now(),
          title: "转发",
          from: me,
          to: [],
          cc: [],
          bcc: [],
          subject: /^(fwd?|转发)[:：]/i.test(m.subject) ? m.subject : `Fwd: ${m.subject}`,
          html: `<div><br></div>${signatureHtml()}<br><div>${header}</div><br><div>${body}</div>`,
          forwardAttachments: attachments.filter((a) => !a.inline).map((a) => ({ id: a.id, filename: a.filename, size: a.size })),
        });
        return;
      }
      const primary = outgoing ? to : [m.reply_to || m.from_addr];
      const others = mode === "replyAll" ? [...to, ...cc].filter((a) => a !== me && !primary.includes(a)) : [];
      setDraft({
        key: Date.now(),
        title: mode === "replyAll" ? "全部回复" : "回复",
        from: me,
        to: primary,
        cc: others,
        bcc: [],
        subject: /^(re|回复)[:：]/i.test(m.subject) ? m.subject : `Re: ${m.subject}`,
        html: `<div><br></div>${signatureHtml()}<br><div>${quoteHeader(fromLabel, m.created_at)}</div><blockquote>${body}</blockquote>`,
        replyToId: m.id,
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mailboxMap, data],
  );

  // ------------------------------------------------------------ keyboard

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement;
      if (e.metaKey || e.ctrlKey || e.altKey) return;
      if (target.closest("input, textarea, select, [contenteditable='true']")) return;
      if (document.querySelector(".overlay, .appearance")) return;
      const list = messagesRef.current;
      const idx = list.findIndex((m) => m.id === selected);
      const detail = detailRef.current?.message.id === selected ? detailRef.current : null;
      switch (e.key) {
        case "c":
          compose();
          break;
        case "/":
          e.preventDefault();
          searchRef.current?.focus();
          break;
        case "j":
        case "ArrowDown": {
          const next = list[idx + 1] ?? (idx === -1 ? list[0] : undefined);
          if (next) open(next);
          break;
        }
        case "k":
        case "ArrowUp": {
          const prev = list[idx - 1];
          if (prev) open(prev);
          break;
        }
        case "e":
          if (selected) doAction([selected], view === "archive" ? "inbox" : "archive");
          break;
        case "#":
        case "Delete":
          if (selected) doAction([selected], view === "trash" ? "delete" : "trash");
          break;
        case "s": {
          const m = list[idx];
          if (m) doAction([m.id], m.is_starred ? "unstar" : "star");
          break;
        }
        case "u":
          if (selected) doAction([selected], "unread");
          break;
        case "r":
          if (detail) reply("reply", detail.message, detail.attachments);
          break;
        case "a":
          if (detail) reply("replyAll", detail.message, detail.attachments);
          break;
        case "f":
          if (detail) reply("forward", detail.message, detail.attachments);
          break;
        case "Escape":
          setSelected(null);
          break;
        default:
          return;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ------------------------------------------------------------ render

  if (!data) {
    return (
      <div className="auth">
        <Spinner size={26} />
      </div>
    );
  }

  const currentBox = mailbox === "all" ? null : mailboxMap.get(mailbox);

  return (
    <div
      className={`app${drawer ? " drawer-open" : ""}${selected ? " reading" : ""}${appearance.src ? " has-wallpaper" : ""}`}
      style={appearance.style}
    >
      {appearance.src && <Wallpaper src={appearance.src} />}
      <div className="drawer-backdrop" onClick={() => setDrawer(false)} />
      <Sidebar
        data={data}
        view={view}
        mailbox={mailbox}
        onSelect={selectView}
        onCompose={compose}
        onSettings={() => (setSettingsTab(data.domains.length ? "mailboxes" : "domains"), setDrawer(false))}
        onNewMailbox={() => (data.domains.length ? setNewMailbox(true) : setSettingsTab("domains"))}
        onLogout={async () => {
          await api.logout().catch(() => {});
          onLogout();
        }}
        onClose={() => setDrawer(false)}
        appearanceOpen={appearanceOpen}
        onAppearance={() => setAppearanceOpen((o) => !o)}
      />

      {appearanceOpen && (
        <AppearancePanel theme={theme} onTheme={setTheme} state={appearance} onClose={() => setAppearanceOpen(false)} />
      )}

      <MessageList
        ref={searchRef}
        title={VIEW_TITLES[view]}
        subtitle={currentBox ? currentBox.address : data.mailboxes.length ? `全部 ${data.mailboxes.length} 个邮箱` : "全部邮箱"}
        view={view}
        messages={messages}
        loading={loading}
        more={more}
        onLoadMore={() => fetchList("append")}
        selectedId={selected}
        onOpen={open}
        checked={checked}
        onCheck={setChecked}
        query={query}
        onQuery={setQuery}
        onRefresh={() => refresh()}
        refreshing={refreshing}
        onAction={(ids, action) => doAction(ids, action)}
        onEmptyTrash={emptyTrash}
        mailboxes={mailboxMap}
        showMailbox={mailbox === "all" && data.mailboxes.length > 1}
        onMenu={() => setDrawer(true)}
      />

      <main className="reader-pane">
        {selected ? (
          <Reader
            key={selected}
            id={selected}
            mailboxes={mailboxMap}
            blockRemote={data.settings.block_remote_images}
            onAction={(ids, action) => doAction(ids, action)}
            onReply={reply}
            onBack={() => setSelected(null)}
            onLoaded={(message, attachments) => {
              detailRef.current = { message, attachments };
              loadBootstrap();
            }}
          />
        ) : data.domains.length === 0 ? (
          <Welcome data={data} onConnect={() => setSettingsTab("domains")} onCompose={compose} />
        ) : (
          <NothingSelected />
        )}
      </main>

      {draft && (
        <Composer
          key={draft.key}
          draft={draft}
          mailboxes={data.mailboxes}
          onClose={() => setDraft(null)}
          onSent={() => {
            setDraft(null);
            refresh(true);
            if (view === "sent") fetchList("replace");
          }}
        />
      )}

      {settingsTab && (
        <Modal wide bare onClose={() => setSettingsTab(null)}>
          <SettingsPanel
            data={data}
            tab={settingsTab}
            onTab={setSettingsTab}
            onClose={() => setSettingsTab(null)}
            onChanged={loadBootstrap}
            onNewMailbox={() => setNewMailbox(true)}
          />
        </Modal>
      )}

      {newMailbox && (
        <NewMailboxModal
          domains={data.domains}
          onClose={() => setNewMailbox(false)}
          onCreated={(m) => {
            setNewMailbox(false);
            loadBootstrap();
            selectView(view, m.id);
          }}
        />
      )}
    </div>
  );
}
