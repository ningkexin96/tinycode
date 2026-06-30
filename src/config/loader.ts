import { readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { configSchema, type TinyCodeConfig } from "./schema.js";

/**
 * User-level data home. Tests redirect it with TINYCODE_HOME so nothing is
 * ever written outside the project directory during development or CI.
 */
export function dataHome(): string {
  return process.env.TINYCODE_HOME || path.join(os.homedir(), ".tinycode");
}

export function sessionsDir(): string {
  return path.join(dataHome(), "sessions");
}

/** Project-level TinyCode dir (memory, skills, config live here). */
export function projectTinyDir(projectRoot: string): string {
  return path.join(projectRoot, ".tinycode");
}

function parseModelRef(ref: string): { provider?: string; model?: string } {
  const idx = ref.indexOf("/");
  if (idx === -1) return { model: ref };
  return {
    provider: ref.slice(0, idx),
    model: ref.slice(idx + 1),
  };
}

/**
 * Defense against the classic accident: pasting an API key into config.json
 * (which is safe to commit) and pushing it. Unknown to the schema by design —
 * keys come from environment variables — so any secret-looking field is a mistake.
 */
const SECRET_FIELD_RE = /^(.*(?:api[_-]?key|apikey|secret|token|password|credential).*|sk-.*)$/i;

function findSecretLikeFields(value: unknown, prefix = ""): string[] {
  const hits: string[] = [];
  if (Array.isArray(value)) return hits;
  if (value !== null && typeof value === "object") {
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      const field = prefix ? `${prefix}.${key}` : key;
      if (SECRET_FIELD_RE.test(key) || (typeof nested === "string" && /^sk-[A-Za-z0-9]/.test(nested))) {
        hits.push(field);
      } else {
        hits.push(...findSecretLikeFields(nested, field));
      }
    }
  }
  return hits;
}

export interface LoadedConfig {
  config: TinyCodeConfig;
  /** Non-fatal problems: unreadable file, schema violations of unknown shape. */
  warnings: string[];
}

/**
 * Load `.tinycode/config.json` from the project root and apply environment
 * overrides. Environment wins over file; CLI flags win over both (applied by
 * the caller on the returned object).
 */
export function loadConfig(projectRoot: string): LoadedConfig {
  const warnings: string[] = [];
  let config: TinyCodeConfig = {};

  const file = path.join(projectRoot, ".tinycode", "config.json");
  try {
    const raw = readFileSync(file, "utf8");
    const json: unknown = JSON.parse(raw);
    const secretFields = findSecretLikeFields(json);
    if (secretFields.length > 0) {
      warnings.push(
        `${file} contains field(s) ${secretFields.map((f) => `"${f}"`).join(", ")} that look like API keys. ` +
          `Keys are read from environment variables only; this file may be committed — remove secrets from it.`,
      );
    }
    const parsed = configSchema.safeParse(json);
    if (parsed.success) {
      config = parsed.data;
    } else {
      warnings.push(
        `Invalid ${file}: ${parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ")}`,
      );
    }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== "ENOENT") {
      warnings.push(`Failed to read ${file}: ${(error as Error).message}`);
    }
  }

  // Environment overrides.
  const envModel = process.env.TINYCODE_MODEL;
  if (envModel && envModel !== "mock") {
    const ref = parseModelRef(envModel);
    config = { ...config, provider: ref.provider ?? config.provider, model: ref.model ?? config.model };
  }
  const permMode = process.env.TINYCODE_PERMISSION_MODE;
  if (permMode === "ask" || permMode === "auto") {
    config = { ...config, permissionMode: permMode };
  }

  return { config, warnings };
}
