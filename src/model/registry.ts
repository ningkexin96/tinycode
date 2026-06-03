import type { StreamFn } from "@earendil-works/pi-agent-core";
import { builtinModels } from "@earendil-works/pi-ai/providers/all";
import {
  fauxAssistantMessage,
  fauxProvider,
  type FauxProviderHandle,
  type Model,
  type MutableModels,
} from "@earendil-works/pi-ai";

export class ModelNotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelNotConfiguredError";
  }
}

export interface ModelRef {
  provider?: string;
  model?: string;
}

/**
 * ModelRegistry owns the pi-ai provider collection.
 *
 * Real usage registers every built-in provider (auth comes from environment
 * variables such as ANTHROPIC_API_KEY). Tests and `--mock` mode additionally
 * register the deterministic faux provider so the full agent loop runs
 * without any network access.
 */
export class ModelRegistry {
  readonly models: MutableModels;
  private mock?: FauxProviderHandle;
  private outputCap?: number;

  constructor() {
    this.models = builtinModels();
  }

  /**
   * Cap per-request max_tokens regardless of the model catalog value.
   * Useful with prepaid credit limits (e.g. OpenRouter 402 preflight).
   */
  setMaxOutputTokens(cap: number | undefined): void {
    this.outputCap = cap;
  }

  /** Register a scripted offline provider and return its model. */
  enableMock(): Model<string> {
    if (!this.mock) {
      this.mock = fauxProvider({
        provider: "mock",
        models: [{ id: "tinycode-mock", name: "TinyCode Mock" }],
      });
      this.models.setProvider(this.mock.provider);
    }
    // Default reply so one-shot CLI runs (`-p`) produce useful output without
    // scripting; tests override this via setResponses.
    this.mock.setResponses([
      fauxAssistantMessage(
        "[TinyCode mock model] No real provider is configured. Set ANTHROPIC_API_KEY / OPENAI_API_KEY " +
          "or choose a model in .tinycode/config.json to talk to a real LLM.",
      ),
    ]);
    return this.mock.getModel();
  }

  get mockHandle(): FauxProviderHandle | undefined {
    return this.mock;
  }

  /**
   * Resolve a concrete model from an optional provider/model pair.
   * Priority: explicit ref > first auth-configured model.
   * Throws ModelNotConfiguredError with actionable guidance when nothing is usable.
   */
  async resolve(ref?: ModelRef): Promise<Model<any>> {
    const wantsMock = ref?.provider === "mock";
    if (this.mock && (wantsMock || (!ref?.provider && !ref?.model))) {
      return this.mock.getModel();
    }

    if (ref?.provider && ref?.model) {
      const found = this.models.getModel(ref.provider, ref.model);
      if (!found) {
        throw new ModelNotConfiguredError(
          `Unknown model "${ref.provider}/${ref.model}". ` +
            `Run \`tinycode --list-models\` or check .tinycode/config.json.`,
        );
      }
      return found;
    }

    if (ref?.model) {
      for (const candidate of this.models.getModels()) {
        if (candidate.id === ref.model) return candidate;
      }
      throw new ModelNotConfiguredError(`Unknown model id "${ref.model}" in any registered provider.`);
    }

    // No preference: pick the first available model from a configured provider.
    const available = ref?.provider
      ? await this.models.getAvailable(ref.provider)
      : await this.models.getAvailable();
    const first = available[0];
    if (first) return first;

    throw new ModelNotConfiguredError(
      "No API key found for any supported provider.\n" +
        "Set one of ANTHROPIC_API_KEY, OPENAI_API_KEY, GROQ_API_KEY, ... in your environment,\n" +
        `or set {"provider": "...", "model": "..."} in .tinycode/config.json,\n` +
        `or run with a scripted offline model via TINYCODE_MODEL=mock.`,
    );
  }

  /** Stream function handed to the pi Agent runtime. */
  readonly streamFn: StreamFn = (model, context, options) => {
    const requested = options?.maxTokens ?? (model as { maxTokens?: number }).maxTokens;
    const maxTokens =
      this.outputCap !== undefined && requested !== undefined
        ? Math.min(requested, this.outputCap)
        : requested;
    return this.models.streamSimple(model, context, { ...options, ...(maxTokens !== undefined ? { maxTokens } : {}) });
  };

  listCatalog(provider?: string): Model<any>[] {
    return [...this.models.getModels(provider)];
  }

  async availableWithAuth(): Promise<Model<any>[]> {
    return [...(await this.models.getAvailable())];
  }
}
