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
 * Git provider resolution (ADR-025 §1, §9).
 *
 * Dependency-free on purpose: both runtime handlers and (later) constructs import
 * it, so it must not pull in the CDK or any handler module. The provider list comes
 * from ``contracts/constants.json`` → ``git_providers``, the same contract the agent
 * (``shared_constants.py``) and the CLI mirror read.
 */

import sharedConstants from '../../../../contracts/constants.json';

/**
 * Provider ids this code can actually drive. The type is derived from this list, and
 * the module refuses to load unless it equals the contract's `git_providers.implemented`
 * exactly — widening either side without the other fails at import time.
 */
const IMPLEMENTED_IDS = ['github'] as const;

/** A provider id the platform can actually drive today (`git_providers.implemented`). */
export type GitProviderId = (typeof IMPLEMENTED_IDS)[number];

const IMPLEMENTED: readonly string[] = sharedConstants.git_providers.implemented;

/** True when `a` and `b` hold exactly the same set of ids (order-insensitive). */
function sameIdSet(a: readonly string[], b: readonly string[]): boolean {
  const left = new Set(a);
  const right = new Set(b);
  return left.size === right.size && [...left].every((id) => right.has(id));
}

if (!sameIdSet(IMPLEMENTED, IMPLEMENTED_IDS)) {
  throw new Error(
    `git_providers.implemented ${JSON.stringify(IMPLEMENTED)} does not match IMPLEMENTED_IDS ${JSON.stringify(IMPLEMENTED_IDS)}`,
  );
}

const MAX_RENDERED_VALUE = 64;

/** Render a rejected value for the error message: quoted strings, JSON otherwise, truncated. */
function renderValue(value: unknown): string {
  let rendered: string;
  if (typeof value === 'string') {
    rendered = `'${value}'`;
  } else {
    let json: string | undefined;
    try {
      json = JSON.stringify(value);
    } catch {
      json = undefined;
    }
    rendered = json ?? String(value);
  }
  return rendered.length > MAX_RENDERED_VALUE ? `${rendered.slice(0, MAX_RENDERED_VALUE)}…` : rendered;
}

/**
 * Resolve a stored or payload `git_provider` value.
 *
 * The default parameter covers `undefined` only: an absent RepoTable attribute (or a
 * checkpointed config from before this field existed) means GitHub. Every other value
 * must be an exact member of `implemented` — no case folding, no trimming — and
 * anything else (including `null` and `''`) throws so the task fails with a named
 * reason instead of acting against github.com.
 */
export function resolveGitProvider(
  value: unknown = sharedConstants.git_providers.default,
): GitProviderId {
  // TODO(ADR-025 §7, Phase 4): accept implemented ∩ enabled DeploymentFeatures providers.
  if (typeof value === 'string' && IMPLEMENTED.includes(value)) return value as GitProviderId;
  throw new Error(`unsupported git_provider ${renderValue(value)}`);
}
