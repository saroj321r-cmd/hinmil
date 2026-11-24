// API surface guard for the refactor: the public API of src/index.ts is
// frozen. If this test fails, a refactor changed the public surface — that is
// a breaking change and must be reverted (or explicitly agreed upon).

import * as api from '../../src/index';

describe('public API surface (frozen during refactor)', () => {
  it('exports exactly the frozen set of names', () => {
    const names = Object.keys(api).sort();
    expect(names).toMatchSnapshot();
  });

  it('key entry points are functions/classes', () => {
    expect(typeof (api as any).InferenceEngine).toBe('function');
    expect(typeof (api as any).unify).toBe('function');
    expect(typeof (api as any).parseTypeSignature).toBe('function');
    expect(typeof (api as any).typeToString).toBe('function');
    expect(typeof (api as any).Substitution).toBe('function');
    expect(typeof (api as any).TypeEnv).toBe('function');
  });
});
