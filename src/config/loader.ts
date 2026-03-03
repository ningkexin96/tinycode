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
    const parsed = configSchema.safeParse(JSON.parse(raw));
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
