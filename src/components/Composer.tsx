import {
  Bold,
  Eraser,
  Italic,
  Link,
  List,
  ListOrdered,
  Maximize2,
  Minimize2,
  Minus,
  Paperclip,
  Quote,
  SendHorizontal,
  Trash2,
  Underline,
  X,
} from "lucide-react";
import { useEffect, useRef, useState, type ClipboardEvent, type KeyboardEvent } from "react";
import { api, type Mailbox } from "../api";
import { fileToBase64, formatSize } from "../utils";
import { Spinner, useConfirm, useToast } from "./ui";

export interface Draft {
  key: number;
  title: string;
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  html: string;
  replyToId?: string;
  forwardAttachments?: { id: string; filename: string; size: number }[];
}

const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]{2,}$/;
const MAX_BYTES = 5 * 1024 * 1024;

function RecipientInput({
  value,
  onChange,
  autoFocus,
  placeholder,
}: {
  value: string[];
  onChange: (v: string[]) => void;
  autoFocus?: boolean;
  placeholder?: string;
}) {
  const [text, setText] = useState("");
  const commit = (raw: string) => {
    const parts = raw
      .split(/[\s,;，；]+/)
      .map((s) => s.replace(/^.*<([^>]+)>.*$/, "$1").trim())
      .filter(Boolean);
    if (parts.length) onChange([...value, ...parts.filter((p) => !value.includes(p))]);
    setText("");
  };
  const onKey = (e: KeyboardEvent<HTMLInputElement>) => {
    if (["Enter", ",", ";", " ", "Tab"].includes(e.key) && text.trim()) {
      e.preventDefault();
      commit(text);
    } else if (e.key === "Backspace" && !text && value.length) {
      onChange(value.slice(0, -1));
    }
  };
  const onPaste = (e: ClipboardEvent<HTMLInputElement>) => {
    const pasted = e.clipboardData.getData("text");
    if (/[\s,;]/.test(pasted.trim())) {
      e.preventDefault();
      commit(text + pasted);
    }
  };
  return (
    <div className="chips">
      {value.map((addr) => (
        <span key={addr} className={`rcpt${EMAIL_RE.test(addr) ? "" : " invalid"}`} title={addr}>
          <span style={{ paddingLeft: 6 }}>{addr}</span>
          <button type="button" onClick={() => onChange(value.filter((a) => a !== addr))} aria-label={`移除 ${addr}`}>
            <X />
          </button>
        </span>
      ))}
      <input
        value={text}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={onKey}
        onPaste={onPaste}
        onBlur={() => text.trim() && commit(text)}
        autoFocus={autoFocus}
        placeholder={value.length ? "" : placeholder}
        type="email"
        multiple
        autoComplete="email"
      />
    </div>
  );
}

export function Composer({
  draft,
  mailboxes,
  onClose,
  onSent,
}: {
  draft: Draft;
  mailboxes: Mailbox[];
  onClose: () => void;
  onSent: () => void;
}) {
  const notify = useToast();
  const confirm = useConfirm();
  const [from, setFrom] = useState(draft.from || mailboxes[0]?.address || "");
  const [to, setTo] = useState(draft.to);
  const [cc, setCc] = useState(draft.cc);
  const [bcc, setBcc] = useState(draft.bcc);
  const [showCc, setShowCc] = useState(draft.cc.length > 0);
  const [showBcc, setShowBcc] = useState(false);
  const [subject, setSubject] = useState(draft.subject);
  const [files, setFiles] = useState<File[]>([]);
  const [fwd, setFwd] = useState(draft.forwardAttachments ?? []);
  const [mode, setMode] = useState<"normal" | "max" | "min">("normal");
  const [sending, setSending] = useState(false);
  const [dragging, setDragging] = useState(false);
  const editor = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const initialText = useRef("");

  useEffect(() => {
    if (editor.current) {
      editor.current.innerHTML = draft.html;
      initialText.current = editor.current.innerText.trim();
    }
    if (draft.to.length && editor.current) {
      editor.current.focus();
      const range = document.createRange();
      range.setStart(editor.current, 0);
      range.collapse(true);
      window.getSelection()?.removeAllRanges();
      window.getSelection()?.addRange(range);
    }
  }, [draft]);

  const totalBytes = files.reduce((n, f) => n + f.size, 0) + fwd.reduce((n, f) => n + f.size, 0);
  const domains = [...new Set(mailboxes.map((m) => m.address.split("@")[1]))];

  const exec = (cmd: string, value?: string) => {
    editor.current?.focus();
    document.execCommand(cmd, false, value);
  };

  const addFiles = (list: FileList | null) => {
    if (!list) return;
    const next = [...files, ...Array.from(list)];
    setFiles(next);
    const size = next.reduce((n, f) => n + f.size, 0) + fwd.reduce((n, f) => n + f.size, 0);
    if (size > MAX_BYTES) notify("附件总大小超过 5 MB，可能无法发送", "error");
  };

  const isDirty = () =>
    subject.trim() !== draft.subject.trim() ||
    (editor.current?.innerText.trim() ?? "") !== initialText.current ||
    files.length > 0 ||
    to.join() !== draft.to.join();

  const close = async () => {
    if (isDirty() && !(await confirm({ title: "放弃这封邮件？", body: "未发送的内容将会丢失。", confirm: "放弃", danger: true }))) {
      return;
    }
    onClose();
  };

  const send = async () => {
    const all = [...to, ...cc, ...bcc];
    if (!from) return notify("请先选择发件邮箱", "error");
    if (all.length === 0) return notify("请填写收件人", "error");
    const bad = all.find((a) => !EMAIL_RE.test(a));
    if (bad) return notify(`收件人地址无效：${bad}`, "error");
    if (!subject.trim() && !(await confirm({ title: "没有主题", body: "确定发送一封没有主题的邮件吗？", confirm: "仍然发送" }))) {
      return;
    }
    setSending(true);
    try {
      const attachments = await Promise.all(
        files.map(async (f) => ({ filename: f.name, type: f.type || "application/octet-stream", content: await fileToBase64(f) })),
      );
      const html = editor.current?.innerHTML ?? "";
      const text = editor.current?.innerText ?? "";
      await api.send({
        from,
        to,
        cc: showCc ? cc : [],
        bcc: showBcc ? bcc : [],
        subject: subject.trim(),
        html: `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','PingFang SC','Microsoft YaHei',sans-serif;font-size:14px;line-height:1.6">${html}</div>`,
        text,
        attachments,
        replyToId: draft.replyToId,
        forwardAttachmentIds: fwd.map((f) => f.id),
      });
      notify("邮件已发送", "success");
      onSent();
    } catch (err) {
      notify((err as Error).message, "error");
    } finally {
      setSending(false);
    }
  };

  const onKeyDown = (e: KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      send();
    }
    if (e.key === "Escape") {
      e.stopPropagation();
      setMode("min");
    }
  };

  return (
    <div
      className={`composer${mode === "max" ? " max" : mode === "min" ? " min" : ""}`}
      onKeyDown={onKeyDown}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes("Files")) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => e.currentTarget === e.target && setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragging(false);
        addFiles(e.dataTransfer.files);
      }}
    >
      {dragging && <div className="drop-hint">松开以添加附件</div>}
      <div className="composer-head" onDoubleClick={() => setMode(mode === "min" ? "normal" : "min")}>
        <h3>{subject.trim() || draft.title}</h3>
        <button className="icon-btn sm" onClick={() => setMode(mode === "min" ? "normal" : "min")} title="最小化">
          <Minus />
        </button>
        <button className="icon-btn sm" onClick={() => setMode(mode === "max" ? "normal" : "max")} title="最大化">
          {mode === "max" ? <Minimize2 /> : <Maximize2 />}
        </button>
        <button className="icon-btn sm" onClick={close} title="关闭">
          <X />
        </button>
      </div>

      <div className="composer-fields">
        <div className="cfield">
          <label>发件人</label>
          {mailboxes.length ? (
            <select className="bare" value={from} onChange={(e) => setFrom(e.target.value)}>
              {domains.map((d) => (
                <optgroup key={d} label={d}>
                  {mailboxes
                    .filter((m) => m.address.endsWith(`@${d}`))
                    .map((m) => (
                      <option key={m.id} value={m.address}>
                        {m.display_name ? `${m.display_name} <${m.address}>` : m.address}
                      </option>
                    ))}
                </optgroup>
              ))}
            </select>
          ) : (
            <span className="muted" style={{ fontSize: 13 }}>
              还没有邮箱，请先在侧边栏新建一个
            </span>
          )}
        </div>
        <div className="cfield">
          <label>收件人</label>
          <RecipientInput value={to} onChange={setTo} autoFocus={!draft.to.length} placeholder="输入邮箱地址，回车确认" />
          <div className="toggles">
            {!showCc && <button onClick={() => setShowCc(true)}>抄送</button>}
            {!showBcc && <button onClick={() => setShowBcc(true)}>密送</button>}
          </div>
        </div>
        {showCc && (
          <div className="cfield">
            <label>抄送</label>
            <RecipientInput value={cc} onChange={setCc} />
          </div>
        )}
        {showBcc && (
          <div className="cfield">
            <label>密送</label>
            <RecipientInput value={bcc} onChange={setBcc} />
          </div>
        )}
        <div className="cfield">
          <label>主题</label>
          <input className="bare" value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="邮件主题" />
        </div>
      </div>

      <div className="editor-toolbar">
        <button className="icon-btn sm" onMouseDown={(e) => e.preventDefault()} onClick={() => exec("bold")} title="加粗">
          <Bold />
        </button>
        <button className="icon-btn sm" onMouseDown={(e) => e.preventDefault()} onClick={() => exec("italic")} title="斜体">
          <Italic />
        </button>
        <button className="icon-btn sm" onMouseDown={(e) => e.preventDefault()} onClick={() => exec("underline")} title="下划线">
          <Underline />
        </button>
        <span className="sep" />
        <button className="icon-btn sm" onMouseDown={(e) => e.preventDefault()} onClick={() => exec("insertUnorderedList")} title="无序列表">
          <List />
        </button>
        <button className="icon-btn sm" onMouseDown={(e) => e.preventDefault()} onClick={() => exec("insertOrderedList")} title="有序列表">
          <ListOrdered />
        </button>
        <button className="icon-btn sm" onMouseDown={(e) => e.preventDefault()} onClick={() => exec("formatBlock", "blockquote")} title="引用">
          <Quote />
        </button>
        <button
          className="icon-btn sm"
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => {
            const url = prompt("链接地址", "https://");
            if (url && /^(https?:|mailto:)/i.test(url)) exec("createLink", url);
          }}
          title="插入链接"
        >
          <Link />
        </button>
        <button className="icon-btn sm" onMouseDown={(e) => e.preventDefault()} onClick={() => exec("removeFormat")} title="清除格式">
          <Eraser />
        </button>
      </div>

      <div
        ref={editor}
        className="editor"
        contentEditable
        suppressContentEditableWarning
        data-placeholder="写点什么…"
        onPaste={(e) => {
          // Paste as plain text to avoid dragging foreign styles/scripts into the mail.
          e.preventDefault();
          document.execCommand("insertText", false, e.clipboardData.getData("text/plain"));
        }}
      />

      {(files.length > 0 || fwd.length > 0) && (
        <div className="composer-atts">
          {fwd.map((f) => (
            <span key={f.id} className="rcpt" title={f.filename}>
              <Paperclip style={{ width: 13, height: 13, marginLeft: 6 }} />
              <span>
                {f.filename} · {formatSize(f.size)}
              </span>
              <button onClick={() => setFwd(fwd.filter((x) => x.id !== f.id))} aria-label="移除附件">
                <X />
              </button>
            </span>
          ))}
          {files.map((f, i) => (
            <span key={`${f.name}-${i}`} className="rcpt" title={f.name}>
              <Paperclip style={{ width: 13, height: 13, marginLeft: 6 }} />
              <span>
                {f.name} · {formatSize(f.size)}
              </span>
              <button onClick={() => setFiles(files.filter((_, j) => j !== i))} aria-label="移除附件">
                <X />
              </button>
            </span>
          ))}
        </div>
      )}

      <div className="composer-foot">
        <button className="btn btn-primary" onClick={send} disabled={sending}>
          {sending ? <Spinner size={16} /> : <SendHorizontal />}
          {sending ? "发送中…" : "发送"}
        </button>
        <span className="muted" style={{ fontSize: 12, marginLeft: 4 }}>
          <kbd>Ctrl</kbd> + <kbd>Enter</kbd>
        </span>
        <span className="spacer" />
        {totalBytes > 0 && (
          <span className="muted" style={{ fontSize: 12, color: totalBytes > MAX_BYTES ? "var(--danger)" : undefined }}>
            {formatSize(totalBytes)} / 5 MB
          </span>
        )}
        <input ref={fileInput} type="file" multiple hidden onChange={(e) => (addFiles(e.target.files), (e.target.value = ""))} />
        <button className="icon-btn" onClick={() => fileInput.current?.click()} title="添加附件">
          <Paperclip />
        </button>
        <button className="icon-btn" onClick={close} title="放弃">
          <Trash2 />
        </button>
      </div>
    </div>
  );
}
