// Copyright 2026 The Lynx Authors. All rights reserved.
// Licensed under the Apache License Version 2.0 that can be found in the
// LICENSE file in the root directory of this source tree.

import { isCommand } from '@langchain/langgraph';
import { createMiddleware, ToolMessage } from 'langchain';

import { AGENT_CONTEXT_SCHEMA } from '../types/context';
import { ProgressReporter } from '../types/progress';

export const createLoggerMiddleware = (reporter?: ProgressReporter) => {
  return createMiddleware({
    name: 'LoggerMiddleware',
    contextSchema: AGENT_CONTEXT_SCHEMA,
    beforeAgent: async (state, config) => {
      const context = config.context;
      const agentName = context.agentName;
      const agentId = context.agentId;
      const parentAgentId = context.parentAgentId;
      const initMessages = state.messages.map((m) => ({ role: m.type, content: m.content }));

      try {
        await reporter?.report({
          type: 'agent_start',
          agentId,
          parentAgentId,
          agentName,
          details: {
            initialMessages: initMessages,
          },
        });
      } catch (error) {
        console.error(`Error reporting agent start event: ${error}`);
      }

      return;
    },
    afterAgent: async (state, config) => {
      const agentName = config.context.agentName;
      const agentId = config.context.agentId;
      const lastMessage = state.messages[state.messages.length - 1];

      try {
        await reporter?.report({
          type: 'agent_end',
          agentId,
          agentName,
          details: {
            result: lastMessage?.content,
          },
        });
      } catch (error) {
        console.error(`Error reporting agent end event: ${error}`);
      }

      return;
    },
    wrapToolCall: async (request, handler) => {
      const agentId = request.runtime.context.agentId;
      const toolName = request.toolCall.name;
      try {
        const result = await handler(request);
        try {
          const toolMessages: ToolMessage[] = [];
          if (Array.isArray(result)) {
            toolMessages.push(...result.filter((msg) => ToolMessage.isInstance(msg)));
          } else if (ToolMessage.isInstance(result)) {
            toolMessages.push(result);
          } else if (
            isCommand(result) &&
            result.update &&
            typeof result.update === 'object' &&
            'messages' in result.update &&
            Array.isArray((result.update as any).messages)
          ) {
            toolMessages.push(...(result.update as any).messages.filter((msg: any) => ToolMessage.isInstance(msg)));
          }
          const resultContent = toolMessages.map((msg) => msg.content.toString()).join('\n');
          await reporter?.report({
            type: 'tool_call',
            agentId,
            parentAgentId: request.runtime.context.parentAgentId,
            agentName: request.runtime.context.agentName,
            details: {
              args: isCommand(result) ? {} : request.toolCall.args,
              result: resultContent,
              toolName,
            },
          });
        } catch (reportError) {
          console.error(`Error reporting tool call event: ${reportError}`);
        }
        return result;
      } catch (error) {
        try {
          await reporter?.report({
            type: 'tool_call',
            agentId,
            parentAgentId: request.runtime.context.parentAgentId,
            agentName: request.runtime.context.agentName,
            details: {
              args: request.toolCall.args,
              error: error instanceof Error ? error.message : String(error),
              toolName,
            },
          });
        } catch (reportError) {
          console.error(`Error reporting tool error event: ${reportError}`);
        }
        throw error;
      }
    },
    wrapModelCall: async (request, handler) => {
      const agentId = request.runtime.context.agentId;
      try {
        const result = await handler(request);
        return result;
      } catch (error) {
        console.error(`Model execution error: ${error}`);

        try {
          await reporter?.report({
            type: 'error',
            agentId,
            agentName: request.runtime.context.agentName,
            details: {
              errorMessage: error instanceof Error ? error.message : String(error),
            },
          });
        } catch (reportError) {
          console.error(`Error reporting model error event: ${reportError}`);
        }

        throw error;
      }
    },
    afterModel: async (state, config) => {
      const agentId = config.context.agentId;
      const messages = state.messages;
      const summaryMessage = messages.filter((m) => (m.additional_kwargs as any)?.lc_source === 'summarization');

      try {
        if (summaryMessage.length > 0) {
          const msg = summaryMessage[0];
          if (msg) {
            await reporter?.report({
              type: 'summary',
              agentId,
              agentName: config.context.agentName,
              details: {
                summaryMessage: msg.content.toString(),
              },
            });
          }
        }
      } catch (error) {
        console.error(`Error reporting model call event: ${error}`);
      }
    },
  });
};
