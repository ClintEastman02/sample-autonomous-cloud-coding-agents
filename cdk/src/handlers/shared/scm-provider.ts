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

import type { PreflightCheckResult } from './preflight';

/**
 * Handler-side SCM provider (ADR-025 §2).
 *
 * Each method enters this interface in the PR that gives it a call site; today the
 * only caller is preflight. Token resolution stays outside the interface: callers
 * resolve the token and pass it in. The GitHub implementation delegates to the
 * existing check functions in `preflight.ts`.
 */
export interface ScmProvider {
  checkReachability(token: string): Promise<PreflightCheckResult>;
  checkRepoAccess(repo: string, token: string, readOnly: boolean): Promise<PreflightCheckResult>;
  checkPrAccessible(repo: string, prNumber: number, token: string): Promise<PreflightCheckResult>;
}
