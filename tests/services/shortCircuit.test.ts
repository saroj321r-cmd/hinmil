// ============================================================================
// Source-identity short-circuit / globals-generation invalidation.
//
// `canShortCircuit` decides whether the language server may republish cached
// diagnostics instead of re-inferring a document.  These tests pin down the
// invariant that a globals reload (which bumps the generation) defeats the
// short-circuit even when the document's own text is unchanged.
// ============================================================================

import { canShortCircuit } from '../../src/services/shortCircuit';

describe('canShortCircuit', () => {
  const SRC = 'const x = 1;';

  it('reuses when source identical, cached, and same generation', () => {
    expect(canShortCircuit({
      prevSource: SRC,
      source: SRC,
      hasCached: true,
      prevGeneration: 3,
      currentGeneration: 3,
    })).toBe(true);
  });

  it('re-infers when the globals generation has advanced', () => {
    // Same text, still cached — but globals were reloaded since last validate.
    expect(canShortCircuit({
      prevSource: SRC,
      source: SRC,
      hasCached: true,
      prevGeneration: 3,
      currentGeneration: 4,
    })).toBe(false);
  });

  it('re-infers when the document text changed', () => {
    expect(canShortCircuit({
      prevSource: SRC,
      source: SRC + '\n',
      hasCached: true,
      prevGeneration: 1,
      currentGeneration: 1,
    })).toBe(false);
  });

  it('re-infers when there is no cached result', () => {
    expect(canShortCircuit({
      prevSource: SRC,
      source: SRC,
      hasCached: false,
      prevGeneration: 1,
      currentGeneration: 1,
    })).toBe(false);
  });

  it('re-infers when the document was never validated (no prev source/generation)', () => {
    expect(canShortCircuit({
      prevSource: undefined,
      source: SRC,
      hasCached: false,
      prevGeneration: undefined,
      currentGeneration: 0,
    })).toBe(false);
  });
});
