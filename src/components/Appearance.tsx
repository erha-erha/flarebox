import { Check, ImageOff, ImagePlus, Moon, Sun, SunMoon, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useToast } from "./ui";

export type Theme = "auto" | "light" | "dark";

/** "none" | a preset id | "custom" (uploaded image) | "url" (image link) */
export interface Appearance {
  wallpaper: string;
  url: string;
  /** opacity of the panes over the wallpaper, 30–100 (%) */
  opacity: number;
  /** frosted-glass blur of the panes, 0–40 (px) */
  blur: number;
}

export const WALLPAPERS: { id: string; label: string }[] = [
  { id: "sunset", label: "落日" },
  { id: "aurora", label: "极光" },
  { id: "mountains", label: "远山" },
  { id: "ocean", label: "海浪" },
  { id: "dawn", label: "晨曦" },
  { id: "night", label: "星夜" },
];

const DEFAULT: Appearance = { wallpaper: "none", url: "", opacity: 78, blur: 18 };
const KEY = "fb-appearance";
const CUSTOM_KEY = "fb-wallpaper-custom";
/** Longest edge of an uploaded image after downscaling. */
const MAX_EDGE = 2560;

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? { ...fallback, ...JSON.parse(raw) } : fallback;
  } catch {
    return fallback;
  }
}

function loadCustom(): string {
  try {
    return localStorage.getItem(CUSTOM_KEY) ?? "";
  } catch {
    return "";
  }
}

const presetUrl = (id: string) => `/wallpapers/${id}.svg`;
const cssUrl = (src: string) => `url("${src.replace(/["\\]/g, "\\$&").replace(/[\r\n]/g, "")}")`;

export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(() => load(KEY, DEFAULT));
  const [custom, setCustomState] = useState(loadCustom);

  useEffect(() => {
    try {
      localStorage.setItem(KEY, JSON.stringify(appearance));
    } catch {
      /* storage unavailable */
    }
  }, [appearance]);

  /** Store an uploaded image; throws when it doesn't fit in browser storage. */
  const setCustom = (dataUrl: string) => {
    try {
      localStorage.setItem(CUSTOM_KEY, dataUrl);
    } catch {
      throw new Error("图片太大，浏览器无法保存，请换一张小一些的图片");
    }
    setCustomState(dataUrl);
  };

  const { wallpaper } = appearance;
  const src =
    wallpaper === "custom" ? custom : wallpaper === "url" ? appearance.url : WALLPAPERS.some((w) => w.id === wallpaper) ? presetUrl(wallpaper) : "";

  const style = src
    ? ({ "--pane-alpha": `${appearance.opacity}%`, "--glass-blur": `${appearance.blur}px` } as CSSProperties)
    : undefined;

  return { appearance, setAppearance, custom, setCustom, src, style };
}

export function Wallpaper({ src }: { src: string }) {
  return <div className="wallpaper" style={{ backgroundImage: cssUrl(src) }} aria-hidden />;
}

/** Downscale an image file and encode it as a JPEG data URL small enough for localStorage. */
async function compress(file: File): Promise<string> {
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.src = url;
    await img.decode();
    const w = img.naturalWidth || 1920;
    const h = img.naturalHeight || 1080;
    const scale = Math.min(1, MAX_EDGE / Math.max(w, h));
    const canvas = document.createElement("canvas");
    canvas.width = Math.round(w * scale);
    canvas.height = Math.round(h * scale);
    const ctx = canvas.getContext("2d")!;
    ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
    return canvas.toDataURL("image/jpeg", 0.85);
  } catch {
    throw new Error("无法读取这张图片");
  } finally {
    URL.revokeObjectURL(url);
  }
}

export function AppearancePanel({
  theme,
  onTheme,
  state,
  onClose,
}: {
  theme: Theme;
  onTheme: (t: Theme) => void;
  state: ReturnType<typeof useAppearance>;
  onClose: () => void;
}) {
  const notify = useToast();
  const { appearance, setAppearance, custom, setCustom } = state;
  const [url, setUrl] = useState(appearance.url);
  const [busy, setBusy] = useState(false);
  const panelRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const set = (patch: Partial<Appearance>) => setAppearance((a) => ({ ...a, ...patch }));

  useEffect(() => {
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!panelRef.current?.contains(t) && !t.closest(".appearance-toggle")) onClose();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.stopImmediatePropagation();
      onClose();
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey, true);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey, true);
    };
  }, [onClose]);

  const upload = async (file: File | undefined) => {
    if (!file) return;
    if (!file.type.startsWith("image/")) return notify("请选择图片文件", "error");
    setBusy(true);
    try {
      setCustom(await compress(file));
      set({ wallpaper: "custom" });
    } catch (e) {
      notify((e as Error).message, "error");
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  const applyUrl = () => {
    const v = url.trim();
    if (!/^https?:\/\/\S+$/i.test(v)) return notify("请输入以 http(s):// 开头的图片链接", "error");
    set({ wallpaper: "url", url: v });
  };

  const themes: { id: Theme; label: string; icon: typeof Sun }[] = [
    { id: "auto", label: "跟随系统", icon: SunMoon },
    { id: "light", label: "浅色", icon: Sun },
    { id: "dark", label: "深色", icon: Moon },
  ];
  const tile = (id: string, label: string, bg: string | null, onClick = () => set({ wallpaper: id })) => (
    <button key={id} className={`wp-tile${appearance.wallpaper === id ? " on" : ""}`} onClick={onClick} title={label}>
      <span className="wp-thumb" style={bg ? { backgroundImage: cssUrl(bg) } : undefined}>
        {id === "none" && <ImageOff />}
        {id === "custom" && !bg && <ImagePlus />}
        {appearance.wallpaper === id && (
          <span className="wp-check">
            <Check />
          </span>
        )}
      </span>
      <span className="wp-label">{label}</span>
    </button>
  );

  return (
    <div className="appearance" ref={panelRef} role="dialog" aria-label="外观">
      <div className="appearance-head">
        <h3>外观</h3>
        <button className="icon-btn sm" onClick={onClose} aria-label="关闭">
          <X />
        </button>
      </div>

      <div className="appearance-body scroll">
        <div className="appearance-section">
          <div className="appearance-label">主题</div>
          <div className="segmented appearance-themes">
            {themes.map(({ id, label, icon: Icon }) => (
              <button key={id} className={theme === id ? "on" : ""} onClick={() => onTheme(id)}>
                <Icon /> {label}
              </button>
            ))}
          </div>
        </div>

        <div className="appearance-section">
          <div className="appearance-label">背景图片</div>
          <div className="wp-grid">
            {tile("none", "无", null)}
            {WALLPAPERS.map((w) => tile(w.id, w.label, presetUrl(w.id)))}
            {tile("custom", busy ? "处理中…" : custom ? "我的图片" : "上传图片", custom || null, () =>
              custom && appearance.wallpaper !== "custom" ? set({ wallpaper: "custom" }) : fileRef.current?.click(),
            )}
          </div>
          <input ref={fileRef} type="file" accept="image/*" hidden onChange={(e) => upload(e.target.files?.[0])} />
          {custom && (
            <button className="btn btn-ghost btn-sm wp-replace" onClick={() => fileRef.current?.click()} disabled={busy}>
              <ImagePlus /> 换一张本地图片
            </button>
          )}
          <form
            className="wp-url"
            onSubmit={(e) => {
              e.preventDefault();
              applyUrl();
            }}
          >
            <input className="input" placeholder="或粘贴图片链接 https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
            <button className={`btn btn-sm${appearance.wallpaper === "url" && appearance.url === url.trim() ? "" : " btn-primary"}`} type="submit">
              应用
            </button>
          </form>
        </div>

        {state.src && (
          <div className="appearance-section">
            <label className="wp-slider">
              <span>
                面板不透明度 <b>{appearance.opacity}%</b>
              </span>
              <input type="range" min={30} max={100} value={appearance.opacity} onChange={(e) => set({ opacity: +e.target.value })} />
            </label>
            <label className="wp-slider">
              <span>
                毛玻璃模糊 <b>{appearance.blur}px</b>
              </span>
              <input type="range" min={0} max={40} value={appearance.blur} onChange={(e) => set({ blur: +e.target.value })} />
            </label>
            <button className="btn btn-ghost btn-sm" onClick={() => set({ opacity: DEFAULT.opacity, blur: DEFAULT.blur })}>
              恢复默认效果
            </button>
          </div>
        )}

        <p className="appearance-note">外观设置只保存在当前浏览器中。</p>
      </div>
    </div>
  );
}
