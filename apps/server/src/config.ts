import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

const envSchema = z.object({
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  LOG_LEVEL: z.string().default("info"),
  APP_DATA_DIR: z.string().default(path.resolve(".data")),
  AGENT_WORKSPACE_ROOT: z.string().default(path.resolve("workspaces")),
  CODEX_HOME: z.string().default(path.resolve("codex-home")),
  CODEX_BIN: z.string().default("codex"),
  CODEX_SANDBOX_MODE: z
    .enum(["read-only", "workspace-write", "danger-full-access"])
    .default("workspace-write"),
  CODEX_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(600_000),
  CODEX_MAX_OUTPUT_BYTES: z.coerce.number().int().min(65_536).default(2_097_152),
  RUNTIME_PROVIDER: z.enum(["local-process", "container"]).default("local-process"),
  CONTAINER_ENGINE: z.string().min(1).default("docker"),
  CONTAINER_RUNTIME_IMAGE: z.string().min(1).default("volc-agent-runtime:local"),
  CONTAINER_CPU_LIMIT: z.coerce.number().positive().default(2),
  CONTAINER_MEMORY_LIMIT: z
    .string()
    .regex(/^\d+(?:\.\d+)?[bkmg]$/i)
    .default("2g"),
  CONTAINER_PIDS_LIMIT: z.coerce.number().int().positive().default(256),
  CONTAINER_USER: z.string().optional(),
  RUNTIME_INSTANCE_ID: z
    .string()
    .trim()
    .min(1)
    .max(48)
    .regex(/^[a-zA-Z0-9_.-]+$/)
    .default("default"),
  APP_AUTH_TOKEN: z
    .string()
    .trim()
    .max(128)
    .regex(/^[A-Za-z0-9._~-]*$/, "APP_AUTH_TOKEN must use URL-safe characters")
    .optional(),
  ARK_API_KEY: z.string().optional(),
  ARK_MODEL: z.string().optional(),
  ARK_BASE_URL: z
    .string()
    .url()
    .default("https://ark.cn-beijing.volces.com/api/v3"),
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),

  // ---- AEGIS (Track C middleware) ----
  AEGIS_VAULT_PATH: z.string().default(path.resolve("vault")),
  /** Empty means "write the built-in profile into the data directory". */
  AEGIS_SECCOMP_PROFILE: z.string().default(""),
  /** "none", or the name of a user-defined `--internal` bridge network. */
  AEGIS_NETWORK_MODE: z.string().min(1).default("aegis-egress"),
  /**
   * Where the container reaches the broker. `host.docker.internal` resolves to
   * the host gateway, which the runtime argv maps explicitly with --add-host,
   * so this works on Docker Engine as well as Docker Desktop.
   */
  AEGIS_BROKER_URL: z.string().default("http://host.docker.internal:8788"),
  AEGIS_BROKER_PORT: z.coerce.number().int().positive().default(8788),
  AEGIS_AGENT_BUDGET_USD: z.coerce.number().nonnegative().default(0.5),
  AEGIS_TENANT_BUDGET_USD: z.coerce.number().nonnegative().default(5),
  /** T7 - how much of each decision is written at all. */
  AEGIS_CAPTURE_LEVEL: z.enum(["minimal", "standard", "full"]).default("standard"),
  AEGIS_RETENTION_MAX_EVENTS: z.coerce.number().int().positive().default(5_000),
  AEGIS_RETENTION_MAX_AGE_MS: z.coerce
    .number()
    .int()
    .positive()
    .default(7 * 24 * 60 * 60 * 1_000),
  /** T6 - runaway execution. Steps are Codex items; 0 disables the cap. */
  AEGIS_MAX_STEPS: z.coerce.number().int().nonnegative().default(120),
  AEGIS_MAX_CONCURRENT_RUNS: z.coerce.number().int().positive().default(4),
  AEGIS_ENABLED: z
    .enum(["true", "false"])
    .default("true")
    .transform((value) => value === "true"),
});

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env) {
  const env = envSchema.parse(environment);
  const authToken = env.APP_AUTH_TOKEN?.trim() ?? "";
  const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
  if (env.NODE_ENV === "production" && !loopbackHosts.has(env.HOST)) {
    if (authToken.length < 24 || authToken.startsWith("replace-")) {
      throw new Error(
        "APP_AUTH_TOKEN must contain at least 24 characters for a non-loopback production server",
      );
    }
  }
  const defaultContainerUser =
    typeof process.getuid === "function" && typeof process.getgid === "function"
      ? process.getuid() + ":" + process.getgid()
      : "1000:1000";
  return {
    host: env.HOST,
    port: env.PORT,
    logLevel: env.LOG_LEVEL,
    dataDirectory: path.resolve(env.APP_DATA_DIR),
    workspaceRoot: path.resolve(env.AGENT_WORKSPACE_ROOT),
    codexHome: path.resolve(env.CODEX_HOME),
    codexBin: env.CODEX_BIN,
    codexSandboxMode: env.CODEX_SANDBOX_MODE,
    codexTimeoutMs: env.CODEX_TIMEOUT_MS,
    codexMaxOutputBytes: env.CODEX_MAX_OUTPUT_BYTES,
    runtimeProvider: env.RUNTIME_PROVIDER,
    containerEngine: env.CONTAINER_ENGINE,
    containerRuntimeImage: env.CONTAINER_RUNTIME_IMAGE,
    containerCpuLimit: env.CONTAINER_CPU_LIMIT,
    containerMemoryLimit: env.CONTAINER_MEMORY_LIMIT,
    containerPidsLimit: env.CONTAINER_PIDS_LIMIT,
    containerUser: env.CONTAINER_USER?.trim() || defaultContainerUser,
    runtimeInstanceId: env.RUNTIME_INSTANCE_ID,
    authToken,
    arkApiKey: env.ARK_API_KEY?.trim() ?? "",
    arkModel: env.ARK_MODEL?.trim() ?? "",
    arkBaseUrl: env.ARK_BASE_URL.replace(/\/+$/, ""),
    nodeEnv: env.NODE_ENV,

    aegisEnabled: env.AEGIS_ENABLED,
    aegisCaptureLevel: env.AEGIS_CAPTURE_LEVEL,
    aegisRetentionMaxEvents: env.AEGIS_RETENTION_MAX_EVENTS,
    aegisRetentionMaxAgeMs: env.AEGIS_RETENTION_MAX_AGE_MS,
    aegisMaxSteps: env.AEGIS_MAX_STEPS,
    aegisMaxConcurrentRuns: env.AEGIS_MAX_CONCURRENT_RUNS,
    aegisVaultPath: env.AEGIS_VAULT_PATH,
    aegisSeccompProfile: env.AEGIS_SECCOMP_PROFILE,
    aegisNetworkMode: env.AEGIS_NETWORK_MODE,
    aegisBrokerUrl: env.AEGIS_BROKER_URL,
    aegisBrokerPort: env.AEGIS_BROKER_PORT,
    aegisAgentBudgetUsd: env.AEGIS_AGENT_BUDGET_USD,
    aegisTenantBudgetUsd: env.AEGIS_TENANT_BUDGET_USD,
  };
}

export function isArkConfigured(config: AppConfig): boolean {
  return (
    config.arkApiKey.length > 0 &&
    !config.arkApiKey.startsWith("replace-") &&
    config.arkModel.length > 0 &&
    !config.arkModel.includes("replace-")
  );
}

/**
 * `baseUrlOverride` is how the hardened profile redirects Codex to the broker.
 * The container never learns the real upstream, which is the point: it cannot
 * reach a host it cannot name.
 */
export async function writeCodexConfig(
  config: AppConfig,
  baseUrlOverride?: string,
): Promise<void> {
  await mkdir(config.codexHome, { recursive: true });
  const toml = [
    "# Generated by Volc Agent Launchpad. Edit environment variables, not this file.",
    "model = " + JSON.stringify(config.arkModel || "ep-not-configured"),
    'model_provider = "volcengine_ark"',
    "",
    "[model_providers.volcengine_ark]",
    'name = "Volcengine Ark"',
    "base_url = " + JSON.stringify(baseUrlOverride ?? config.arkBaseUrl),
    'env_key = "ARK_API_KEY"',
    'wire_api = "responses"',
    "requires_openai_auth = false",
    "",
  ].join("\n");
  await writeFile(path.join(config.codexHome, "config.toml"), toml, {
    encoding: "utf8",
    mode: 0o600,
  });
}
