// Secrets are not part of the generated wrangler types.
interface Env {
  /** Optional admin password set with `wrangler secret put ADMIN_PASSWORD` or the Deploy button. */
  ADMIN_PASSWORD?: string;
  /** One-time code required to set the admin password on a fresh deploy (set by scripts/setup.mjs). */
  SETUP_TOKEN?: string;
  /** Optional R2 bucket. Without it, blobs are stored in D1 (see storage.ts). */
  BUCKET?: R2Bucket;
}
