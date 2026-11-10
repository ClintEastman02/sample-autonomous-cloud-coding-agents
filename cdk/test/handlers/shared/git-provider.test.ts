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

import sharedConstants from '../../../../contracts/constants.json';
// Importing the module at all proves the code's IMPLEMENTED_IDS equals the contract:
// the module throws at load time otherwise (exercised under a mocked contract below).
import { resolveGitProvider } from '../../../src/handlers/shared/git-provider';

describe('git_providers contract (ADR-025 §1)', () => {
  const { vocabulary, implemented, default: defaultProvider } = sharedConstants.git_providers;

  test('implemented is a non-empty subset of the vocabulary', () => {
    expect(implemented.length).toBeGreaterThan(0);
    for (const id of implemented) expect(vocabulary).toContain(id);
  });

  test('the default is an implemented provider', () => {
    expect(implemented).toContain(defaultProvider);
  });
});

describe('IMPLEMENTED_IDS ↔ contract drift guard', () => {
  // Widening `git_providers.implemented` without widening IMPLEMENTED_IDS (or the
  // reverse: narrowing the contract below the code) makes the module refuse to load.
  test.each([
    ['contract wider than IMPLEMENTED_IDS', ['github', 'gitlab']],
    ['contract narrower than IMPLEMENTED_IDS', []],
    ['contract disjoint from IMPLEMENTED_IDS', ['gitlab']],
  ])('module load throws when %s', (_label, contractImplemented) => {
    jest.isolateModules(() => {
      jest.doMock('../../../../contracts/constants.json', () => ({
        ...sharedConstants,
        git_providers: { ...sharedConstants.git_providers, implemented: contractImplemented },
      }));
      // eslint-disable-next-line @typescript-eslint/no-require-imports -- fresh load under the mocked contract
      expect(() => require('../../../src/handlers/shared/git-provider')).toThrow(
        /git_providers\.implemented .* does not match IMPLEMENTED_IDS/,
      );
    });
    jest.dontMock('../../../../contracts/constants.json');
  });
});

describe('resolveGitProvider', () => {
  test('undefined (absent attribute) resolves to github', () => {
    expect(resolveGitProvider(undefined)).toBe('github');
    expect(resolveGitProvider()).toBe('github');
  });

  test('github is kept', () => {
    expect(resolveGitProvider('github')).toBe('github');
  });

  test.each([
    ['', "''"],
    ['GitHub', "'GitHub'"],
    [' github', "' github'"],
    ['github ', "'github '"],
    ['gitlab', "'gitlab'"],
    ['bitbucket', "'bitbucket'"],
    [null, 'null'],
    [42, '42'],
    [false, 'false'],
    [{ id: 'github' }, '{"id":"github"}'],
    [['github'], '["github"]'],
  ])('rejects %p with a message naming the value', (value, shown) => {
    expect(() => resolveGitProvider(value)).toThrow(`unsupported git_provider ${shown}`);
  });

  test('values JSON cannot render fall back to String()', () => {
    expect(() => resolveGitProvider(Symbol('x'))).toThrow('unsupported git_provider Symbol(x)');
    expect(() => resolveGitProvider(() => 1)).toThrow(/^unsupported git_provider \(\) => 1$/);
    expect(() => resolveGitProvider(10n)).toThrow('unsupported git_provider 10');
  });

  test('the rendered value is truncated to 64 chars with an ellipsis', () => {
    const long = 'x'.repeat(200);
    let message = '';
    try {
      resolveGitProvider(long);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toBe(`unsupported git_provider '${'x'.repeat(63)}…`);
  });
});
