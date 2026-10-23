import { CircleAlert, CircleCheck, Info, LoaderCircle, Mail, X } from "lucide-react";
import { createContext, useCallback, useContext, useEffect, useRef, useState, type ReactNode } from "react";
import { avatarStyle, initials } from "../utils";

// ---------------------------------------------------------------- toasts

type ToastKind = "success" | "error" | "info";
interface ToastItem {
  id: number;
  kind: ToastKind;
  text: string;
  action?: { label: string; run: () => void };
}
type Notify = (text: string, kind?: ToastKind, action?: ToastItem["action"]) => void;

const ToastContext = createContext<Notify>(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<ToastItem[]>([]);
  const nextId = useRef(1);
  const notify = useCallback<Notify>((text, kind = "info", action) => {
    const id = nextId.current++;
    setItems((list) => [...list.slice(-3), { id, kind, text, action }]);
    setTimeout(() => setItems((list) => list.filter((t) => t.id !== id)), kind === "error" ? 6000 : 3800);
  }, []);
  return (
    <ToastContext.Provider value={notify}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {items.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            {t.kind === "success" ? <CircleCheck /> : t.kind === "error" ? <CircleAlert /> : <Info />}
            <span>{t.text}</span>
            {t.action && (
              <button
                onClick={() => {
                  t.action!.run();
                  setItems((list) => list.filter((x) => x.id !== t.id));
                }}
              >
                {t.action.label}
              </button>
            )}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

// ---------------------------------------------------------------- modal

export function Modal({
  title,
  onClose,
  children,
  footer,
  wide,
  bare,
}: {
  title?: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  wide?: boolean;
  bare?: boolean;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className={`modal${wide ? " wide" : ""}`} role="dialog" aria-modal="true">
        {bare ? (
          children
        ) : (
          <>
            <div className="modal-head">
              <h3>{title}</h3>
              <button className="icon-btn sm" onClick={onClose} aria-label="关闭">
                <X />
              </button>
            </div>
            <div className="modal-body">{children}</div>
            {footer && <div className="modal-foot">{footer}</div>}
          </>
        )}
      </div>
    </div>
  );
}

interface ConfirmOptions {
  title: string;
  body: ReactNode;
  confirm?: string;
  danger?: boolean;
}
type ConfirmFn = (opts: ConfirmOptions) => Promise<boolean>;
const ConfirmContext = createContext<ConfirmFn>(async () => false);
export const useConfirm = () => useContext(ConfirmContext);

export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<(ConfirmOptions & { resolve: (v: boolean) => void }) | null>(null);
  const confirm = useCallback<ConfirmFn>((opts) => new Promise((resolve) => setState({ ...opts, resolve })), []);
  const close = (v: boolean) => {
    state?.resolve(v);
    setState(null);
  };
  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      {state && (
        <Modal
          title={state.title}
          onClose={() => close(false)}
          footer={
            <>
              <button className="btn" onClick={() => close(false)}>
                取消
              </button>
              <button className={`btn ${state.danger ? "btn-danger" : "btn-primary"}`} onClick={() => close(true)} autoFocus>
                {state.confirm ?? "确定"}
              </button>
            </>
          }
        >
          <div>{state.body}</div>
        </Modal>
      )}
    </ConfirmContext.Provider>
  );
}

// ---------------------------------------------------------------- small pieces

export function Switch({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      className={`switch${on ? " on" : ""}`}
      onClick={() => onChange(!on)}
    />
  );
}

export function Avatar({ name, seed, size }: { name: string; seed: string; size?: "sm" | "lg" }) {
  return (
    <div className={`avatar${size ? ` ${size}` : ""}`} style={avatarStyle(seed)} aria-hidden>
      {initials(name)}
    </div>
  );
}

export function Spinner({ size = 18 }: { size?: number }) {
  return <LoaderCircle className="spinner" style={{ width: size, height: size }} />;
}

export function LogoMark({ large }: { large?: boolean }) {
  return (
    <div className={`logo-mark${large ? " lg" : ""}`}>
      <Mail strokeWidth={2.4} />
    </div>
  );
}

export function useAsync() {
  const [busy, setBusy] = useState(false);
  const notify = useToast();
  const run = useCallback(
    async <T,>(fn: () => Promise<T>, success?: string): Promise<T | undefined> => {
      setBusy(true);
      try {
        const result = await fn();
        if (success) notify(success, "success");
        return result;
      } catch (err) {
        notify((err as Error).message, "error");
        return undefined;
      } finally {
        setBusy(false);
      }
    },
    [notify],
  );
  return { busy, run };
}
