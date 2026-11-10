/**
 *  MIT No Attribution
 *
 *  Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
 *
 *  Permission is hereby granted, free of charge, to any person obtaining a copy of
 *  the Software without restriction, including without limitation the rights to
 *  use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies of
 *  the Software, and to permit persons to whom the Software is furnished to do so.
 *
 *  THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 *  IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 *  FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 *  AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 *  LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 *  OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
 *  SOFTWARE.
 */

/**
 * ADR-025 §9: "If a RepoTable `git_provider` value is present and is not an
 * implemented, enabled provider id, then the orchestrator shall fail the task at
 * blueprint load with a message naming the value, before preflight, hydration or
 * compute start."
 *
 * Drives the durable handler with a fake context and the REAL `loadBlueprintConfig`
 * (only the RepoTable read and the DDB-touching helpers are stubbed), so the
 * throw → 'Blueprint config load failed' → no-preflight wiring is exercised end to end.
 */

jest.mock('@aws/durable-execution-sdk-js', () => ({
  withDurableExecution: (fn: unknown) => fn,
}));

const mockLoadRepoConfig = jest.fn();
jest.mock('../../src/handlers/shared/repo-config', () => ({
  loadRepoConfig: (...a: unknown[]) => mockLoadRepoConfig(...a),
  checkRepoOnboarded: jest.fn(),
}));

const mockFailTask = jest.fn();
const mockAdmissionControl = jest.fn();
const mockHydrateAndTransition = jest.fn();
jest.mock('../../src/handlers/shared/orchestrator', () => {
  const real = jest.requireActual('../../src/handlers/shared/orchestrator');
  return {
    ...real,
    loadTask: jest.fn().mockResolvedValue({
      task_id: 'TASK001',
      user_id: 'user-1',
      status: 'SUBMITTED',
      repo: 'org/repo',
      resolved_workflow: { id: 'coding/new-task-v1', version: '1.0.0' },
    }),
    failTask: (...a: unknown[]) => mockFailTask(...a),
    admissionControl: (...a: unknown[]) => mockAdmissionControl(...a),
    hydrateAndTransition: (...a: unknown[]) => mockHydrateAndTransition(...a),
  };
});

const mockRunPreflightChecks = jest.fn();
jest.mock('../../src/handlers/shared/preflight', () => ({
  runPreflightChecks: (...a: unknown[]) => mockRunPreflightChecks(...a),
}));

const mockResolveComputeStrategy = jest.fn();
jest.mock('../../src/handlers/shared/compute-strategy', () => ({
  resolveComputeStrategy: (...a: unknown[]) => mockResolveComputeStrategy(...a),
}));

process.env.TASK_TABLE_NAME = 'Tasks';
process.env.TASK_EVENTS_TABLE_NAME = 'TaskEvents';
process.env.USER_CONCURRENCY_TABLE_NAME = 'UserConcurrency';
process.env.RUNTIME_ARN = 'arn:aws:bedrock-agentcore:us-east-1:123456789012:runtime/test';

import { handler } from '../../src/handlers/orchestrate-task';

function fakeContext() {
  const steps: string[] = [];
  return {
    steps,
    ctx: {
      step: async (name: string, fn: () => Promise<unknown>) => {
        steps.push(name);
        return fn();
      },
      waitForCondition: async (name: string) => {
        steps.push(name);
        throw new Error('waitForCondition must not be reached');
      },
    },
  };
}

beforeEach(() => {
  jest.clearAllMocks();
  mockFailTask.mockResolvedValue(undefined);
});

describe('orchestrate-task handler: unsupported git_provider on the repo row', () => {
  test.each(['gitlab', 'GitHub', ''])('a %p row fails at blueprint load, before admission/preflight/compute', async (value) => {
    mockLoadRepoConfig.mockResolvedValueOnce({
      repo: 'org/repo',
      status: 'active',
      onboarded_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
      git_provider: value,
    });
    const { ctx, steps } = fakeContext();

    await expect(handler({ task_id: 'TASK001' }, ctx as never)).rejects.toThrow(
      `unsupported git_provider '${value}'`,
    );

    expect(mockFailTask).toHaveBeenCalledTimes(1);
    const reason = mockFailTask.mock.calls[0][2] as string;
    expect(reason).toMatch(/^Blueprint config load failed: /);
    expect(reason).toContain(`unsupported git_provider '${value}'`);

    expect(steps).toEqual(['load-task', 'load-blueprint']);
    expect(mockAdmissionControl).not.toHaveBeenCalled();
    expect(mockRunPreflightChecks).not.toHaveBeenCalled();
    expect(mockHydrateAndTransition).not.toHaveBeenCalled();
    expect(mockResolveComputeStrategy).not.toHaveBeenCalled();
  });
});
