import { ArrowRight, Eye, EyeOff } from "lucide-react";
import { useState, type FormEvent } from "react";
import { api } from "../api";
import { LogoMark, Spinner } from "./ui";

function setupTokenFromUrl(): string {
  return new URLSearchParams(window.location.search).get("setup") ?? "";
}

export function AuthScreen({
  mode,
  tokenRequired,
  onDone,
}: {
  mode: "setup" | "login";
  tokenRequired: boolean;
  onDone: () => void;
}) {
  const [setupToken, setSetupToken] = useState(setupTokenFromUrl);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [show, setShow] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const setup = mode === "setup";

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError("");
    if (setup && password.length < 8) return setError("密码至少需要 8 位");
    if (setup && password !== confirm) return setError("两次输入的密码不一致");
    if (setup && tokenRequired && !setupToken.trim()) return setError("请填写安装码");
    setBusy(true);
    try {
      await (setup ? api.setup(password, setupToken.trim()) : api.login(password));
      if (window.location.search) window.history.replaceState(null, "", window.location.pathname);
      onDone();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth">
      <div className="auth-card">
        <LogoMark large />
        <h1>{setup ? "欢迎使用 FlareBox" : "登录 FlareBox"}</h1>
        <p className="lead">
          {setup ? "先设置一个管理员密码，之后用它登录管理你所有的域名邮箱。" : "输入管理员密码，进入你的域名邮箱。"}
        </p>
        <form onSubmit={submit}>
          {setup && tokenRequired && (
            <div className="field">
              <label htmlFor="setup-token">安装码</label>
              <input
                id="setup-token"
                className="input mono"
                value={setupToken}
                onChange={(e) => setSetupToken(e.target.value)}
                placeholder="部署时输出的一次性安装码"
                autoComplete="off"
              />
            </div>
          )}
          <div className="field">
            <label htmlFor="pw">{setup ? "管理员密码" : "密码"}</label>
            <div style={{ position: "relative" }}>
              <input
                id="pw"
                className="input"
                type={show ? "text" : "password"}
                autoComplete={setup ? "new-password" : "current-password"}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={setup ? "至少 8 位" : ""}
                autoFocus
                style={{ paddingRight: 42 }}
              />
              <button
                type="button"
                className="icon-btn sm"
                style={{ position: "absolute", right: 6, top: 6 }}
                onClick={() => setShow((v) => !v)}
                aria-label={show ? "隐藏密码" : "显示密码"}
              >
                {show ? <EyeOff /> : <Eye />}
              </button>
            </div>
          </div>
          {setup && (
            <div className="field">
              <label htmlFor="pw2">确认密码</label>
              <input
                id="pw2"
                className="input"
                type={show ? "text" : "password"}
                autoComplete="new-password"
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
            </div>
          )}
          <div className="auth-error">{error}</div>
          <button className="btn btn-primary btn-lg btn-block" disabled={busy || !password}>
            {busy ? <Spinner /> : null}
            {setup ? "完成设置" : "登录"}
            {!busy && <ArrowRight />}
          </button>
        </form>
        <div className="auth-foot">运行在你自己的 Cloudflare 账户上 · 数据只属于你</div>
      </div>
    </div>
  );
}
