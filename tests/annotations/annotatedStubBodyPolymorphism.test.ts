// When a function/method carries a full HM signature, the BODY must never
// determine the displayed types of its parameters, `this`, or its return.
// The annotation is authoritative for display; the body is only *checked*
// against it (and may produce a diagnostic when it disagrees, including
// empty / stub bodies).
//
// Regression: an empty stub body for
//   // natives.Array :: Array a ~> (b -> a -> b) -> b -> b
//   natives.Array = (fn, init) => {}
// previously poisoned the shared return variable `b` to `()`, so hover showed
//   fn  :: () -> a -> ()
//   init :: ()
// instead of the authoritative
//   fn  :: b -> a -> b
//   init :: b

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, prettyTypeToString, Type } from '../../src/hm/types';
import { scrubSkolems } from '../../src/hm/typeUtils';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

interface NodeTypeStore {
  nodeTypes: Map<number, { type: Type }>;
  nodeTypesByEnd: Map<number, { type: Type }>;
  skolemDisplayNames: Map<string, string>;
}

function paramType(src: string, paramName: string): string {
  engine.infer(src);
  const store = engine as unknown as NodeTypeStore;
  // Find the param identifier by its source offset.  Params appear in the
  // function head; search for the standalone identifier.
  const re = new RegExp(`\\b${paramName}\\b`);
  const m = re.exec(src);
  if (!m) return '(not found)';
  const start = m.index;
  const nt = store.nodeTypes.get(start);
  if (!nt) return '(unknown)';
  // Mirror hover: scrub rigid skolems back to the annotation's display letters.
  const t = scrubSkolems(engine.subst.apply(nt.type), store.skolemDisplayNames);
  return prettyTypeToString(t);
}

describe('annotated stub body does not poison param/return display', () => {
  const src = [
    'const natives = {};',
    '// natives.Array :: Array a ~> (b -> a -> b) -> b -> b',
    'natives.Array = fn => init => {};',
  ].join('\n');

  test('fn parameter displays b -> a -> b (not () -> a -> ())', () => {
    expect(paramType(src, 'fn')).toBe('b -> a -> b');
  });

  test('init parameter displays b (not ())', () => {
    expect(paramType(src, 'init')).toBe('b');
  });
});
