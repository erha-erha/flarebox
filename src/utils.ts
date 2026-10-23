import { attachmentUrl, type Address, type Attachment } from "./api";

export function parseAddresses(json: string | null | undefined): Address[] {
  try {
    const v = JSON.parse(json ?? "[]");
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

export function displayName(name: string | undefined, address: string): string {
  return name?.trim() || address.split("@")[0];
}

const pad = (n: number) => String(n).padStart(2, "0");

export function formatListTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "昨天";
  if (d.getFullYear() === now.getFullYear()) return `${d.getMonth() + 1}月${d.getDate()}日`;
  return `${d.getFullYear()}/${d.getMonth() + 1}/${d.getDate()}`;
}

export function formatFullTime(ts: number): string {
  const d = new Date(ts);
  const week = "日一二三四五六"[d.getDay()];
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 周${week} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(bytes < 10240 ? 1 : 0)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

const AVATAR_HUES = [12, 28, 160, 200, 225, 260, 290, 330, 95, 45];

export function avatarStyle(seed: string): { background: string; color: string } {
  let h = 0;
  for (const ch of seed.toLowerCase()) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const hue = AVATAR_HUES[h % AVATAR_HUES.length];
  return {
    background: `linear-gradient(135deg, hsl(${hue} 85% 62%), hsl(${(hue + 25) % 360} 78% 50%))`,
    color: "#fff",
  };
}

export function initials(name: string): string {
  const clean = name.replace(/["'<>]/g, "").trim();
  if (!clean) return "?";
  if (/^[\u3400-\u9fff]/.test(clean)) return clean[0];
  const parts = clean.split(/[\s._-]+/).filter(Boolean);
  return ((parts[0]?.[0] ?? "") + (parts[1]?.[0] ?? "")).toUpperCase() || "?";
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function linkify(escaped: string): string {
  return escaped.replace(
    /(https?:\/\/[^\s<>"']+[^\s<>"'.,;:!?)\]])/g,
    '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
  );
}

export function textToHtml(text: string): string {
  return linkify(escapeHtml(text)).replace(/\n/g, "<br>");
}

const DANGEROUS_TAGS = "script,iframe,frame,frameset,object,embed,applet,form,input,button,textarea,select,base,link,meta";

/**
 * Turns untrusted email HTML into a document safe to show in a sandboxed iframe:
 * scripts/handlers removed, cid: images resolved, remote content optionally blocked.
 */
export function prepareEmailHtml(
  html: string,
  attachments: Attachment[],
  blockRemote: boolean,
): { doc: string; blocked: number } {
  const dom = new DOMParser().parseFromString(html, "text/html");
  dom.querySelectorAll(DANGEROUS_TAGS).forEach((el) => el.remove());

  const byCid = new Map(attachments.filter((a) => a.content_id).map((a) => [a.content_id!.toLowerCase(), a.id]));
  let blocked = 0;
  const isRemote = (v: string) => /^\s*(https?:)?\/\//i.test(v);

  dom.querySelectorAll("*").forEach((el) => {
    for (const attr of [...el.attributes]) {
      const name = attr.name.toLowerCase();
      const value = attr.value;
      if (name.startsWith("on")) el.removeAttribute(attr.name);
      else if (["href", "src", "xlink:href", "action", "formaction", "background", "poster"].includes(name)) {
        if (/^\s*(javascript|vbscript|data:text\/html)/i.test(value)) el.removeAttribute(attr.name);
      }
    }
    const src = el.getAttribute("src");
    if (src?.toLowerCase().startsWith("cid:")) {
      const id = byCid.get(src.slice(4).toLowerCase());
      if (id) el.setAttribute("src", attachmentUrl(id));
    } else if (blockRemote && src && isRemote(src) && el.tagName !== "A") {
      el.removeAttribute("src");
      el.removeAttribute("srcset");
      blocked++;
    }
    if (blockRemote) {
      const bg = el.getAttribute("background");
      if (bg && isRemote(bg)) {
        el.removeAttribute("background");
        blocked++;
      }
      const style = el.getAttribute("style");
      if (style && /url\(\s*['"]?\s*(https?:)?\/\//i.test(style)) {
        el.setAttribute("style", style.replace(/url\([^)]*\)/gi, "none"));
        blocked++;
      }
    }
    if (el.tagName === "A") {
      el.setAttribute("target", "_blank");
      el.setAttribute("rel", "noopener noreferrer");
    }
  });
  if (blockRemote) {
    dom.querySelectorAll("style").forEach((s) => {
      if (/url\(\s*['"]?\s*(https?:)?\/\//i.test(s.textContent ?? "")) {
        s.textContent = (s.textContent ?? "").replace(/url\(\s*['"]?\s*(https?:)?\/\/[^)]*\)/gi, "none");
        blocked++;
      }
    });
  }

  const imgSrc = blockRemote ? "'self' data: blob: cid:" : "* data: blob:";
  const csp = `default-src 'none'; img-src ${imgSrc}; media-src ${imgSrc}; style-src 'unsafe-inline' ${blockRemote ? "" : "*"}; font-src ${blockRemote ? "data:" : "* data:"}`;
  const doc = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}">
<style>
  html,body{margin:0;padding:0;background:#fff;color:#1d1d1f;}
  body{padding:4px 2px 12px;font:15px/1.6 -apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;word-wrap:break-word;overflow-wrap:anywhere;}
  img{max-width:100%;height:auto;}
  table{max-width:100%;}
  pre{white-space:pre-wrap;}
  blockquote{margin:0 0 0 .4em;padding-left:1em;border-left:3px solid #e2e2e2;color:#555;}
  a{color:#d4570f;}
</style></head><body>${dom.body.innerHTML}</body></html>`;
  return { doc, blocked };
}

export function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result).replace(/^data:[^,]*,/, ""));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

export function quoteHeader(from: string, ts: number): string {
  return `${formatFullTime(ts)}，${escapeHtml(from)} 写道：`;
}
