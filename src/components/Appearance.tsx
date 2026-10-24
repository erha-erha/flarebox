import { Check, ImageOff, ImagePlus, Moon, Sun, SunMoon, X } from "lucide-react";
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { useToast } from "./ui";

export type Theme = "auto" | "light" | "dark";

/** "none" | a preset id | "custom" (uploaded image) | "url" (image link) */
export interface Appearance {
  wallpaper: string;
  url: string;
  /** opacity of the panes over the wallpaper, 0–90 (%) */
  opacity: number;
  /** frosted-glass blur of the panes, 0–40 (px) */
  blur: number;
}

interface Preset {
  id: string;
  label: string;
  src: string;
  thumb: string;
}
interface Category {
  id: string;
  label: string;
  items: Preset[];
}

const photo = (id: string, label: string): Preset => ({
  id,
  label,
  src: `/wallpapers/photos/${id}.webp`,
  thumb: `/wallpapers/thumbs/${id}.webp`,
});
const drawing = (id: string, label: string): Preset => ({ id, label, src: `/wallpapers/${id}.svg`, thumb: `/wallpapers/${id}.svg` });

export const CATEGORIES: Category[] = [
  {
    id: "mountains",
    label: "山川",
    items: [
      photo("cloud-sea", "云海"),
      photo("snow-peak", "雪峰"),
      photo("dusk-ridges", "暮山"),
      photo("misty-hills", "远岱"),
      photo("valley-river", "溪谷"),
      photo("green-highland", "青峦"),
    ],
  },
  {
    id: "waters",
    label: "湖海",
    items: [
      photo("moraine-lake", "湖光"),
      photo("emerald-lake", "碧湖"),
      photo("calm-lake", "静湖"),
      photo("beach-sunrise", "海滩"),
      photo("ocean-aerial", "海浪"),
      photo("sea-cove", "海湾"),
    ],
  },
  {
    id: "sky",
    label: "日月星辰",
    items: [
      photo("sunrise-meadow", "日出"),
      photo("sunset-pier", "落日"),
      photo("full-moon", "明月"),
      photo("starry-mountain", "星空"),
      photo("milky-way-lake", "银河"),
      photo("aurora-forest", "极光"),
    ],
  },
  {
    id: "forest",
    label: "森林原野",
    items: [
      photo("misty-forest", "雾林"),
      photo("forest-path", "林间"),
      photo("autumn-woods", "秋林"),
      photo("lavender-field", "花海"),
      photo("green-meadow", "绿野"),
      photo("snowy-cabin", "雪原"),
    ],
  },
  {
    id: "drawings",
    label: "插画",
    items: [
      drawing("sunset", "晚霞"),
      drawing("aurora", "极光"),
      drawing("mountains", "远山"),
      drawing("ocean", "海浪"),
      drawing("dawn", "晨曦"),
      drawing("night", "星夜"),
    ],
  },
];
const PRESETS = new Map(CATEGORIES.flatMap((c) => c.items.map((p) => [p.id, p] as const)));
const CUSTOM_TAB = "custom";

const DEFAULT: Appearance = { wallpaper: "none", url: "", opacity: 30, blur: 6 };
const KEY = "fb-appearance-v2";
/** Earlier versions defaulted to much more opaque panes; only the chosen image carries over. */
const LEGACY_KEY = "fb-appearance";
const CUSTOM_KEY = "fb-wallpaper-custom";
/** Longest edge of an uploaded image after downscaling. */
const MAX_EDGE = 2560;

function loadAppearance(): Appearance {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw) return { ...DEFAULT, ...JSON.parse(raw) };
    const legacy = localStorage.getItem(LEGACY_KEY);
    if (legacy) {
      const { wallpaper, url } = JSON.parse(legacy) as Partial<Appearance>;
      return { ...DEFAULT, wallpaper: wallpaper ?? DEFAULT.wallpaper, url: url ?? "" };
    }
  } catch {
    /* storage unavailable or corrupt */
  }
  return DEFAULT;
}

function loadCustom(): string {
  try {
    return localStorage.getItem(CUSTOM_KEY) ?? "";
  } catch {
    return "";
  }
}

const cssUrl = (src: string) => `url("${src.replace(/["\\]/g, "\\$&").replace(/[\r\n]/g, "")}")`;

export function useAppearance() {
  const [appearance, setAppearance] = useState<Appearance>(loadAppearance);
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
  const src = wallpaper === "custom" ? custom : wallpaper === "url" ? appearance.url : (PRESETS.get(wallpaper)?.src ?? "");

  const style = src
    ? ({ "--pane-alpha": `${appearance.opacity}%`, "--glass-blur": `${appearance.blur}px` } as CSSProperties)
    : undefined;

  return { appearance, setAppearance, custom, setCustom, src, style };
}

/** Full-screen backdrop; a new image fades in over the old one once it has loaded. */
export function Wallpaper({ src }: { src: string }) {
  const [layers, setLayers] = useState({ current: src, previous: "" });
  useEffect(() => {
    let alive = true;
    const img = new Image();
    img.onload = img.onerror = () => alive && setLayers((l) => (l.current === src ? l : { current: src, previous: l.current }));
    img.src = src;
    return () => {
      alive = false;
    };
  }, [src]);
  return (
    <>
      {layers.previous && <div className="wallpaper" style={{ backgroundImage: cssUrl(layers.previous) }} aria-hidden />}
      <div key={layers.current} className="wallpaper fade" style={{ backgroundImage: cssUrl(layers.current) }} aria-hidden />
    </>
  );
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
  const [tab, setTab] = useState(() =>
    appearance.wallpaper === "custom" || appearance.wallpaper === "url"
      ? CUSTOM_TAB
      : (CATEGORIES.find((c) => c.items.some((p) => p.id === appearance.wallpaper))?.id ?? CATEGORIES[0].id),
  );
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
  const tile = (id: string, label: string, thumb: string | null, onClick = () => set({ wallpaper: id })) => {
    const on = appearance.wallpaper === id;
    return (
      <button key={id} className={`wp-tile${on ? " on" : ""}`} onClick={onClick} title={label} aria-pressed={on}>
        <span className="wp-thumb">
          {thumb ? <img src={thumb} alt="" loading="lazy" decoding="async" /> : <ImagePlus />}
          <span className="wp-label">{label}</span>
          {on && (
            <span className="wp-check">
              <Check />
            </span>
          )}
        </span>
      </button>
    );
  };
  const category = CATEGORIES.find((c) => c.id === tab);

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
          <div className="appearance-label">
            背景图片
            {state.src && (
              <button className="wp-off" onClick={() => set({ wallpaper: "none" })}>
                <ImageOff /> 不使用背景
              </button>
            )}
          </div>
          <div className="wp-tabs" role="tablist">
            {[...CATEGORIES, { id: CUSTOM_TAB, label: "自定义" }].map((c) => (
              <button key={c.id} role="tab" aria-selected={tab === c.id} className={tab === c.id ? "on" : ""} onClick={() => setTab(c.id)}>
                {c.label}
              </button>
            ))}
          </div>

          {category ? (
            <div className="wp-grid">{category.items.map((p) => tile(p.id, p.label, p.thumb))}</div>
          ) : (
            <>
              <div className="wp-grid">
                {tile("custom", busy ? "处理中…" : custom ? "我的图片" : "上传图片", custom || null, () =>
                  custom && appearance.wallpaper !== "custom" ? set({ wallpaper: "custom" }) : fileRef.current?.click(),
                )}
                {appearance.url && tile("url", "图片链接", appearance.url)}
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
                <input className="input" placeholder="粘贴图片链接 https://…" value={url} onChange={(e) => setUrl(e.target.value)} />
                <button className={`btn btn-sm${appearance.wallpaper === "url" && appearance.url === url.trim() ? "" : " btn-primary"}`} type="submit">
                  应用
                </button>
              </form>
            </>
          )}
        </div>

        {state.src && (
          <div className="appearance-section">
            <label className="wp-slider">
              <span>
                面板不透明度 <b>{appearance.opacity}%</b>
              </span>
              <input type="range" min={0} max={90} value={appearance.opacity} onChange={(e) => set({ opacity: +e.target.value })} />
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

        <p className="appearance-note">外观设置只保存在当前浏览器中。风景照片来自 Unsplash。</p>
      </div>
    </div>
  );
}
