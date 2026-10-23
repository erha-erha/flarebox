import { ArrowRight, Check, Cloud, Inbox, SquarePen, Zap } from "lucide-react";
import type { Bootstrap } from "../api";
import { LogoMark } from "./ui";

export function Welcome({ data, onConnect, onCompose }: { data: Bootstrap; onConnect: () => void; onCompose: () => void }) {
  const steps = [
    {
      done: data.settings.cf_connected || data.domains.length > 0,
      icon: Cloud,
      title: "连接 Cloudflare",
      text: "创建一个预填好权限的 API 令牌并粘贴进来，只需要做一次。",
      action: (
        <button className="btn btn-primary btn-sm" onClick={onConnect}>
          去连接 <ArrowRight />
        </button>
      ),
    },
    {
      done: data.domains.length > 0,
      icon: Zap,
      title: "一键接入域名",
      text: "选择你的域名，FlareBox 自动配置 MX、SPF、DKIM、收信路由和发信。",
      action: (
        <button className="btn btn-primary btn-sm" onClick={onConnect}>
          选择域名 <ArrowRight />
        </button>
      ),
    },
    {
      done: false,
      icon: SquarePen,
      title: "开始收发邮件",
      text: "任何发往 *@你的域名 的邮件都会自动出现在这里，也可以直接用任意地址发信。",
      action: (
        <button className="btn btn-sm" onClick={onCompose} disabled={!data.domains.length}>
          写第一封邮件
        </button>
      ),
    },
  ];
  const activeIndex = steps.findIndex((s) => !s.done);

  return (
    <div className="reader-scroll scroll">
      <div className="welcome">
        <LogoMark large />
        <h1>三步拥有自己的域名邮箱</h1>
        <p className="lead">FlareBox 完全运行在你自己的 Cloudflare 账户里：Workers 处理收发，D1 存邮件，R2 存附件。</p>
        <div className="steps">
          {steps.map((s, i) => (
            <div key={s.title} className={`step${s.done ? " done" : ""}`}>
              <div className="step-num">{s.done ? <Check /> : i + 1}</div>
              <div>
                <h4>{s.title}</h4>
                <p>{s.text}</p>
                {i === activeIndex && s.action}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export function NothingSelected() {
  return (
    <div className="empty">
      <div className="empty-icon">
        <Inbox />
      </div>
      <h3>选择一封邮件阅读</h3>
      <p>
        快捷键：<kbd>C</kbd> 写邮件 · <kbd>/</kbd> 搜索 · <kbd>J</kbd>/<kbd>K</kbd> 上下切换 · <kbd>E</kbd> 归档 · <kbd>R</kbd> 回复
      </p>
    </div>
  );
}
