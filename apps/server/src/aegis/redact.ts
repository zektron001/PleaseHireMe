/**
 * KS-8 - redaction at the trust boundary.
 *
 * Redaction runs once, here, before a value can reach the store, an event, a log
 * line, or an HTTP response. Applying it at each sink instead would guarantee
 * that one sink is eventually missed.
 */

interface SecretPattern {
  readonly label: string;
  readonly pattern: RegExp;
}

/** Patterns that are structural and safe to compile once. */
const STRUCTURAL: readonly SecretPattern[] = [
  { label: "bearer", pattern: /Bearer\s+[A-Za-z0-9._~+/-]{8,}=*/gi },
  {
    label: "pem",
    pattern:
      /-----BEGIN[A-Z ]*PRIVATE KEY-----[\s\S]*?-----END[A-Z ]*PRIVATE KEY-----/g,
  },
  {
    label: "jwt",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  },
  { label: "volc-ak", pattern: /\bAKLT[A-Za-z0-9]{16,}\b/g },
  { label: "url-userinfo", pattern: /([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi },
  { label: "ark-key", pattern: /\bark-[A-Za-z0-9._-]{12,}\b/gi },
];

const mask = (label: string): string => "[REDACTED:" + label + "]";

/** Escapes a literal so it can be embedded in a RegExp. */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export class Redactor {
  private readonly literals: readonly SecretPattern[];

  /**
   * @param secrets Exact secret values known at boot (the Ark key, the auth
   *   token). Short or empty values are ignored so a blank config cannot cause
   *   every character in every string to be masked.
   */
  constructor(secrets: readonly string[] = []) {
    this.literals = secrets
      .map((value) => value.trim())
      .filter((value) => value.length >= 8)
      .map((value) => ({
        label: "secret",
        pattern: new RegExp(escapeLiteral(value), "g"),
      }));
  }

  text(input: string): string {
    let output = input;
    for (const { label, pattern } of this.literals) {
      output = output.replace(pattern, mask(label));
    }
    for (const { label, pattern } of STRUCTURAL) {
      output = output.replace(pattern, (_match, prefix?: string) =>
        label === "url-userinfo"
          ? (prefix ?? "") + mask(label) + "@"
          : mask(label),
      );
    }
    return output;
  }

  /** Deep-redacts a JSON-compatible value, preserving its shape. */
  value<T>(input: T): T {
    if (typeof input === "string") {
      return this.text(input) as unknown as T;
    }
    if (Array.isArray(input)) {
      return input.map((item: unknown) => this.value(item)) as unknown as T;
    }
    if (input !== null && typeof input === "object") {
      const result: Record<string, unknown> = {};
      for (const [key, item] of Object.entries(input as Record<string, unknown>)) {
        result[key] = this.value(item);
      }
      return result as unknown as T;
    }
    return input;
  }
}
