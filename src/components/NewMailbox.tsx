import { useState } from "react";
import { api, type Domain, type Mailbox } from "../api";
import { Modal, Spinner, useToast } from "./ui";

export function NewMailboxModal({
  domains,
  onClose,
  onCreated,
}: {
  domains: Domain[];
  onClose: () => void;
  onCreated: (m: Mailbox) => void;
}) {
  const notify = useToast();
  const [local, setLocal] = useState("");
  const [domain, setDomain] = useState(domains[0]?.name ?? "");
  const [name, setName] = useState("");
  const [busy, setBusy] = useState(false);

  const create = async () => {
    setBusy(true);
    try {
      const { mailbox } = await api.createMailbox(`${local.trim()}@${domain}`, name, "");
      notify(`已创建 ${mailbox.address}`, "success");
      onCreated(mailbox);
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title="新建邮箱"
      onClose={onClose}
      footer={
        <>
          <button className="btn" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={create} disabled={!local.trim() || !domain || busy}>
            {busy && <Spinner size={16} />} 创建
          </button>
        </>
      }
    >
      {domains.length === 0 ? (
        <div>请先在「设置 → 域名」中接入一个域名。</div>
      ) : (
        <>
          <div className="field">
            <label>邮箱地址</label>
            <div className="row" style={{ gap: 6 }}>
              <input
                className="input grow"
                value={local}
                onChange={(e) => setLocal(e.target.value.replace(/[@\s]/g, "").toLowerCase())}
                placeholder="hello"
                autoFocus
                onKeyDown={(e) => e.key === "Enter" && local.trim() && create()}
              />
              <span className="muted">@</span>
              <select className="select" style={{ width: "auto", maxWidth: "55%" }} value={domain} onChange={(e) => setDomain(e.target.value)}>
                {domains.map((d) => (
                  <option key={d.id} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
          </div>
          <div className="field">
            <label>发件人名称（可选）</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="收件人看到的名字，例如：张三" />
          </div>
        </>
      )}
    </Modal>
  );
}
