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

// Golden wire-parity test captured from e79fbb45 (pre-ADR-025 Phase 1b) - any diff here is a behaviour change.
//
// Every scenario records each outbound fetch (url, method, normalised headers,
// parsed body, whether an abort signal was attached) plus the PreflightResult
// (durationMs stripped — timing-dependent) and compares both against the
// INLINE golden literals below. Response mocks route by `METHOD url`, so the
// test does not depend on call order, while the recorded order is still
// asserted. Each scenario runs twice — blueprint WITHOUT git_provider and WITH
// git_provider: 'github' — and both must match the same golden.
//
// Also pinned per scenario:
// - every AbortSignal.timeout() argument (5000ms) and one timeout per fetch;
// - every logger.warn / logger.error line (message + structured fields, with
//   volatile fields such as durations / stacks stripped);
// - the PREFLIGHT_CHECK_RUNTIME env flag where a scenario sets it.
// A separate deferred-fetch test pins that the GitHub checks run in parallel.

// --- Mocks (before imports) ---
const mockSmSend = jest.fn();
class MockResourceNotFoundException extends Error {
  constructor(message = 'Secrets Manager can’t find the specified secret.') {
    super(message);
    this.name = 'ResourceNotFoundException';
  }
}
jest.mock('@aws-sdk/client-secrets-manager', () => ({
  SecretsManagerClient: jest.fn(() => ({ send: mockSmSend })),
  GetSecretValueCommand: jest.fn((input: unknown) => ({ _type: 'GetSecretValue', input })),
  ResourceNotFoundException: MockResourceNotFoundException,
}));

jest.mock('../../../src/handlers/shared/memory', () => ({
  loadMemoryContext: jest.fn(),
}));

import { clearTokenCache } from '../../../src/handlers/shared/context-hydration';
import { logger } from '../../../src/handlers/shared/logger';
import { runPreflightChecks } from '../../../src/handlers/shared/preflight';
import type { BlueprintConfig } from '../../../src/handlers/shared/repo-config';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const TOKEN = 'ghp_parity_token';
const REPO = 'owner/repo';
const PR = 42;
const SECRET_ARN = 'arn:aws:secretsmanager:us-east-1:123456789012:secret:github-token';

/** Same shape as preflight.test.ts baseBlueprintConfig, minus git_provider. */
const configNoProvider: BlueprintConfig = {
  compute_type: 'agentcore',
  runtime_arn: 'arn:aws:bedrock:us-east-1:123456789012:agent-runtime/test',
  github_token_secret_arn: SECRET_ARN,
};

const configWithProvider: BlueprintConfig = {
  ...configNoProvider,
  git_provider: 'github',
};

const CONFIG_VARIANTS: ReadonlyArray<[string, BlueprintConfig]> = [
  ['without git_provider', configNoProvider],
  ["with git_provider: 'github'", configWithProvider],
];

// ---------------------------------------------------------------------------
// Recording fetch mock
// ---------------------------------------------------------------------------

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  hasSignal: boolean;
}

interface MockResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

/** A route either returns a response or throws (network error). */
type Route = { status: number; json?: unknown } | { throws: string };

function normaliseHeaders(h: unknown): Record<string, string> {
  const entries: Array<[string, string]> = [];
  if (h === undefined || h === null) {
    // no headers
  } else if (typeof Headers !== 'undefined' && h instanceof Headers) {
    h.forEach((v, k) => entries.push([k.toLowerCase(), v]));
  } else if (Array.isArray(h)) {
    for (const [k, v] of h as Array<[string, string]>) entries.push([k.toLowerCase(), String(v)]);
  } else {
    for (const [k, v] of Object.entries(h as Record<string, unknown>)) entries.push([k.toLowerCase(), String(v)]);
  }
  entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return Object.fromEntries(entries);
}

function parseBody(b: unknown): unknown {
  if (b === undefined || b === null) return null;
  if (typeof b === 'string') {
    try {
      return JSON.parse(b);
    } catch {
      return b;
    }
  }
  return String(b);
}

function installRecordingFetch(routes: Record<string, Route>): RecordedCall[] {
  const calls: RecordedCall[] = [];
  const impl = async (input: unknown, init?: RequestInit): Promise<MockResponse> => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : (input as { url: string }).url;
    const method = (init?.method ?? 'GET').toUpperCase();
    calls.push({
      url,
      method,
      headers: normaliseHeaders(init?.headers),
      body: parseBody(init?.body),
      hasSignal: init?.signal !== undefined && init?.signal !== null,
    });
    const route = routes[`${method} ${url}`];
    if (!route) {
      throw new Error(`UNROUTED ${method} ${url}`);
    }
    if ('throws' in route) {
      throw new Error(route.throws);
    }
    return {
      ok: route.status >= 200 && route.status < 300,
      status: route.status,
      json: async () => route.json,
    };
  };
  global.fetch = jest.fn(impl) as unknown as typeof fetch;
  return calls;
}

// ---------------------------------------------------------------------------
// Log + timeout recording
// ---------------------------------------------------------------------------

/** Timeout preflight.ts passes to AbortSignal.timeout (GITHUB_API_TIMEOUT_MS at e79fbb45). */
const EXPECTED_TIMEOUT_MS = 5000;

interface RecordedLog {
  level: 'warn' | 'error';
  message: string;
  fields: Record<string, unknown>;
}

/** Fields that vary run to run and are never golden-compared. */
const VOLATILE_LOG_FIELDS = ['durationMs', 'duration_ms', 'elapsedMs', 'stack'];

function normaliseLogFields(data: unknown): Record<string, unknown> {
  if (data === undefined || data === null) return {};
  const fields: Record<string, unknown> = JSON.parse(JSON.stringify(data));
  for (const key of VOLATILE_LOG_FIELDS) delete fields[key];
  return fields;
}

/** Spy on logger.warn / logger.error (silenced) and record lines in emission order. */
function installLogSpies(): { logs: RecordedLog[]; restore: () => void } {
  const logs: RecordedLog[] = [];
  const warn = jest.spyOn(logger, 'warn').mockImplementation((message, data) => {
    logs.push({ level: 'warn', message, fields: normaliseLogFields(data) });
  });
  const error = jest.spyOn(logger, 'error').mockImplementation((message, data) => {
    logs.push({ level: 'error', message, fields: normaliseLogFields(data) });
  });
  return {
    logs,
    restore: () => {
      warn.mockRestore();
      error.mockRestore();
    },
  };
}

/** JSON round-trip drops undefined-valued keys; durationMs removed (timing-dependent). */
function normaliseResult(result: Awaited<ReturnType<typeof runPreflightChecks>>): unknown {
  const { checks, ...rest } = result;
  return JSON.parse(JSON.stringify({
    ...rest,
    checks: checks.map(({ durationMs: _durationMs, ...c }) => c),
  }));
}

// ---------------------------------------------------------------------------
// Golden request records (literal wire shapes at e79fbb45)
// ---------------------------------------------------------------------------

const RATE_LIMIT_URL = 'https://api.github.com/rate_limit';
const REPO_URL = 'https://api.github.com/repos/owner/repo';
const PR_URL = 'https://api.github.com/repos/owner/repo/pulls/42';
const GRAPHQL_URL = 'https://api.github.com/graphql';

const CALL_RATE_LIMIT: RecordedCall = {
  url: 'https://api.github.com/rate_limit',
  method: 'GET',
  headers: {
    accept: 'application/vnd.github.v3+json',
    authorization: 'token ghp_parity_token',
  },
  body: null,
  hasSignal: true,
};

const CALL_REPO: RecordedCall = {
  url: 'https://api.github.com/repos/owner/repo',
  method: 'GET',
  headers: {
    accept: 'application/vnd.github.v3+json',
    authorization: 'token ghp_parity_token',
  },
  body: null,
  hasSignal: true,
};

const CALL_PR: RecordedCall = {
  url: 'https://api.github.com/repos/owner/repo/pulls/42',
  method: 'GET',
  headers: {
    accept: 'application/vnd.github.v3+json',
    authorization: 'token ghp_parity_token',
  },
  body: null,
  hasSignal: true,
};

const CALL_GRAPHQL: RecordedCall = {
  url: 'https://api.github.com/graphql',
  method: 'POST',
  headers: {
    'accept': 'application/json',
    'authorization': 'Bearer ghp_parity_token',
    'content-type': 'application/json',
  },
  body: {
    query: 'query($owner:String!,$name:String!){repository(owner:$owner,name:$name){viewerPermission}}',
    variables: { owner: 'owner', name: 'repo' },
  },
  hasSignal: true,
};

const PAT_HINT = ' For fine-grained PATs use Contents **Read and write**, Pull requests **Read and write**, and Issues **Read** on this repo (see developer guide / agent README).';

// ---------------------------------------------------------------------------
// Scenario matrix
// ---------------------------------------------------------------------------

interface Scenario {
  name: string;
  /** Override blueprint (applied on top of the variant). */
  configPatch?: Partial<BlueprintConfig>;
  prNumber?: number;
  readOnly?: boolean;
  /** Set PREFLIGHT_CHECK_RUNTIME='true' for this scenario. */
  runtimeCheck?: boolean;
  /** ok: token resolves; missing: ResourceNotFound; unreadable: other SM error; none: no ARN configured. */
  secret: 'ok' | 'missing' | 'unreadable' | 'none';
  routes: Record<string, Route>;
  expectedCalls: RecordedCall[];
  expectedCheckOrder: string[];
  expectedResult: unknown;
  /** Every logger.warn / logger.error line, in emission order. */
  expectedLogs: RecordedLog[];
}

const SCENARIOS: Scenario[] = [
  {
    name: '(a) all green, write task, no PR',
    secret: 'ok',
    routes: {
      [`GET ${RATE_LIMIT_URL}`]: { status: 200, json: {} },
      [`GET ${REPO_URL}`]: { status: 200, json: { permissions: { push: true } } },
    },
    expectedCalls: [CALL_RATE_LIMIT, CALL_REPO],
    expectedCheckOrder: ['github_reachability', 'repo_access'],
    expectedLogs: [],
    expectedResult: {
      passed: true,
      checks: [
        { check: 'github_reachability', passed: true },
        { check: 'repo_access', passed: true },
      ],
    },
  },
  {
    name: '(b) all green with prNumber',
    secret: 'ok',
    prNumber: PR,
    routes: {
      [`GET ${RATE_LIMIT_URL}`]: { status: 200, json: {} },
      [`GET ${REPO_URL}`]: { status: 200, json: { permissions: { push: true } } },
      [`GET ${PR_URL}`]: { status: 200, json: { state: 'open' } },
    },
    expectedCalls: [CALL_RATE_LIMIT, CALL_REPO, CALL_PR],
    expectedCheckOrder: ['github_reachability', 'repo_access', 'pr_accessible'],
    expectedLogs: [],
    expectedResult: {
      passed: true,
      checks: [
        { check: 'github_reachability', passed: true },
        { check: 'repo_access', passed: true },
        { check: 'pr_accessible', passed: true },
      ],
    },
  },
  {
    name: '(c1) readOnly, REST push=false, GraphQL viewerPermission TRIAGE -> passes',
    secret: 'ok',
    readOnly: true,
    routes: {
      [`GET ${RATE_LIMIT_URL}`]: { status: 200, json: {} },
      [`GET ${REPO_URL}`]: { status: 200, json: { permissions: { push: false, pull: true } } },
      [`POST ${GRAPHQL_URL}`]: { status: 200, json: { data: { repository: { viewerPermission: 'TRIAGE' } } } },
    },
    expectedCalls: [CALL_RATE_LIMIT, CALL_REPO, CALL_GRAPHQL],
    expectedCheckOrder: ['github_reachability', 'repo_access'],
    expectedLogs: [],
    expectedResult: {
      passed: true,
      checks: [
        { check: 'github_reachability', passed: true },
        { check: 'repo_access', passed: true },
      ],
    },
  },
  {
    name: '(c2) readOnly, REST push=false, GraphQL viewerPermission READ -> fails',
    secret: 'ok',
    readOnly: true,
    routes: {
      [`GET ${RATE_LIMIT_URL}`]: { status: 200, json: {} },
      [`GET ${REPO_URL}`]: { status: 200, json: { permissions: { push: false, pull: true } } },
      [`POST ${GRAPHQL_URL}`]: { status: 200, json: { data: { repository: { viewerPermission: 'READ' } } } },
    },
    expectedCalls: [CALL_RATE_LIMIT, CALL_REPO, CALL_GRAPHQL],
    expectedCheckOrder: ['github_reachability', 'repo_access'],
    expectedLogs: [],
    expectedResult: {
      passed: false,
      failureReason: 'INSUFFICIENT_GITHUB_REPO_PERMISSIONS',
      failureDetail:
        'Token cannot interact with pull requests on owner/repo. REST API reports push=false for this token.'
        + ' GitHub reports viewerPermission=READ.'
        + ' Required: Pull request interaction (e.g. TRIAGE or Contents write) for this repository.'
        + PAT_HINT,
      checks: [
        { check: 'github_reachability', passed: true },
        {
          check: 'repo_access',
          passed: false,
          reason: 'INSUFFICIENT_GITHUB_REPO_PERMISSIONS',
          detail:
            'Token cannot interact with pull requests on owner/repo. REST API reports push=false for this token.'
            + ' GitHub reports viewerPermission=READ.'
            + ' Required: Pull request interaction (e.g. TRIAGE or Contents write) for this repository.'
            + PAT_HINT,
        },
      ],
    },
  },
  {
    name: '(d1) write task, REST push=false, GraphQL viewerPermission WRITE -> fallback passes',
    secret: 'ok',
    routes: {
      [`GET ${RATE_LIMIT_URL}`]: { status: 200, json: {} },
      [`GET ${REPO_URL}`]: { status: 200, json: { permissions: { push: false } } },
      [`POST ${GRAPHQL_URL}`]: { status: 200, json: { data: { repository: { viewerPermission: 'WRITE' } } } },
    },
    expectedCalls: [CALL_RATE_LIMIT, CALL_REPO, CALL_GRAPHQL],
    expectedCheckOrder: ['github_reachability', 'repo_access'],
    expectedLogs: [],
    expectedResult: {
      passed: true,
      checks: [
        { check: 'github_reachability', passed: true },
        { check: 'repo_access', passed: true },
      ],
    },
  },
  {
    name: '(d2) write task, REST push=false, GraphQL viewerPermission READ -> fails',
    secret: 'ok',
    routes: {
      [`GET ${RATE_LIMIT_URL}`]: { status: 200, json: {} },
      [`GET ${REPO_URL}`]: { status: 200, json: { permissions: { push: false } } },
      [`POST ${GRAPHQL_URL}`]: { status: 200, json: { data: { repository: { viewerPermission: 'READ' } } } },
    },
    expectedCalls: [CALL_RATE_LIMIT, CALL_REPO, CALL_GRAPHQL],
    expectedCheckOrder: ['github_reachability', 'repo_access'],
    expectedLogs: [],
    expectedResult: {
      passed: false,
      failureReason: 'INSUFFICIENT_GITHUB_REPO_PERMISSIONS',
      failureDetail:
        'Token cannot push to owner/repo. REST API reports push=false for this token.'
        + ' GitHub reports viewerPermission=READ.'
        + ' Required: Contents write (push branches) for this repository.'
        + PAT_HINT,
      checks: [
        { check: 'github_reachability', passed: true },
        {
          check: 'repo_access',
          passed: false,
          reason: 'INSUFFICIENT_GITHUB_REPO_PERMISSIONS',
          detail:
            'Token cannot push to owner/repo. REST API reports push=false for this token.'
            + ' GitHub reports viewerPermission=READ.'
            + ' Required: Contents write (push branches) for this repository.'
            + PAT_HINT,
        },
      ],
    },
  },
  {
    name: '(e) repo 404',
    secret: 'ok',
    routes: {
      [`GET ${RATE_LIMIT_URL}`]: { status: 200, json: {} },
      [`GET ${REPO_URL}`]: { status: 404, json: { message: 'Not Found' } },
    },
    expectedCalls: [CALL_RATE_LIMIT, CALL_REPO],
    expectedCheckOrder: ['github_reachability', 'repo_access'],
    expectedLogs: [],
    expectedResult: {
      passed: false,
      failureReason: 'REPO_NOT_FOUND_OR_NO_ACCESS',
      failureDetail: 'GitHub API returned HTTP 404 for owner/repo',
      checks: [
        { check: 'github_reachability', passed: true },
        {
          check: 'repo_access',
          passed: false,
          reason: 'REPO_NOT_FOUND_OR_NO_ACCESS',
          detail: 'GitHub API returned HTTP 404 for owner/repo',
          httpStatus: 404,
        },
      ],
    },
  },
  {
    name: '(f) reachability 401',
    secret: 'ok',
    routes: {
      [`GET ${RATE_LIMIT_URL}`]: { status: 401, json: { message: 'Bad credentials' } },
      [`GET ${REPO_URL}`]: { status: 200, json: { permissions: { push: true } } },
    },
    expectedCalls: [CALL_RATE_LIMIT, CALL_REPO],
    expectedCheckOrder: ['github_reachability', 'repo_access'],
    expectedLogs: [],
    expectedResult: {
      passed: false,
      failureReason: 'GITHUB_UNREACHABLE',
      failureDetail: 'GitHub API returned HTTP 401',
      checks: [
        {
          check: 'github_reachability',
          passed: false,
          reason: 'GITHUB_UNREACHABLE',
          detail: 'GitHub API returned HTTP 401',
          httpStatus: 401,
        },
        { check: 'repo_access', passed: true },
      ],
    },
  },
  {
    name: '(g) PR closed',
    secret: 'ok',
    prNumber: PR,
    routes: {
      [`GET ${RATE_LIMIT_URL}`]: { status: 200, json: {} },
      [`GET ${REPO_URL}`]: { status: 200, json: { permissions: { push: true } } },
      [`GET ${PR_URL}`]: { status: 200, json: { state: 'closed' } },
    },
    expectedCalls: [CALL_RATE_LIMIT, CALL_REPO, CALL_PR],
    expectedCheckOrder: ['github_reachability', 'repo_access', 'pr_accessible'],
    expectedLogs: [],
    expectedResult: {
      passed: false,
      failureReason: 'PR_NOT_FOUND_OR_CLOSED',
      failureDetail: 'PR #42 in owner/repo is closed, not open',
      checks: [
        { check: 'github_reachability', passed: true },
        { check: 'repo_access', passed: true },
        {
          check: 'pr_accessible',
          passed: false,
          reason: 'PR_NOT_FOUND_OR_CLOSED',
          detail: 'PR #42 in owner/repo is closed, not open',
        },
      ],
    },
  },
  {
    name: '(h) network error on repo_access fetch',
    secret: 'ok',
    routes: {
      [`GET ${RATE_LIMIT_URL}`]: { status: 200, json: {} },
      [`GET ${REPO_URL}`]: { throws: 'getaddrinfo ENOTFOUND api.github.com' },
    },
    expectedCalls: [CALL_RATE_LIMIT, CALL_REPO],
    expectedCheckOrder: ['github_reachability', 'repo_access'],
    expectedLogs: [
      {
        level: 'warn',
        message: 'Repo access check failed',
        fields: { repo: 'owner/repo', error: 'getaddrinfo ENOTFOUND api.github.com' },
      },
    ],
    expectedResult: {
      passed: false,
      failureReason: 'GITHUB_UNREACHABLE',
      failureDetail: 'getaddrinfo ENOTFOUND api.github.com',
      checks: [
        { check: 'github_reachability', passed: true },
        {
          check: 'repo_access',
          passed: false,
          reason: 'GITHUB_UNREACHABLE',
          detail: 'getaddrinfo ENOTFOUND api.github.com',
        },
      ],
    },
  },
  {
    name: '(i) no github_token_secret_arn -> no fetch at all',
    secret: 'none',
    configPatch: { github_token_secret_arn: undefined },
    routes: {},
    expectedCalls: [],
    expectedCheckOrder: [],
    expectedLogs: [
      {
        level: 'warn',
        message: 'No GitHub token configured — skipping GitHub pre-flight checks',
        fields: { repo: 'owner/repo' },
      },
    ],
    expectedResult: {
      passed: true,
      checks: [],
    },
  },
  {
    name: '(j) token resolution failure (missing secret) -> zero fetches',
    secret: 'missing',
    routes: {},
    expectedCalls: [],
    expectedCheckOrder: ['github_token_resolution'],
    expectedLogs: [
      {
        level: 'error',
        message: 'GitHub token resolution failed',
        fields: {
          repo: 'owner/repo',
          error:
            'BLOCKED[missing_secret]: the required GitHub token secret does not exist'
            + ' (resource: arn:aws:secretsmanager:us-east-1:123456789012:secret:github-token)',
          reason: 'GITHUB_TOKEN_SECRET_MISSING',
        },
      },
    ],
    expectedResult: {
      passed: false,
      failureReason: 'GITHUB_TOKEN_SECRET_MISSING',
      failureDetail:
        'BLOCKED[missing_secret]: the required GitHub token secret does not exist'
        + ' (resource: arn:aws:secretsmanager:us-east-1:123456789012:secret:github-token)',
      checks: [
        {
          check: 'github_token_resolution',
          passed: false,
          reason: 'GITHUB_TOKEN_SECRET_MISSING',
          detail:
            'BLOCKED[missing_secret]: the required GitHub token secret does not exist'
            + ' (resource: arn:aws:secretsmanager:us-east-1:123456789012:secret:github-token)',
        },
      ],
    },
  },
  {
    name: '(k) token resolution failure (unreadable secret) -> zero fetches',
    secret: 'unreadable',
    routes: {},
    expectedCalls: [],
    expectedCheckOrder: ['github_token_resolution'],
    expectedLogs: [
      {
        level: 'error',
        message: 'GitHub token resolution failed',
        fields: {
          repo: 'owner/repo',
          error:
            'BLOCKED[auth_failure]: the required GitHub token secret could not be read'
            + ' (resource: arn:aws:secretsmanager:us-east-1:123456789012:secret:github-token)',
          reason: 'GITHUB_TOKEN_SECRET_UNREADABLE',
        },
      },
    ],
    expectedResult: {
      passed: false,
      failureReason: 'GITHUB_TOKEN_SECRET_UNREADABLE',
      failureDetail:
        'BLOCKED[auth_failure]: the required GitHub token secret could not be read'
        + ' (resource: arn:aws:secretsmanager:us-east-1:123456789012:secret:github-token)',
      checks: [
        {
          check: 'github_token_resolution',
          passed: false,
          reason: 'GITHUB_TOKEN_SECRET_UNREADABLE',
          detail:
            'BLOCKED[auth_failure]: the required GitHub token secret could not be read'
            + ' (resource: arn:aws:secretsmanager:us-east-1:123456789012:secret:github-token)',
        },
      ],
    },
  },
  {
    name: '(l) readOnly with prNumber (pr_review shape), REST push=false, GraphQL TRIAGE -> all green',
    secret: 'ok',
    readOnly: true,
    prNumber: PR,
    routes: {
      [`GET ${RATE_LIMIT_URL}`]: { status: 200, json: {} },
      [`GET ${REPO_URL}`]: { status: 200, json: { permissions: { push: false, pull: true } } },
      [`GET ${PR_URL}`]: { status: 200, json: { state: 'open' } },
      [`POST ${GRAPHQL_URL}`]: { status: 200, json: { data: { repository: { viewerPermission: 'TRIAGE' } } } },
    },
    expectedCalls: [CALL_RATE_LIMIT, CALL_REPO, CALL_PR, CALL_GRAPHQL],
    expectedCheckOrder: ['github_reachability', 'repo_access', 'pr_accessible'],
    expectedLogs: [],
    expectedResult: {
      passed: true,
      checks: [
        { check: 'github_reachability', passed: true },
        { check: 'repo_access', passed: true },
        { check: 'pr_accessible', passed: true },
      ],
    },
  },
  {
    name: "(m) PREFLIGHT_CHECK_RUNTIME='true' -> runtime check appended last",
    secret: 'ok',
    runtimeCheck: true,
    prNumber: PR,
    routes: {
      [`GET ${RATE_LIMIT_URL}`]: { status: 200, json: {} },
      [`GET ${REPO_URL}`]: { status: 200, json: { permissions: { push: true } } },
      [`GET ${PR_URL}`]: { status: 200, json: { state: 'open' } },
    },
    expectedCalls: [CALL_RATE_LIMIT, CALL_REPO, CALL_PR],
    expectedCheckOrder: ['github_reachability', 'repo_access', 'pr_accessible', 'runtime_availability'],
    expectedLogs: [],
    expectedResult: {
      passed: true,
      checks: [
        { check: 'github_reachability', passed: true },
        { check: 'repo_access', passed: true },
        { check: 'pr_accessible', passed: true },
        { check: 'runtime_availability', passed: true },
      ],
    },
  },
];

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const originalFetch = global.fetch;
const originalRuntimeFlag = process.env.PREFLIGHT_CHECK_RUNTIME;

let logSpies: ReturnType<typeof installLogSpies>;
let timeoutSpy: jest.SpyInstance<AbortSignal, [number]>;

beforeEach(() => {
  jest.clearAllMocks();
  clearTokenCache();
  delete process.env.PREFLIGHT_CHECK_RUNTIME;
  logSpies = installLogSpies();
  // Call-through spy: the real AbortSignal is still handed to fetch.
  timeoutSpy = jest.spyOn(AbortSignal, 'timeout');
});

afterEach(() => {
  logSpies.restore();
  timeoutSpy.mockRestore();
  if (originalRuntimeFlag === undefined) {
    delete process.env.PREFLIGHT_CHECK_RUNTIME;
  } else {
    process.env.PREFLIGHT_CHECK_RUNTIME = originalRuntimeFlag;
  }
});

afterAll(() => {
  global.fetch = originalFetch;
});

function primeSecret(secret: Scenario['secret']): void {
  if (secret === 'ok') {
    mockSmSend.mockResolvedValueOnce({ SecretString: TOKEN });
  } else if (secret === 'missing') {
    mockSmSend.mockRejectedValueOnce(new MockResourceNotFoundException());
  } else if (secret === 'unreadable') {
    // Same trigger as preflight.test.ts: any non-ResourceNotFound SM error.
    mockSmSend.mockRejectedValueOnce(new Error('Service unavailable'));
  }
}

describe.each(CONFIG_VARIANTS)('preflight wire parity (blueprint %s)', (_label, variantConfig) => {
  test.each(SCENARIOS.map(s => [s.name, s] as const))('%s', async (_name, scenario) => {
    primeSecret(scenario.secret);
    if (scenario.runtimeCheck) {
      process.env.PREFLIGHT_CHECK_RUNTIME = 'true';
    }
    const calls = installRecordingFetch(scenario.routes);
    const config: BlueprintConfig = { ...variantConfig, ...scenario.configPatch };

    const result = await runPreflightChecks(REPO, config, scenario.prNumber, scenario.readOnly ?? false);

    // Wire: every outbound request, in recorded order.
    expect(calls).toStrictEqual(scenario.expectedCalls);
    // Timeout: exactly one AbortSignal.timeout(5000) per fetch.
    expect(timeoutSpy.mock.calls).toStrictEqual(calls.map(() => [EXPECTED_TIMEOUT_MS]));
    // Logs: every warn/error line, message + structured fields.
    expect(logSpies.logs).toStrictEqual(scenario.expectedLogs);
    // Check order in the result.
    expect(result.checks.map(c => c.check)).toStrictEqual(scenario.expectedCheckOrder);
    // durationMs is still present (just not golden-compared).
    for (const c of result.checks) {
      expect(typeof c.durationMs).toBe('number');
    }
    // Full result golden.
    expect(normaliseResult(result)).toStrictEqual(scenario.expectedResult);
    // Secrets Manager touched only when a token ARN is configured.
    expect(mockSmSend).toHaveBeenCalledTimes(scenario.secret === 'none' ? 0 : 1);
  });
});

// ---------------------------------------------------------------------------
// Parallelism: the GitHub checks must all be in flight before any resolves.
// A refactor to sequential awaits records the same call order, so only a
// deferred-response mock can tell the two apart.
// ---------------------------------------------------------------------------

interface DeferredFetch {
  call: RecordedCall;
  resolve: (r: MockResponse) => void;
}

function installDeferredFetch(): DeferredFetch[] {
  const pending: DeferredFetch[] = [];
  const impl = (input: unknown, init?: RequestInit): Promise<MockResponse> => new Promise(resolve => {
    pending.push({
      call: {
        url: String(input),
        method: (init?.method ?? 'GET').toUpperCase(),
        headers: normaliseHeaders(init?.headers),
        body: parseBody(init?.body),
        hasSignal: init?.signal !== undefined && init?.signal !== null,
      },
      resolve,
    });
  });
  global.fetch = jest.fn(impl) as unknown as typeof fetch;
  return pending;
}

/** Let the token resolution + check kick-off microtasks/macrotasks drain. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise(r => setImmediate(r));
  }
}

const DEFERRED_RESPONSES: Record<string, { status: number; json: unknown }> = {
  [RATE_LIMIT_URL]: { status: 200, json: {} },
  [REPO_URL]: { status: 200, json: { permissions: { push: true } } },
  [PR_URL]: { status: 200, json: { state: 'open' } },
};

describe.each(CONFIG_VARIANTS)('preflight parallelism (blueprint %s)', (_label, variantConfig) => {
  test.each([
    ['without prNumber', undefined, [CALL_RATE_LIMIT, CALL_REPO], ['github_reachability', 'repo_access']],
    ['with prNumber', PR, [CALL_RATE_LIMIT, CALL_REPO, CALL_PR], ['github_reachability', 'repo_access', 'pr_accessible']],
  ] as const)('all GitHub checks start before any resolves (%s)', async (_name, prNumber, expectedCalls, expectedChecks) => {
    primeSecret('ok');
    const pending = installDeferredFetch();

    const resultPromise = runPreflightChecks(REPO, variantConfig, prNumber, false);
    await settle();

    // Nothing resolved yet, and every check's fetch is already in flight.
    expect(pending.map(p => p.call)).toStrictEqual(expectedCalls);

    // Resolve in reverse to show result order follows check order, not completion order.
    for (const p of [...pending].reverse()) {
      const r = DEFERRED_RESPONSES[p.call.url];
      p.resolve({ ok: r.status >= 200 && r.status < 300, status: r.status, json: async () => r.json });
    }
    const result = await resultPromise;

    expect(pending).toHaveLength(expectedCalls.length);
    expect(timeoutSpy.mock.calls).toStrictEqual(expectedCalls.map(() => [EXPECTED_TIMEOUT_MS]));
    expect(logSpies.logs).toStrictEqual([]);
    expect(normaliseResult(result)).toStrictEqual({
      passed: true,
      checks: expectedChecks.map(check => ({ check, passed: true })),
    });
  });
});
