import { useCallback, useEffect, useState } from "react";
import { api, setUnauthorizedHandler } from "./api";
import { AuthScreen } from "./components/Auth";
import { MailApp } from "./components/MailApp";
import { ConfirmProvider, LogoMark, Spinner, ToastProvider } from "./components/ui";

type Phase = "loading" | "setup" | "login" | "app" | "error";

export default function App() {
  const [phase, setPhase] = useState<Phase>("loading");
  const [tokenRequired, setTokenRequired] = useState(false);

  const check = useCallback(async () => {
    try {
      const s = await api.status();
      setTokenRequired(s.setup_token_required);
      setPhase(!s.initialized ? "setup" : s.authenticated ? "app" : "login");
    } catch {
      setPhase("error");
    }
  }, []);

  useEffect(() => {
    setUnauthorizedHandler(() => setPhase("login"));
    check();
  }, [check]);

  return (
    <ToastProvider>
      <ConfirmProvider>
        {phase === "loading" && (
          <div className="auth">
            <Spinner size={26} />
          </div>
        )}
        {phase === "error" && (
          <div className="auth">
            <div className="auth-card" style={{ textAlign: "center" }}>
              <div style={{ display: "flex", justifyContent: "center" }}>
                <LogoMark large />
              </div>
              <h1>无法连接服务器</h1>
              <p className="lead">请检查网络，或确认 Worker 已正确部署并绑定了 D1 数据库。</p>
              <button className="btn btn-primary btn-block" onClick={check}>
                重试
              </button>
            </div>
          </div>
        )}
        {(phase === "setup" || phase === "login") && <AuthScreen mode={phase} tokenRequired={tokenRequired} onDone={() => setPhase("app")} />}
        {phase === "app" && <MailApp onLogout={() => setPhase("login")} />}
      </ConfirmProvider>
    </ToastProvider>
  );
}
