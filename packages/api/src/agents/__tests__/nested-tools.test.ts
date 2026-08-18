import { Run, Constants, Providers, GraphEvents, StandardGraph } from '@librechat/agents';
import { AIMessage } from '@librechat/agents/langchain/messages';

import type { AgentInputs, GenericTool, IState, LCTool } from '@librechat/agents';

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
});
