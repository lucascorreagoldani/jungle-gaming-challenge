import { createHash } from "crypto";

/**
 * Serializa um objeto JavaScript em JSON Canônico (chaves ordenadas lexicograficamente de forma recursiva).
 * Ignora valores undefined.
 */
export function canonicalizeJson(obj: unknown): string {
  if (obj === null || typeof obj !== "object") {
    return JSON.stringify(obj);
  }

  if (Array.isArray(obj)) {
    return `[${obj.map((item) => canonicalizeJson(item)).join(",")}]`;
  }

  const record = obj as Record<string, unknown>;
  const sortedKeys = Object.keys(record).sort();
  const pairs = sortedKeys
    .filter((key) => record[key] !== undefined)
    .map((key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`);

  return `{${pairs.join(",")}}`;
}

/**
 * Gera o hash SHA-256 do JSON Canônico de um payload de negócio.
 */
export function hashCanonicalPayload(payload: unknown): string {
  const canonicalString = canonicalizeJson(payload);
  return createHash("sha256").update(canonicalString).digest("hex");
}
