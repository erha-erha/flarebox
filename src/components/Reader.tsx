import {
  Archive,
  ArchiveRestore,
  ChevronLeft,
  Download,
  File,
  FileText,
  Forward,
  ImageOff,
  Mail,
  Reply,
  ReplyAll,
  Star,
  Trash2,
  Undo2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api, attachmentUrl, rawUrl, type Attachment, type Mailbox, type MessageDetail } from "../api";
import { displayName, formatFullTime, formatSize, linkify, escapeHtml, parseAddresses, prepareEmailHtml } from "../utils";
import type { MessageAction } from "./MessageList";
import { Avatar, Spinner } from "./ui";

export type ReplyMode = "reply" | "replyAll" | "forward";

export function Reader({
  id,
  mailboxes,
  blockRemote,
  onAction,
  onReply,
  onBack,
  onLoaded,
}: {
  id: string;
  mailboxes: Map<number, Mailbox>;
  blockRemote: boolean;
  onAction: (ids: string[], action: MessageAction) => void;
  onReply: (mode: ReplyMode, message: MessageDetail, attachments: Attachment[]) => void;
  onBack: () => void;
  onLoaded: (m: MessageDetail, attachments: Attachment[]) => void;
}) {
  const [data, setData] = useState<{ message: MessageDetail; attachments: Attachment[] } | null>(null);
  const [error, setError] = useState("");
  const [showRemote, setShowRemote] = useState(false);
  const onLoadedRef = useRef(onLoaded);
  onLoadedRef.current = onLoaded;

  useEffect(() => {
    let cancelled = false;
    setData(null);
    setError("");
    setShowRemote(false);
    api
      .message(id)
      .then((d) => {
        if (cancelled) return;
        setData(d);
        onLoadedRef.current(d.message, d.attachments);
      })
      .catch((e) => !cancelled && setError((e as Error).message));
    return () => {
      cancelled = true;
    };
  }, [id]);

  if (error) {
    return (
      <div className="empty">
        <div className="empty-icon">
          <Mail />
        </div>
        <h3>无法打开这封邮件</h3>
        <p>{error}</p>
      </div>
    );
  }
  if (!data) {
    return (
      <div className="empty">
        <Spinner size={24} />
      </div>
    );
  }

  const m = data.message;
  const outgoing = m.folder === "sent";
  const to = parseAddresses(m.to_json);
  const cc = parseAddresses(m.cc_json);
  const box = mailboxes.get(m.mailbox_id);
  const fmt = (list: { name: string; address: string }[]) =>
    list.map((a) => (box && a.address.toLowerCase() === box.address ? "我" : displayName(a.name, a.address))).join("、");
  const visibleAtts = data.attachments.filter((a) => !(a.inline && a.content_id && m.html_body?.includes(`cid:${a.content_id}`)));
  const act = (action: MessageAction) => onAction([m.id], action);

  return (
    <>
      <div className="reader-toolbar">
        <button className="icon-btn only-narrow" onClick={onBack} aria-label="返回">
          <ChevronLeft />
        </button>
        {m.folder === "trash" ? (
          <button className="icon-btn" title="恢复" onClick={() => act("restore")}>
            <Undo2 />
          </button>
        ) : m.folder === "archive" ? (
          <button className="icon-btn" title="移回收件箱" onClick={() => act("inbox")}>
            <ArchiveRestore />
          </button>
        ) : (
          !outgoing && (
            <button className="icon-btn" title="归档 (E)" onClick={() => act("archive")}>
              <Archive />
            </button>
          )
        )}
        <button
          className="icon-btn"
          title={m.folder === "trash" ? "永久删除" : "删除 (#)"}
          onClick={() => act(m.folder === "trash" ? "delete" : "trash")}
        >
          <Trash2 />
        </button>
        <button className="icon-btn" title="标为未读 (U)" onClick={() => act("unread")}>
          <Mail />
        </button>
        <span className="sep" />
        <button
          className={`icon-btn${m.is_starred ? " active" : ""}`}
          title={m.is_starred ? "取消星标" : "加星标 (S)"}
          onClick={() => {
            act(m.is_starred ? "unstar" : "star");
            setData({ ...data, message: { ...m, is_starred: m.is_starred ? 0 : 1 } });
          }}
        >
          <Star style={m.is_starred ? { fill: "#f5a524", color: "#f5a524" } : undefined} />
        </button>
        <span className="spacer" />
        <a className="icon-btn" href={rawUrl(m.id)} title="下载原始邮件 (.eml)" aria-label="下载原始邮件">
          <Download />
        </a>
        <button className="icon-btn" title="回复 (R)" onClick={() => onReply("reply", m, data.attachments)}>
          <Reply />
        </button>
        <button className="icon-btn" title="转发 (F)" onClick={() => onReply("forward", m, data.attachments)}>
          <Forward />
        </button>
      </div>

      <div className="reader-scroll scroll">
        <article className="reader">
          <h1>{m.subject || "（无主题）"}</h1>
          <div className="sender-card">
            <Avatar name={m.from_name || m.from_addr} seed={m.from_addr} size="lg" />
            <div className="sender-info">
              <div className="sender-name">
                {displayName(m.from_name, m.from_addr)}
                <span className="addr">&lt;{m.from_addr}&gt;</span>
              </div>
              <div className="sender-to">
                发给 {fmt(to) || "（无）"}
                {cc.length > 0 && <> · 抄送 {fmt(cc)}</>}
                {!outgoing && box && to.every((a) => a.address.toLowerCase() !== box.address) && (
                  <> · 经由 {box.address}</>
                )}
              </div>
            </div>
            <div className="sender-time">{formatFullTime(m.created_at)}</div>
          </div>

          <MailBody message={m} attachments={data.attachments} blockRemote={blockRemote && !showRemote} onShowRemote={() => setShowRemote(true)} />

          {visibleAtts.length > 0 && (
            <div className="attachments">
              {visibleAtts.map((a) => (
                <a key={a.id} className="att" href={attachmentUrl(a.id, true)} title={`下载 ${a.filename}`}>
                  <div className="att-icon">
                    {a.mime_type.startsWith("image/") ? (
                      <img src={attachmentUrl(a.id)} alt="" loading="lazy" />
                    ) : a.mime_type.startsWith("text/") || a.mime_type.includes("pdf") ? (
                      <FileText />
                    ) : (
                      <File />
                    )}
                  </div>
                  <div style={{ minWidth: 0, flex: 1 }}>
                    <div className="att-name">{a.filename}</div>
                    <div className="att-size">{formatSize(a.size)}</div>
                  </div>
                  <Download style={{ width: 16, height: 16, color: "var(--text-3)", flex: "none" }} />
                </a>
              ))}
            </div>
          )}

          <div className="reply-bar">
            <button className="btn" onClick={() => onReply("reply", m, data.attachments)}>
              <Reply /> 回复
            </button>
            {to.length + cc.length > 1 && (
              <button className="btn" onClick={() => onReply("replyAll", m, data.attachments)}>
                <ReplyAll /> 全部回复
              </button>
            )}
            <button className="btn" onClick={() => onReply("forward", m, data.attachments)}>
              <Forward /> 转发
            </button>
          </div>
        </article>
      </div>
    </>
  );
}

function MailBody({
  message,
  attachments,
  blockRemote,
  onShowRemote,
}: {
  message: MessageDetail;
  attachments: Attachment[];
  blockRemote: boolean;
  onShowRemote: () => void;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const prepared = useMemo(
    () => (message.html_body ? prepareEmailHtml(message.html_body, attachments, blockRemote) : null),
    [message.html_body, attachments, blockRemote],
  );

  useEffect(() => {
    const iframe = frame.current;
    if (!iframe || !prepared) return;
    let observer: ResizeObserver | undefined;
    const fit = () => {
      const doc = iframe.contentDocument;
      if (doc?.documentElement) iframe.style.height = `${doc.documentElement.scrollHeight}px`;
    };
    const onLoad = () => {
      fit();
      const body = iframe.contentDocument?.body;
      if (body) {
        observer = new ResizeObserver(fit);
        observer.observe(body);
      }
      iframe.contentDocument?.querySelectorAll("img").forEach((img) => img.addEventListener("load", fit));
    };
    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      observer?.disconnect();
    };
  }, [prepared]);

  if (!prepared) {
    const text = message.text_body ?? "";
    return (
      <div
        className="mail-body plain"
        dangerouslySetInnerHTML={{ __html: text.trim() ? linkify(escapeHtml(text)) : '<span class="muted">（无内容）</span>' }}
      />
    );
  }

  return (
    <>
      {prepared.blocked > 0 && (
        <div className="remote-banner">
          <ImageOff />
          <span>为保护隐私，已阻止 {prepared.blocked} 个外部图片/资源</span>
          <span className="spacer" />
          <button className="btn btn-sm" onClick={onShowRemote}>
            显示图片
          </button>
        </div>
      )}
      <div className="mail-body">
        <iframe
          ref={frame}
          title="邮件内容"
          sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
          srcDoc={prepared.doc}
        />
      </div>
    </>
  );
}
