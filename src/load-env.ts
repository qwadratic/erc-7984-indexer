import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Load `.env.local` into `process.env` for standalone entrypoints (the decrypt
 * worker and the e2e test) that don't run under `node --env-file`. Existing
 * values are never overridden; a missing file is a silent no-op.
 *
 * Ponder auto-loads `.env.local` itself, so the app code path doesn't need this.
 */
export function loadEnvLocal(): void {
  const envPath = resolve(import.meta.dirname ?? ".", "..", ".env.local");
  try {
    const content = readFileSync(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const val = trimmed.slice(eqIdx + 1).trim();
      if (!process.env[key]) process.env[key] = val;
    }
  } catch {}
}
