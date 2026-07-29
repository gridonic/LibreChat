import { ChatGenerationChunk } from '@langchain/core/outputs';
import { FakeListChatModel } from '@langchain/core/utils/testing';
import { AIMessage, AIMessageChunk } from '@librechat/agents/langchain/messages';
import { Run, Constants, Providers, GraphEvents, StandardGraph } from '@librechat/agents';
import type { CallbackManagerForLLMRun } from '@langchain/core/callbacks/manager';
import type { AgentInputs, GenericTool, IState, LCTool } from '@librechat/agents';
import type { BaseMessage } from '@langchain/core/messages';

interface ForwarderCallback {
  handleCustomEvent?: (eventName: string, data: unknown, runId: string) => Promise<void> | void;
}

interface WorkflowOptions {
  callbacks?: ForwarderCallback[];
  configurable?: Record<string, unknown>;
}

interface ToolExecuteRequest {
  toolCalls: Array<{ id: string; name: string }>;
  resolve: (results: ToolExecuteResult[]) => void;
  reject: (error: Error) => void;
}

interface ToolExecuteResult {
  toolCallId: string;
  status: 'success';
  content: string;
}

function findSubagentTool(graph: StandardGraph): GenericTool {
  const context = [...graph.agentContexts.values()][0];
  const tool = context?.graphTools?.find(
    (candidate: GenericTool) => 'name' in candidate && candidate.name === Constants.SUBAGENT,
  );

  if (!tool) {
    throw new Error('Expected subagent tool');
  }

  return tool;
}

describe('nested event-driven tool execution', () => {
  it('forwards an Engine -> Router -> Specialist tool request to the host handler', async () => {
    const originalCreateWorkflow = StandardGraph.prototype.createWorkflow;
    let leafToolDefinitions: string[] = [];
    let forwardedResults: ToolExecuteResult[] = [];

    const createWorkflowSpy = jest
      .spyOn(StandardGraph.prototype, 'createWorkflow')
      .mockImplementation(function (this: StandardGraph) {
        const nestedDepth = this.runId?.split('_sub_').length ?? 1;

        if (nestedDepth === 2) {
          originalCreateWorkflow.call(this);
          const nestedSubagentTool = findSubagentTool(this);

          return {
            invoke: jest.fn(async (_state, options: WorkflowOptions) => {
              await nestedSubagentTool.invoke(
                {
                  description: 'Use the source-specific tool.',
                  subagent_type: 'specialist',
                },
                { configurable: options.configurable },
              );
              return { messages: [new AIMessage('router done')] };
            }),
          } as unknown as ReturnType<StandardGraph['createWorkflow']>;
        }

        if (nestedDepth === 3) {
          const context = [...this.agentContexts.values()][0];
          leafToolDefinitions =
            context?.toolDefinitions?.map((definition: LCTool) => definition.name) ?? [];

          return {
            invoke: jest.fn(async (_state, options: WorkflowOptions) => {
              const forwarder = options.callbacks?.find(
                (callback) => typeof callback.handleCustomEvent === 'function',
              );
              if (!forwarder?.handleCustomEvent) {
                throw new Error('Nested specialist has no host tool-execution forwarder');
              }

              forwardedResults = await new Promise<ToolExecuteResult[]>((resolve, reject) => {
                const request: ToolExecuteRequest = {
                  toolCalls: [{ id: 'call_nested_tool', name: 'mcp_lookup' }],
                  resolve,
                  reject,
                };
                void forwarder.handleCustomEvent?.(
                  GraphEvents.ON_TOOL_EXECUTE,
                  request,
                  this.runId ?? 'nested-specialist',
                );
              });

              return { messages: [new AIMessage('specialist done')] };
            }),
          } as unknown as ReturnType<StandardGraph['createWorkflow']>;
        }

        return originalCreateWorkflow.call(this);
      });

    const specialist: AgentInputs = {
      agentId: 'specialist',
      provider: Providers.OPENAI,
      clientOptions: { modelName: 'gpt-4o-mini', apiKey: 'test-key' },
      instructions: 'Use the configured source tool.',
      toolDefinitions: [{ name: 'mcp_lookup', description: 'Look up source data.' }],
    };
    const router: AgentInputs = {
      agentId: 'router',
      provider: Providers.OPENAI,
      clientOptions: { modelName: 'gpt-4o-mini', apiKey: 'test-key' },
      instructions: 'Delegate source work.',
      maxSubagentDepth: 4,
      subagentConfigs: [
        {
          type: 'specialist',
          name: 'Specialist',
          description: 'Source specialist',
          agentInputs: specialist,
        },
      ],
    };
    const engine: AgentInputs = {
      agentId: 'engine',
      provider: Providers.OPENAI,
      clientOptions: { modelName: 'gpt-4o-mini', apiKey: 'test-key' },
      instructions: 'Delegate to the router.',
      maxSubagentDepth: 5,
      subagentConfigs: [
        {
          type: 'router',
          name: 'Router',
          description: 'System router',
          allowNested: true,
          agentInputs: router,
        },
      ],
    };

    try {
      const run = await Run.create<IState>({
        runId: `nested-tools-${Date.now()}`,
        graphConfig: { type: 'standard', agents: [engine] },
        customHandlers: {
          [GraphEvents.ON_TOOL_EXECUTE]: {
            handle: async (_event: string, rawData: unknown): Promise<void> => {
              const request = rawData as ToolExecuteRequest;
              request.resolve(
                request.toolCalls.map((toolCall) => ({
                  toolCallId: toolCall.id,
                  status: 'success',
                  content: `ran ${toolCall.name}`,
                })),
              );
            },
          },
        },
        returnContent: true,
        skipCleanup: true,
      });

      const rootSubagentTool = findSubagentTool(run.Graph as StandardGraph);
      await rootSubagentTool.invoke(
        { description: 'Use the nested source.', subagent_type: 'router' },
        { configurable: { thread_id: 'nested-tools-test' } },
      );

      expect(leafToolDefinitions).toContain('mcp_lookup');
      expect(forwardedResults).toEqual([
        {
          toolCallId: 'call_nested_tool',
          status: 'success',
          content: 'ran mcp_lookup',
        },
      ]);
    } finally {
      createWorkflowSpy.mockRestore();
    }
  });

  it('activates a deferred event-driven tool discovered inside an isolated specialist', async () => {
    const originalCreateWorkflow = StandardGraph.prototype.createWorkflow;
    const deferredToolName = 'deferred_write_mcp_test';
    const boundToolsByTurn: string[][] = [];
    const executedTools: string[] = [];

    class DeferredDiscoveryModel extends FakeListChatModel {
      constructor(private readonly graph: StandardGraph) {
        super({ responses: [''] });
      }

      override async *_streamResponseChunks(
        _messages: BaseMessage[],
        _options: this['ParsedCallOptions'],
        _runManager?: CallbackManagerForLLMRun,
      ): AsyncGenerator<ChatGenerationChunk> {
        const context = [...this.graph.agentContexts.values()][0];
        const boundNames =
          context
            ?.getToolsForBinding()
            ?.flatMap((tool: GenericTool) =>
              'name' in tool && typeof tool.name === 'string' ? [tool.name] : [],
            ) ?? [];
        boundToolsByTurn.push(boundNames);

        const callIndex = boundToolsByTurn.length;
        if (callIndex <= 2) {
          const name = callIndex === 1 ? Constants.TOOL_SEARCH : deferredToolName;
          const id = callIndex === 1 ? 'call_search' : 'call_deferred_write';
          const args =
            callIndex === 1
              ? { query: 'save report', mcp_server: 'test', max_results: 5 }
              : { dryRun: true };
          const argsJson = JSON.stringify(args);
          yield new ChatGenerationChunk({
            text: '',
            generationInfo: {},
            message: new AIMessageChunk({
              content: '',
              tool_call_chunks: [
                {
                  name,
                  args: argsJson,
                  id,
                  index: 0,
                  type: 'tool_call_chunk',
                },
              ],
              additional_kwargs: {
                tool_calls: [
                  {
                    index: 0,
                    id,
                    type: 'function',
                    function: { name, arguments: argsJson },
                  },
                ],
              },
            }),
          });
          return;
        }

        yield new ChatGenerationChunk({
          text: 'saved',
          generationInfo: {},
          message: new AIMessageChunk({ content: 'saved' }),
        });
      }
    }

    const createWorkflowSpy = jest
      .spyOn(StandardGraph.prototype, 'createWorkflow')
      .mockImplementation(function (this: StandardGraph) {
        const nestedDepth = this.runId?.split('_sub_').length ?? 1;
        if (nestedDepth === 2) {
          this.overrideModel = new DeferredDiscoveryModel(this);
        }
        return originalCreateWorkflow.call(this);
      });

    const specialist: AgentInputs = {
      agentId: 'deferred-specialist',
      provider: Providers.OPENAI,
      clientOptions: { modelName: 'gpt-4o-mini', apiKey: 'test-key' },
      instructions: 'Search for the deferred write tool, then execute its dry run.',
      toolDefinitions: [
        {
          name: Constants.TOOL_SEARCH,
          description: 'Search deferred tools.',
          parameters: { type: 'object', properties: { query: { type: 'string' } } },
        },
        {
          name: deferredToolName,
          description: 'Save a report without mutation when dryRun is true.',
          parameters: {
            type: 'object',
            properties: { dryRun: { type: 'boolean' } },
            required: ['dryRun'],
          },
          defer_loading: true,
        },
      ],
      toolRegistry: new Map([
        [Constants.TOOL_SEARCH, { name: Constants.TOOL_SEARCH }],
        [
          deferredToolName,
          {
            name: deferredToolName,
            description: 'Save a report without mutation when dryRun is true.',
            parameters: {
              type: 'object',
              properties: { dryRun: { type: 'boolean' } },
              required: ['dryRun'],
            },
            defer_loading: true,
          },
        ],
      ]),
    };
    const engine: AgentInputs = {
      agentId: 'deferred-engine',
      provider: Providers.OPENAI,
      clientOptions: { modelName: 'gpt-4o-mini', apiKey: 'test-key' },
      instructions: 'Delegate the save task.',
      maxSubagentDepth: 2,
      subagentConfigs: [
        {
          type: 'deferred-specialist',
          name: 'Deferred Specialist',
          description: 'Discovers and executes deferred tools.',
          agentInputs: specialist,
        },
      ],
    };

    try {
      const run = await Run.create<IState>({
        runId: `nested-deferred-tools-${Date.now()}`,
        graphConfig: { type: 'standard', agents: [engine] },
        customHandlers: {
          [GraphEvents.ON_TOOL_EXECUTE]: {
            handle: async (_event: string, rawData: unknown): Promise<void> => {
              const request = rawData as ToolExecuteRequest & {
                toolCalls: Array<{ id: string; name: string }>;
                resolve: (results: Array<ToolExecuteResult & { artifact?: unknown }>) => void;
              };
              const results = request.toolCalls.map((toolCall) => {
                executedTools.push(toolCall.name);
                if (toolCall.name === Constants.TOOL_SEARCH) {
                  return {
                    toolCallId: toolCall.id,
                    status: 'success' as const,
                    content: JSON.stringify({
                      found: 1,
                      tools: [{ name: deferredToolName }],
                    }),
                    artifact: {
                      tool_references: [{ tool_name: deferredToolName }],
                    },
                  };
                }
                return {
                  toolCallId: toolCall.id,
                  status: 'success' as const,
                  content: JSON.stringify({ ok: true, dryRun: true }),
                };
              });
              request.resolve(results);
            },
          },
        },
        returnContent: true,
        skipCleanup: true,
      });

      const rootSubagentTool = findSubagentTool(run.Graph as StandardGraph);
      await rootSubagentTool.invoke(
        {
          description: 'Find the deferred report writer and run it without mutation.',
          subagent_type: 'deferred-specialist',
        },
        { configurable: { thread_id: 'nested-deferred-tools-test' } },
      );

      expect(boundToolsByTurn[0]).toContain(Constants.TOOL_SEARCH);
      expect(boundToolsByTurn[0]).not.toContain(deferredToolName);
      expect(boundToolsByTurn[1]).toContain(deferredToolName);
      expect(executedTools).toEqual([Constants.TOOL_SEARCH, deferredToolName]);
    } finally {
      createWorkflowSpy.mockRestore();
    }
  });
});
