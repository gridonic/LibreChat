const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { test } = require('node:test');
const { applyPatch } = require('./apply-agents-patch.cjs');
const patch = require('../patches/agents-4.0.1-mcp-recovery.json');
const sdk = require('@librechat/agents');
const { HumanMessage, ToolMessage } = require('@langchain/core/messages');

const secret = 'private-token-and-provider-payload';
const config = {
  type: 'reviewer',
  name: 'Reviewer',
  description: 'Review code.',
  configId: 'reviewer@v1',
  resolveAgentInputs: async () => {
    throw new Error(secret);
  },
};
const params = {
  subagentType: config.type,
  description: 'Review.',
  parentToolCallId: 'review-call',
};

test('guarded patch is idempotent and rejects version/content drift before writing', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'agents-patch-'));
  const installed = path.resolve(__dirname, '../node_modules/@librechat/agents');
  try {
    fs.copyFileSync(path.join(installed, 'package.json'), path.join(root, 'package.json'));
    for (const file of patch.files) {
      fs.mkdirSync(path.dirname(path.join(root, file.path)), { recursive: true });
      fs.copyFileSync(path.join(installed, file.path), path.join(root, file.path));
    }
    applyPatch(root);
    const before = fs.readFileSync(path.join(root, patch.files[0].path), 'utf8');
    fs.appendFileSync(path.join(root, patch.files.at(-1).path), '\n// drift');
    assert.throws(() => applyPatch(root), /input mismatch/);
    assert.equal(fs.readFileSync(path.join(root, patch.files[0].path), 'utf8'), before);
    fs.writeFileSync(
      path.join(root, 'package.json'),
      JSON.stringify({ name: patch.package, version: '4.0.2' }),
    );
    assert.throws(() => applyPatch(root), /requires @librechat\/agents@4.0.1/);
  } finally {
    fs.rmSync(root, { recursive: true });
  }
});

for (const cause of ['authentication_required', 'tools_unavailable', 'unknown', secret]) {
  test(`installed executor allowlists ${cause === secret ? 'untrusted text' : cause}`, async (t) => {
    t.mock.method(console, 'warn', () => {});
    let calls = 0;
    const instance = new sdk.SubagentExecutor({
      configs: new Map([[config.type, config]]),
      parentRunId: 'parent-run',
      createChildGraph: () => {
        throw new Error('A rejected resolver must not run a graph');
      },
      onResolutionFailure: (detail, error) => {
        assert.equal(detail.phase, 'config');
        assert.equal(error.message, secret);
        assert.equal(Object.isFrozen(detail), true);
        calls++;
        return cause;
      },
    });
    try {
      const result = await instance.execute(params);
      assert.equal(calls, 1);
      assert.equal(result.content, sdk.getSubagentResolutionFailureMessage(cause));
      assert.equal(JSON.stringify(result).includes(secret), false);
    } finally {
      instance.clearHeavyState();
    }
  });
}

test('a broken classifier preserves the safe fallback', async (t) => {
  t.mock.method(console, 'warn', () => {});
  const instance = new sdk.SubagentExecutor({
    configs: new Map([[config.type, config]]),
    parentRunId: 'parent-run',
    createChildGraph: () => {
      throw new Error('unreachable');
    },
    onResolutionFailure: () => {
      throw new Error(secret);
    },
  });
  try {
    const result = await instance.execute(params);
    assert.equal(result.content, sdk.getSubagentResolutionFailureMessage('unknown'));
    assert.equal(JSON.stringify(result).includes(secret), false);
  } finally {
    instance.clearHeavyState();
  }
});

for (const kind of ['standard', 'multi-agent']) {
  test(`public Run callback reaches the ${kind} graph and actual tool result`, async () => {
    let calls = 0;
    const parent = {
      agentId: 'parent',
      provider: sdk.Providers.OPENAI,
      clientOptions: { modelName: 'gpt-4o-mini', apiKey: 'unused' },
      maxContextTokens: 8000,
      subagentConfigs: [config],
    };
    const run = await sdk.Run.create({
      runId: 'parent-run',
      onSubagentResolutionFailure: () => {
        calls++;
        return 'authentication_required';
      },
      graphConfig:
        kind === 'standard'
          ? { type: kind, agents: [parent] }
          : { type: kind, agents: [parent], edges: [], entryAgentId: 'parent' },
    });
    const graph = run.Graph;
    try {
      graph.overrideTestModel(['Starting reviewer', 'Finished'], 0, [
        {
          name: 'subagent',
          id: 'spawn-reviewer',
          type: 'tool_call',
          args: { subagent_type: config.type, description: 'Review code.' },
        },
      ]);
      const state = await graph
        .createWorkflow()
        .invoke({ messages: [new HumanMessage('Review.')] });
      assert.equal(calls, 1);
      const output = state.messages.find((message) => message instanceof ToolMessage);
      assert.equal(
        output.content,
        sdk.getSubagentResolutionFailureMessage('authentication_required'),
      );
      assert.equal(JSON.stringify(state.messages).includes(secret), false);
    } finally {
      graph.clearHeavyState();
    }
  });
}

test('ESM entry point exports the same fixed message', async () => {
  const esm = await import('@librechat/agents');
  assert.equal(
    esm.getSubagentResolutionFailureMessage('tools_unavailable'),
    sdk.getSubagentResolutionFailureMessage('tools_unavailable'),
  );
});

test('the callback follows nested child graph inputs', async () => {
  const hook = () => 'tools_unavailable';
  let observed;
  const instance = new sdk.SubagentExecutor({
    configs: new Map([
      [
        config.type,
        {
          ...config,
          resolveAgentInputs: undefined,
          agentInputs: {
            agentId: 'child',
            provider: sdk.Providers.OPENAI,
            clientOptions: { modelName: 'gpt-4o-mini', apiKey: 'unused' },
            maxContextTokens: 8000,
          },
        },
      ],
    ]),
    parentRunId: 'parent',
    onResolutionFailure: hook,
    createChildGraph: (input) => {
      observed = input;
      const graph = sdk.createGraph({ kind: 'standard', input });
      graph.overrideTestModel(['Finished']);
      return graph;
    },
  });
  try {
    await instance.execute(params);
    assert.equal(observed.onSubagentResolutionFailure, hook);
  } finally {
    instance.clearHeavyState();
  }
});

test('detached executors retain the host classifier', async () => {
  let calls = 0;
  const store = new sdk.InMemorySubagentTaskStore();
  const originalStart = store.start.bind(store);
  let settled;
  const completion = new Promise((resolve) => {
    settled = resolve;
  });
  store.start = (request) =>
    originalStart({
      ...request,
      run: async (...args) => {
        try {
          return await request.run(...args);
        } finally {
          settled();
        }
      },
    });
  const instance = new sdk.SubagentExecutor({
    configs: new Map([[config.type, config]]),
    parentRunId: 'parent-run',
    createChildGraph: () => {
      throw new Error('unreachable');
    },
    onResolutionFailure: () => {
      calls++;
      return 'authentication_required';
    },
    taskConfig: { store, scopeId: 'test-scope' },
  });
  try {
    instance.executeInBackground(params);
    await completion;
    assert.equal(calls, 1);
  } finally {
    instance.clearHeavyState();
  }
});
