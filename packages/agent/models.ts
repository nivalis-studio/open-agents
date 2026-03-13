import {
  createGateway,
  defaultSettingsMiddleware,
  gateway as aiGateway,
  wrapLanguageModel,
  type GatewayModelId,
  type JSONValue,
  type LanguageModel,
} from "ai";
import { devToolsMiddleware } from "@ai-sdk/devtools";
import type { AnthropicLanguageModelOptions } from "@ai-sdk/anthropic";
import type { OpenAIResponsesProviderOptions } from "@ai-sdk/openai";
import { z } from "zod";

// Models with 4.5+ support adaptive thinking with effort control.
// Older models use the legacy extended thinking API with a budget.
function getAnthropicSettings(modelId: string): AnthropicLanguageModelOptions {
  if (modelId.includes("4.6")) {
    return {
      effort: "medium",
      thinking: { type: "adaptive" },
    } satisfies AnthropicLanguageModelOptions;
  }

  return {
    thinking: { type: "enabled", budgetTokens: 8000 },
  };
}

function isJsonObject(value: unknown): value is Record<string, JSONValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function toProviderOptionsRecord(
  options: Record<string, unknown>,
): Record<string, JSONValue> {
  return options as Record<string, JSONValue>;
}

function mergeRecords(
  base: Record<string, JSONValue>,
  override: Record<string, JSONValue>,
): Record<string, JSONValue> {
  const merged: Record<string, JSONValue> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const existingValue = merged[key];

    if (isJsonObject(existingValue) && isJsonObject(value)) {
      merged[key] = mergeRecords(existingValue, value);
      continue;
    }

    merged[key] = value;
  }

  return merged;
}

export type ProviderOptionsByProvider = Record<
  string,
  Record<string, JSONValue>
>;

export function mergeProviderOptions(
  defaults: ProviderOptionsByProvider,
  overrides?: ProviderOptionsByProvider,
): ProviderOptionsByProvider {
  if (!overrides || Object.keys(overrides).length === 0) {
    return defaults;
  }

  const merged: ProviderOptionsByProvider = { ...defaults };

  for (const [provider, providerOverrides] of Object.entries(overrides)) {
    const providerDefaults = merged[provider];

    if (!providerDefaults) {
      merged[provider] = providerOverrides;
      continue;
    }

    merged[provider] = mergeRecords(providerDefaults, providerOverrides);
  }

  return merged;
}

export interface GatewayConfig {
  baseURL: string;
  apiKey: string;
}

export interface GatewayOptions {
  devtools?: boolean;
  config?: GatewayConfig;
  providerOptionsOverrides?: ProviderOptionsByProvider;
}

const jsonValueSchema: z.ZodType<JSONValue> = z.lazy(() =>
  z.union([
    z.string(),
    z.number(),
    z.boolean(),
    z.null(),
    z.array(jsonValueSchema),
    z.record(z.string(), jsonValueSchema),
  ]),
);

export const gatewayConfigSchema = z.object({
  baseURL: z.string().url(),
  apiKey: z.string().min(1),
});

export const providerOptionsByProviderSchema = z.record(
  z.string(),
  z.record(z.string(), jsonValueSchema),
);

export const modelDescriptorSchema = z.object({
  modelId: z.string().min(1),
  gatewayConfig: gatewayConfigSchema.optional(),
  providerOptionsOverrides: providerOptionsByProviderSchema.optional(),
  devtools: z.boolean().optional(),
});

export type ModelDescriptor = z.infer<typeof modelDescriptorSchema>;

export function createModelDescriptor(
  modelId: string,
  options: {
    gatewayConfig?: GatewayConfig;
    providerOptionsOverrides?: ProviderOptionsByProvider;
    devtools?: boolean;
  } = {},
): ModelDescriptor {
  return {
    modelId,
    ...(options.gatewayConfig ? { gatewayConfig: options.gatewayConfig } : {}),
    ...(options.providerOptionsOverrides
      ? { providerOptionsOverrides: options.providerOptionsOverrides }
      : {}),
    ...(options.devtools !== undefined ? { devtools: options.devtools } : {}),
  };
}

export function shouldApplyOpenAIReasoningDefaults(modelId: string): boolean {
  return modelId.startsWith("openai/gpt-5");
}

export function gateway(
  modelId: GatewayModelId,
  options: GatewayOptions = {},
): LanguageModel {
  const { devtools = false, config, providerOptionsOverrides } = options;

  // Use custom gateway config or default AI SDK gateway
  const baseGateway = config
    ? createGateway({ baseURL: config.baseURL, apiKey: config.apiKey })
    : aiGateway;

  let model: LanguageModel = baseGateway(modelId);

  const defaultProviderOptions: ProviderOptionsByProvider = {};

  // Apply anthropic defaults
  if (modelId.startsWith("anthropic/")) {
    defaultProviderOptions.anthropic = toProviderOptionsRecord(
      getAnthropicSettings(modelId),
    );
  }

  // Apply OpenAI defaults for all GPT-5 variants to expose encrypted reasoning content.
  // This avoids Responses API failures when `store: false`, e.g.:
  // "Item with id 'rs_...' not found. Items are not persisted when `store` is set to false."
  if (shouldApplyOpenAIReasoningDefaults(modelId)) {
    defaultProviderOptions.openai = toProviderOptionsRecord({
      reasoningEffort: "high",
      reasoningSummary: "detailed",
      store: false,
      include: ["reasoning.encrypted_content"],
    } satisfies OpenAIResponsesProviderOptions);
  }

  const providerOptions = mergeProviderOptions(
    defaultProviderOptions,
    providerOptionsOverrides,
  );

  if (Object.keys(providerOptions).length > 0) {
    model = wrapLanguageModel({
      model,
      middleware: defaultSettingsMiddleware({
        settings: { providerOptions },
      }),
    });
  }

  // Apply devtools middleware if requested
  if (devtools) {
    model = wrapLanguageModel({ model, middleware: devToolsMiddleware() });
  }

  return model;
}

export function createLanguageModelFromDescriptor(
  descriptor: ModelDescriptor,
): LanguageModel {
  return gateway(descriptor.modelId as GatewayModelId, {
    ...(descriptor.devtools !== undefined
      ? { devtools: descriptor.devtools }
      : {}),
    ...(descriptor.gatewayConfig ? { config: descriptor.gatewayConfig } : {}),
    ...(descriptor.providerOptionsOverrides
      ? { providerOptionsOverrides: descriptor.providerOptionsOverrides }
      : {}),
  });
}
