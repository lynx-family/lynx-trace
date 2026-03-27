// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { ChatAnthropic } from '@langchain/anthropic';
import { BaseChatModel } from '@langchain/core/language_models/chat_models';
import { RunnableConfig } from '@langchain/core/runnables';
import { ClientTool } from '@langchain/core/tools';
import { ChatGoogleGenerativeAI } from '@langchain/google-genai';
import { ChatOpenAI } from '@langchain/openai';
import { BaseMessage, createAgent, summarizationMiddleware } from 'langchain';

import { createLoggerMiddleware } from './middlewares/log';
import { createSkillMiddleware } from './middlewares/skill';
import { summaryPrompt } from './prompts/summary';
import { skillTool } from './tools/skill';
import { trace_query_tools } from './tools/trace_query';
import { AGENT_CONTEXT_SCHEMA, AgentContext } from './types/context';
import { AgentExecution } from './types/result';

const tool_map = new Map<string, ClientTool>([
  ...trace_query_tools.map((tool) => [tool.name, tool] as [string, ClientTool]),
  [skillTool.name, skillTool],
]);

export class Agent {
  private tools: ClientTool[];
  private model: BaseChatModel;
  constructor(
    private readonly name: string,
    private readonly systemPrompt: string,
    private readonly context: AgentContext,
    tools: string[],
  ) {
    this.model = this.createModel();
    this.tools = tools.map((tool) => tool_map.get(tool)).filter((tool) => tool !== undefined);
  }

  get agentName(): string {
    return this.name;
  }

  /**
   * Execute the agent with the given task.
   */
  async invoke(initMessages: BaseMessage[], config: RunnableConfig): Promise<AgentExecution> {
    // Create a LangChain agent with logging middleware
    const agent = createAgent({
      model: this.model,
      tools: this.tools,
      systemPrompt: this.systemPrompt,
      middleware: [
        createSkillMiddleware(),
        summarizationMiddleware({
          model: this.model,
          trigger: [{ tokens: 1024 * 8 }], // 8 KB
          keep: { messages: 0 },
          trimTokensToSummarize: 128 * 1024,
          summaryPrefix: 'Continue the analysis based on the existing progress. The analysis progress is:',
          summaryPrompt,
        }),
        createLoggerMiddleware((config.configurable as any)?.reporter),
      ],
      contextSchema: AGENT_CONTEXT_SCHEMA,
    });
    try {
      const result = await agent.invoke(
        {
          messages: initMessages,
        },
        {
          context: this.context,
          configurable: {
            ...config.configurable,
          },
          recursionLimit: 100,
        },
      );

      let output = '';
      if (result.messages && result.messages.length > 0) {
        const lastMessage = result.messages[result.messages.length - 1];
        if (lastMessage) {
          output = typeof lastMessage.content === 'string' ? lastMessage.content : JSON.stringify(lastMessage.content);
        }
      }
      return {
        success: true,
        result: output,
      };
    } catch (error: any) {
      return {
        success: false,
        errorMessage: error.message,
      };
    }
  }

  private createModel(): BaseChatModel {
    const provider = this.context.modelConfig.provider.toLowerCase();
    const apiKey = this.context.modelConfig.apiKey;
    const baseUrl = this.context.modelConfig.baseUrl;
    const modelName = this.context.modelConfig.model;

    if (provider === 'openai' || provider === 'doubao') {
      // Doubao is compatible with OpenAI
      return new ChatOpenAI({
        model: modelName,
        apiKey: apiKey,
        configuration: {
          baseURL: baseUrl,
        },
        maxRetries: this.context.modelConfig.maxRetries,
      });
    } else if (provider === 'anthropic') {
      return new ChatAnthropic({
        modelName: modelName,
        apiKey: apiKey,
        clientOptions: {
          baseURL: baseUrl || undefined,
        },
        maxRetries: this.context.modelConfig.maxRetries,
      });
    } else if (provider === 'google') {
      return new ChatGoogleGenerativeAI({
        model: modelName,
        apiKey: apiKey,
        temperature: 0,
        baseUrl: baseUrl,
        maxRetries: this.context.modelConfig.maxRetries,
      });
    }

    throw new Error(`Unsupported model provider: ${provider}`);
  }
}
