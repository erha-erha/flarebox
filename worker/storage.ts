// Blob storage for raw messages, large bodies and attachments.
// Uses R2 when the BUCKET binding exists; otherwise stores base64 chunks in D1
// so FlareBox also runs on accounts that have not enabled R2.
import { fromBase64, toBase64 } from "./util";

// base64 of 1 MB is ~1.34 MB, safely under D1's 2 MB per-value limit.
const CHUNK_BYTES = 1_000_000;

type BlobData = ArrayBuffer | Uint8Array | string;

function toBytes(data: BlobData): Uint8Array {
  if (typeof data === "string") return new TextEncoder().encode(data);
  return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export function hasR2(env: Env): boolean {
  return !!env.BUCKET;
}

export async function putBlob(env: Env, key: string, data: BlobData, contentType: string): Promise<void> {
  if (env.BUCKET) {
    await env.BUCKET.put(key, data, { httpMetadata: { contentType } });
    return;
  }
  const bytes = toBytes(data);
  await env.DB.prepare("DELETE FROM blobs WHERE key = ?").bind(key).run();
  // One statement per chunk: a single batch of a 25 MB message would be too large.
  for (let seq = 0, off = 0; off < bytes.length || seq === 0; seq++, off += CHUNK_BYTES) {
    await env.DB.prepare("INSERT INTO blobs (key, seq, data) VALUES (?, ?, ?)")
      .bind(key, seq, toBase64(bytes.subarray(off, off + CHUNK_BYTES)))
      .run();
  }
}

export async function getBlob(env: Env, key: string): Promise<Uint8Array | null> {
  if (env.BUCKET) {
    const obj = await env.BUCKET.get(key);
    return obj ? new Uint8Array(await obj.arrayBuffer()) : null;
  }
  const { results } = await env.DB.prepare("SELECT data FROM blobs WHERE key = ? ORDER BY seq")
    .bind(key)
    .all<{ data: string }>();
  if (!results.length) return null;
  const parts = results.map((r) => fromBase64(r.data));
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export async function deleteBlobs(env: Env, keys: string[]): Promise<void> {
  if (!keys.length) return;
  if (env.BUCKET) {
    await env.BUCKET.delete(keys);
    return;
  }
  for (let i = 0; i < keys.length; i += 50) {
    const chunk = keys.slice(i, i + 50);
    await env.DB.prepare(`DELETE FROM blobs WHERE key IN (${chunk.map(() => "?").join(",")})`)
      .bind(...chunk)
      .run();
  }
}
