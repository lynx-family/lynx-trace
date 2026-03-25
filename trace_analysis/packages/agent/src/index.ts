// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { RunnableConfig } from '@langchain/core/runnables';
import { TraceQuery } from '@lynx-js/trace-query';
import { BaseMessage, HumanMessage } from 'langchain';
import { v4 as uuidv4 } from 'uuid';

import { Agent } from './agent';
import { prompt as trace_analysis_prompt } from './prompts/trace_analysis';
import { AgentContext, Language } from './types/context';
import { MODEL_CONFIG_SCHEMA, ModelConfig } from './types/model_config';
import { ProgressReporter } from './types/progress';
import { AgentExecution } from './types/result';

async function TraceAnalysis(
  tracePath: string | string[],
  modelConfig?: ModelConfig,
  language?: Language,
  reporter?: ProgressReporter,
  userPrompt?: string,
): Promise<AgentExecution> {
  if (!modelConfig) {
    throw new Error(
      'modelConfig is required. Please provide model configuration with model, apiKey, provider, and baseUrl.',
    );
  }

  const requiredFields: (keyof ModelConfig)[] = ['model', 'apiKey', 'provider', 'baseUrl'];
  const missingFields = requiredFields.filter((field) => !modelConfig[field]);

  if (missingFields.length > 0) {
    throw new Error(`modelConfig is missing required fields: ${missingFields.join(', ')}`);
  }

  const parseResult = MODEL_CONFIG_SCHEMA.safeParse(modelConfig);
  if (!parseResult.success) {
    throw new Error(`Invalid modelConfig: ${parseResult.error.message}`);
  }

  language = language || 'English';
  const context: AgentContext = {
    modelConfig: modelConfig,
    language: language,
    agentName: trace_analysis_prompt.name,
    agentId: uuidv4(),
    depth: 0,
  };
  const traceQuerys: TraceQuery[] = [];
  tracePath = Array.isArray(tracePath) ? tracePath : [tracePath];
  try {
    if (Array.isArray(tracePath)) {
      await Promise.all(
        tracePath.map(async (path) => {
          const traceQuery = new TraceQuery();
          await traceQuery.initProcessor(path);
          traceQuerys.push(traceQuery);
        }),
      );
    }
    const config: RunnableConfig = {
      configurable: {
        traceQuerys: traceQuerys,
        reporter: reporter,
      },
    };
    const initMessages: BaseMessage[] = [];
    const systemPrompt = `${trace_analysis_prompt.prompt}\n\nOutput Language: ${language}`;
    if (userPrompt) {
      initMessages.push(new HumanMessage({ content: `User Query: ${userPrompt}` }));
    }
    initMessages.push(new HumanMessage({ content: 'trace: ' + tracePath.join(', ') }));
    const agent = new Agent(trace_analysis_prompt.name, systemPrompt, context, trace_analysis_prompt.tools ?? []);
    const result = await agent.invoke(initMessages, config);
    const agentId = context.agentId;
    if (result.success) {
      await reporter?.report({
        type: 'finish',
        agentId,
        agentName: context.agentName,
        details: {
          result: result.result,
        },
      });
    } else {
      await reporter?.report({
        type: 'error',
        agentId,
        agentName: context.agentName,
        details: {
          errorMessage: result.errorMessage,
        },
      });
    }
    return result;
  } catch (error) {
    return {
      success: false,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  } finally {
    try {
      await Promise.all(traceQuerys.map((traceQuery) => traceQuery.destroyProcessor()));
    } catch (error) {
      console.error(`Error destroying trace query processor: ${error}`);
    }
  }
}

export { TraceAnalysis, ModelConfig, Language, ProgressReporter, AgentExecution };
