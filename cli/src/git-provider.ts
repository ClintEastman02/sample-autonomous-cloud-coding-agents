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
 * Hand-written mirror of ``contracts/constants.json`` ``git_providers`` (ADR-025 §1).
 *
 * The contract file sits outside the package's published ``files: ["lib"]``
 * whitelist, so it cannot be imported at runtime. ``test/constants-parity.test.ts``
 * fails CI if these literals drift from the contract.
 */

/** Providers the platform can actually run tasks against today. */
export const GIT_PROVIDERS_IMPLEMENTED: readonly string[] = ['github'];

/** Value a RepoTable row resolves to when it carries no ``git_provider``. */
export const DEFAULT_GIT_PROVIDER = 'github';

/** Exact-match membership check (no case folding or trimming, per ADR-025 §9). */
export function isImplementedGitProvider(value: unknown): boolean {
  return typeof value === 'string' && GIT_PROVIDERS_IMPLEMENTED.includes(value);
}
