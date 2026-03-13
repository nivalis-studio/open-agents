import type { Sandbox } from "@open-harness/sandbox";
import {
  stepCountIs,
  ToolLoopAgent,
  type LanguageModel,
  type ModelMessage,
  type StepResult,
  type TypedToolResult,
} from "ai";
import {
  DurableAgent,
  type CompatibleLanguageModel,
  type DurableAgentStreamOptions,
  type DurableAgentStreamResult,
} from "@workflow/ai/agent";
import { z } from "zod";
import { addCacheControl } from "./context-management";
import { aggressiveCompactContext } from "./context-management/aggressive-compaction";
import {
  createLanguageModelFromDescriptor,
  gateway,
  type ModelDescriptor,
} from "./models";
import { preparePromptForOpenAIReasoning } from "./openai-reasoning";
import type { SkillMetadata } from "./skills/types";
import { buildSystemPrompt } from "./system-prompt";
import { openHarnessTools } from "./toolset";
import {
  approvalConfigSchema,
  compactionContextSchema,
  type CompactionContext,
  type LiveAgentContext,
  serializableRuntimeContextSchema,
  type SerializableRuntimeContext,
  type TodoItem,
} from "./types";

const localCallOptionsSchema = z.object({
  sandbox: z.custom<Sandbox>(),
  approval: approvalConfigSchema,
  model: z.custom<LanguageModel>().optional(),
  subagentModel: z.custom<LanguageModel>().optional(),
  customInstructions: z.string().optional(),
  skills: z.custom<SkillMetadata[]>().optional(),
  context: compactionContextSchema.optional(),
});

export type OpenHarnessLocalCallOptions = z.infer<
  typeof localCallOptionsSchema
>;
export type OpenHarnessDurableCallOptions = z.infer<
  typeof serializableRuntimeContextSchema
>;

function getCompactionContextFromExperimentalContext(
  experimentalContext: unknown,
): CompactionContext | undefined {
  if (!experimentalContext || typeof experimentalContext !== "object") {
    return undefined;
  }

  const contextValue = (experimentalContext as { context?: unknown }).context;
  const parsed = compactionContextSchema.safeParse(contextValue);
  return parsed.success ? parsed.data : undefined;
}

const DEFAULT_CONTEXT_LIMIT = 200_000;

interface CompactionTuning {
  triggerPercent: number;
  minSavingsPercent: number;
  retainRecentToolCalls: number;
}

const DEFAULT_COMPACTION_TUNING: CompactionTuning = {
  triggerPercent: 0.58,
  minSavingsPercent: 0.03,
  retainRecentToolCalls: 32,
};

/**
 * Optional model-specific compaction tuning overrides.
 *
 * Keys support exact matches ("provider/model") and partial matches
 * (any substring of the full model id).
 */
const MODEL_COMPACTION_TUNING_OVERRIDES: Record<
  string,
  Partial<CompactionTuning>
> = {};

function getModelId(
  model: LanguageModel | ModelDescriptor | undefined,
): string | undefined {
  if (!model) {
    return undefined;
  }

  if (typeof model === "string") {
    return model;
  }

  if ("modelId" in model && typeof model.modelId === "string") {
    return model.modelId;
  }

  return undefined;
}

function resolveCompactionTuning(modelId: string): CompactionTuning {
  const exactMatch = MODEL_COMPACTION_TUNING_OVERRIDES[modelId];
  if (exactMatch) {
    return {
      ...DEFAULT_COMPACTION_TUNING,
      ...exactMatch,
    };
  }

  const partialMatch = Object.entries(MODEL_COMPACTION_TUNING_OVERRIDES).find(
    ([key]) => modelId.includes(key),
  );

  if (partialMatch?.[1]) {
    return {
      ...DEFAULT_COMPACTION_TUNING,
      ...partialMatch[1],
    };
  }

  return DEFAULT_COMPACTION_TUNING;
}

function buildOpenHarnessInstructions(options: {
  approvalType: LiveAgentContext["approval"]["type"];
  workingDirectory: string;
  currentBranch?: string;
  environmentDetails?: string;
  customInstructions?: string;
  skills?: SkillMetadata[];
  modelId?: string;
}): string {
  const mode =
    options.approvalType === "background" ? "background" : "interactive";

  return buildSystemPrompt({
    cwd: options.workingDirectory,
    mode,
    currentBranch: options.currentBranch,
    customInstructions: options.customInstructions,
    environmentDetails: options.environmentDetails,
    skills: options.skills ?? [],
    modelId: options.modelId,
  });
}

function prepareMessagesForOpenHarness<
  TStepResult extends StepResult<typeof openHarnessTools>,
>(options: {
  messages: ModelMessage[];
  model: LanguageModel;
  steps: TStepResult[];
  context?: CompactionContext;
}): ModelMessage[] {
  const preparedPrompt = preparePromptForOpenAIReasoning({
    model: options.model,
    messages: options.messages,
  });

  const compactionTuning = resolveCompactionTuning(
    getModelId(options.model) ?? defaultModelLabel,
  );

  return addCacheControl({
    messages: aggressiveCompactContext({
      messages: preparedPrompt.messages ?? options.messages,
      steps: options.steps,
      contextLimit: options.context?.contextLimit ?? DEFAULT_CONTEXT_LIMIT,
      lastInputTokens: options.context?.lastInputTokens,
      triggerPercent: compactionTuning.triggerPercent,
      minSavingsPercent: compactionTuning.minSavingsPercent,
      retainRecentToolCalls: compactionTuning.retainRecentToolCalls,
    }),
    model: options.model,
  });
}

export const defaultModelLabel = "anthropic/claude-haiku-4.5";
export const defaultModel = gateway(defaultModelLabel);

export function createOpenHarnessAgent() {
  return new ToolLoopAgent({
    model: defaultModel,
    instructions: buildSystemPrompt({}),
    tools: openHarnessTools,
    stopWhen: stepCountIs(200),
    callOptionsSchema: localCallOptionsSchema,
    prepareStep: ({ messages, model, steps, experimental_context }) => {
      const callContext =
        getCompactionContextFromExperimentalContext(experimental_context);

      return {
        messages: prepareMessagesForOpenHarness({
          messages,
          model,
          steps,
          context: callContext,
        }),
      };
    },
    prepareCall: ({ options, model, ...settings }) => {
      if (!options) {
        throw new Error(
          "Open Harness agent requires call options with sandbox and approval config.",
        );
      }

      const approval = options.approval;
      const callModel = options.model ?? model;
      const subagentModel = options.subagentModel;
      const customInstructions = options.customInstructions;
      const sandbox = options.sandbox;
      const skills = options.skills ?? [];
      const context = options.context;
      const preparedPrompt = preparePromptForOpenAIReasoning({
        model: callModel,
        messages: settings.messages,
        prompt: settings.prompt,
      });

      const instructions = buildOpenHarnessInstructions({
        approvalType: approval.type,
        workingDirectory: sandbox.workingDirectory,
        currentBranch: sandbox.currentBranch,
        environmentDetails: sandbox.environmentDetails,
        customInstructions,
        skills,
        modelId: getModelId(callModel),
      });

      return {
        ...settings,
        ...preparedPrompt,
        model: callModel,
        tools: addCacheControl({
          tools: settings.tools ?? openHarnessTools,
          model: callModel,
        }),
        instructions,
        experimental_context: {
          sandbox,
          approval,
          skills,
          model: callModel,
          subagentModel,
          customInstructions,
          context,
        } satisfies LiveAgentContext,
      };
    },
  });
}

export interface OpenHarnessDurableAgent {
  tools: typeof openHarnessTools;
  stream(
    options: Omit<
      DurableAgentStreamOptions<typeof openHarnessTools>,
      "experimental_context" | "maxSteps" | "prepareStep"
    >,
  ): Promise<DurableAgentStreamResult<typeof openHarnessTools>>;
}

export function createOpenHarnessDurableAgent(
  runtimeContext: SerializableRuntimeContext,
): OpenHarnessDurableAgent {
  const model = createLanguageModelFromDescriptor(runtimeContext.model);
  const instructions = buildOpenHarnessInstructions({
    approvalType: runtimeContext.approval.type,
    workingDirectory: runtimeContext.workingDirectory,
    currentBranch: runtimeContext.currentBranch,
    environmentDetails: runtimeContext.environmentDetails,
    customInstructions: runtimeContext.customInstructions,
    skills: runtimeContext.skills,
    modelId: runtimeContext.model.modelId,
  });

  const durableAgent = new DurableAgent({
    model: async () => model as CompatibleLanguageModel,
    tools: addCacheControl({ tools: openHarnessTools, model }),
    system: instructions,
  });

  return {
    tools: openHarnessTools,
    stream: (options) =>
      durableAgent.stream({
        ...options,
        maxSteps: 200,
        experimental_context: runtimeContext,
        prepareStep: ({ messages, steps, experimental_context }) => {
          const context = serializableRuntimeContextSchema.parse(
            experimental_context ?? runtimeContext,
          );
          const stepModel = createLanguageModelFromDescriptor(context.model);
          const preparedMessages = prepareMessagesForOpenHarness({
            messages: messages as unknown as ModelMessage[],
            model: stepModel,
            steps: steps as StepResult<typeof openHarnessTools>[],
            context: context.context,
          });

          return {
            model: async () => stepModel as CompatibleLanguageModel,
            messages: preparedMessages as unknown as typeof messages,
            experimental_context: context,
          };
        },
      }),
  };
}

export function extractTodosFromStep(
  toolResults: Array<TypedToolResult<typeof openHarnessTools>>,
): TodoItem[] | null {
  for (const result of toolResults) {
    if (!result.dynamic && result.toolName === "todo_write" && result.output) {
      return result.output.todos;
    }
  }
  return null;
}
