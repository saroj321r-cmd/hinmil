import { InferenceEngine } from '../../src/infer';

describe('alias free-var capture across the alias boundary', () => {
  test('constructor return vars derive from alias-typed parameters', () => {
    const src = [
      '// Rej :: e -> ()',
      '// Res :: a -> ()',
      '// Future :: (Rej -> Res -> ()) -> Future e a',
      'function Future(fork) { this.fork = fork; }',
      '',
    ].join('\n');
    const r = new InferenceEngine().infer(src);
    const derivable = r.diagnostics.filter(d =>
      d.message.includes('not derivable from the parameter types'));
    expect(derivable).toHaveLength(0);
  });

  test('an alias free var absent from the return is still not derivable', () => {
    // `Rej :: e -> ()` only supplies `e`; the return names `x` which
    // appears nowhere in the parameters, so the diagnostic still fires.
    const src = [
      '// Rej :: e -> ()',
      '// Box :: (Rej -> ()) -> Box x',
      'function Box(f) { this.f = f; }',
      '',
    ].join('\n');
    const r = new InferenceEngine().infer(src);
    const derivable = r.diagnostics.filter(d =>
      d.message.includes('not derivable from the parameter types'));
    expect(derivable.length).toBeGreaterThan(0);
  });
});
