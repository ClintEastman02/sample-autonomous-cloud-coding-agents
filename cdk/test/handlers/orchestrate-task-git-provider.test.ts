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

/**
 * ADR-025 Phase 1b: `runPreflightChecks` now dispatches on the resolved
 * `git_provider` and throws for a provider with no SCM implementation. That
 * throw lands in the 'pre-flight' step's catch, which must fail the task
 * (releasing concurrency) and rethrow; the durable retry then sees FAILED and
 * returns without re-running preflight.
 */
describe('orchestrate-task handler: preflight throws (ADR-025 Phase 1b)', () => {
  const mockLoadTask = (
    jest.requireMock('../../src/handlers/shared/orchestrator') as { loadTask: jest.Mock }
  ).loadTask;
  const baseTask = {
    task_id: 'TASK001',
    user_id: 'user-1',
    status: 'SUBMITTED',
    repo: 'org/repo',
    resolved_workflow: { id: 'coding/new-task-v1', version: '1.0.0' },
  };
  const preflightError = "unsupported git_provider 'gitlab'";

  /**
   * Fake durable context that checkpoints COMPLETED step results across
   * invocations, like the SDK's replay: a step that resolved returns its
   * stored value without re-running; a step that threw has no checkpoint and
   * re-executes on the next invocation (the step retry).
   */
  function replayingContext() {
    const checkpoints = new Map<string, unknown>();
    let steps: string[] = [];
    let executed: string[] = [];
    return {
      checkpoints,
      newInvocation: () => {
        steps = [];
        executed = [];
        return {
          steps: () => steps,
          executed: () => executed,
          ctx: {
            step: async (name: string, fn: () => Promise<unknown>) => {
              steps.push(name);
              if (checkpoints.has(name)) return checkpoints.get(name);
              executed.push(name);
              const value = await fn();
              checkpoints.set(name, value);
              return value;
            },
            waitForCondition: async (name: string) => {
              steps.push(name);
              throw new Error('waitForCondition must not be reached');
            },
          },
        };
      },
    };
  }

  beforeEach(() => {
    mockLoadTask.mockReset();
    mockLoadTask.mockResolvedValue(baseTask);
    mockLoadRepoConfig.mockReset();
    // Valid row: git_provider absent → resolves to 'github' at blueprint load.
    mockLoadRepoConfig.mockResolvedValue({
      repo: 'org/repo',
      status: 'active',
      onboarded_at: '2024-01-01T00:00:00Z',
      updated_at: '2024-01-01T00:00:00Z',
    });
    mockAdmissionControl.mockReset();
    mockAdmissionControl.mockResolvedValue(true);
    mockRunPreflightChecks.mockReset();
    mockRunPreflightChecks.mockRejectedValue(new Error(preflightError));
  });

  afterAll(() => {
    // Restore the module-factory default for any later describe in this file.
    mockLoadTask.mockReset();
    mockLoadTask.mockResolvedValue(baseTask);
  });

  test('fails the task with releaseConcurrency=true and rethrows; no hydration or compute', async () => {
    const { ctx, steps } = fakeContext();

    await expect(handler({ task_id: 'TASK001' }, ctx as never)).rejects.toThrow(preflightError);

    expect(mockRunPreflightChecks).toHaveBeenCalledTimes(1);
    // Blueprint load really resolved the absent row to 'github' before dispatch.
    expect(mockRunPreflightChecks.mock.calls[0][1]).toMatchObject({ git_provider: 'github' });

    // failTask(taskId, fromStatus, errorMessage, userId, releaseConcurrency, repo)
    expect(mockFailTask).toHaveBeenCalledTimes(1);
    const [taskId, fromStatus, reason, userId, releaseConcurrency, repo] = mockFailTask.mock.calls[0];
    expect(taskId).toBe('TASK001');
    expect(fromStatus).toBe('SUBMITTED');
    expect(reason).toMatch(/^Pre-flight failed: .*unsupported git_provider/);
    expect(reason).toContain(preflightError);
    expect(userId).toBe('user-1');
    expect(releaseConcurrency).toBe(true);
    expect(repo).toBe('org/repo');

    expect(steps).toEqual(['load-task', 'load-blueprint', 'admission-control', 'pre-flight']);
    expect(mockHydrateAndTransition).not.toHaveBeenCalled();
    expect(mockResolveComputeStrategy).not.toHaveBeenCalled();
  });

  test('the durable retry sees FAILED and resolves without re-running preflight', async () => {
    const durable = replayingContext();

    // Invocation 1: pre-flight throws, so it is not checkpointed.
    const first = durable.newInvocation();
    await expect(handler({ task_id: 'TASK001' }, first.ctx as never)).rejects.toThrow(preflightError);
    expect([...durable.checkpoints.keys()]).toEqual(['load-task', 'load-blueprint', 'admission-control']);
    expect(mockRunPreflightChecks).toHaveBeenCalledTimes(1);
    expect(mockFailTask).toHaveBeenCalledTimes(1);

    // failTask moved the task to FAILED; the pre-flight step's re-read sees it.
    mockLoadTask.mockReset();
    mockLoadTask.mockResolvedValue({ ...baseTask, status: 'FAILED' });

    // Invocation 2 (retry): earlier steps replay from checkpoints; only pre-flight runs.
    const second = durable.newInvocation();
    await expect(handler({ task_id: 'TASK001' }, second.ctx as never)).resolves.toBeUndefined();

    expect(second.executed()).toEqual(['pre-flight']);
    expect(second.steps()).toEqual(['load-task', 'load-blueprint', 'admission-control', 'pre-flight']);
    expect(mockLoadTask).toHaveBeenCalledTimes(1);
    expect(mockRunPreflightChecks).toHaveBeenCalledTimes(1);
    expect(mockFailTask).toHaveBeenCalledTimes(1);
    expect(mockAdmissionControl).toHaveBeenCalledTimes(1);
    expect(mockHydrateAndTransition).not.toHaveBeenCalled();
    expect(mockResolveComputeStrategy).not.toHaveBeenCalled();
  });
});
