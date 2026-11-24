// `::narrow` directive suite — consolidated regressions for the
// `::narrow <InstanceType>` redesign:
//
//   * Instance saturation: a bare parametric constructor (`::narrow Array`)
//     narrows to an INSTANCE (`[a]`); over-application is a 2008 arity error;
//     union remainder is computed by HEAD constructor name; invalid directives
//     classify as HM_INVALID_NARROW (2015).
//   * Multi-parameter predicates: the narrowed parameter is ALWAYS the LAST
//     curried parameter; a `[k]` label may link to an earlier parameter and is
//     substituted with the concrete key argument.
//   * Open-row preservation: `::narrow { [k] :: a, ...r }` must absorb a
//     concrete record's other fields so siblings stay reachable.
//   * Cross-module: the resolved typePredicate travels through the export
//     boundary (fpkit `size.js` → `hasProp.js`).

import {
  InferenceEngine,
  classifyDiagnosticCode,
  HM_INVALID_NARROW,
  HM_TYPE_ARITY_MISMATCH,
} from '../../src/index';
import { prettyTypeToString } from '../../src/hm/types';
import type { Type } from '../../src/hm/types';
import { freshEngine, inferSource } from '../helpers/infer';
import { TempProject } from '../helpers/project';

function hoverType(
  r: ReturnType<InferenceEngine['infer']>,
  source: string,
  offset: number,
): string | null {
  let bestStart = -1;
  let bestType: Type | null = null;
  for (const [s, { type, end }] of r.nodeTypes) {
    if (s <= offset && offset < end && s > bestStart) {
      bestStart = s;
      bestType = r.substitution.apply(type);
    }
  }
  return bestType ? prettyTypeToString(bestType) : null;
}

// ---------------------------------------------------------------------------
// From narrowInstanceSaturation.test.ts — the `::narrow <InstanceType>`
// redesign: bare parametric constructors narrow to an instance, not the
// uninhabited nullary constructor; over-application errors; head-name union
// remainder; HM_INVALID_NARROW classification.
// ---------------------------------------------------------------------------

describe('::narrow instance saturation', () => {
  test('bare `::narrow Array` narrows the tested value to an instance `[a]`', () => {
    const source = [
      '// ::narrow Array',
      '// isArray :: a -> Boolean',
      'const isArray = a => Array.isArray(a);',
      '',
      '// use :: a -> Number',
      'const use = v => {',
      '  if (isArray(v)) {',
      '    const probe = v;',
      '    return v.length;',
      '  }',
      '  return 0;',
      '};',
    ].join('\n');
    const r = inferSource(source);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    // `probe = v` is a bare (non-member) use of the narrowed binding.
    const offset = source.indexOf('probe = v') + 'probe = '.length;
    expect(hoverType(r, source, offset)).toBe('[a]');
  });

  test('`::narrow [a]` shorthand narrows to an array instance', () => {
    const source = [
      '// ::narrow [a]',
      '// isArray :: a -> Boolean',
      'const isArray = a => Array.isArray(a);',
      '',
      '// use :: a -> Number',
      'const use = v => {',
      '  if (isArray(v)) {',
      '    const probe = v;',
      '    return v.length;',
      '  }',
      '  return 0;',
      '};',
    ].join('\n');
    const r = inferSource(source);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
    const offset = source.indexOf('probe = v') + 'probe = '.length;
    expect(hoverType(r, source, offset)).toBe('[a]');
  });

  test('over-applied `::narrow Array a a` is a type-arity error (2008)', () => {
    const source = [
      '// ::narrow Array a a',
      '// isArray :: a -> Boolean',
      'const isArray = a => Array.isArray(a);',
    ].join('\n');
    const r = inferSource(source);
    const arityDiag = r.diagnostics.find(d =>
      d.message.includes("'Array'") && d.message.includes('expects'),
    );
    expect(arityDiag).toBeDefined();
    expect(classifyDiagnosticCode(arityDiag!.message)).toBe(HM_TYPE_ARITY_MISMATCH);
  });

  test('union remainder is computed by head constructor name', () => {
    // The false branch must narrow `v` to `String` (the `[Number]` member is
    // removed by head-name match against the saturated `Array a`).
    const source = [
      '// ::narrow Array',
      '// isArray :: a -> Boolean',
      'const isArray = a => Array.isArray(a);',
      '',
      '// use :: ([Number] | String) -> String',
      'const use = v => {',
      '  if (isArray(v)) {',
      '    return "arr";',
      '  }',
      '  return v;',
      '};',
    ].join('\n');
    const r = inferSource(source);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('an invalid `::narrow` directive classifies as HM_INVALID_NARROW', () => {
    const source = [
      '// ::narrow String',
      '// notFn :: Number',
      'const notFn = 5;',
    ].join('\n');
    const r = inferSource(source);
    const narrowDiag = r.diagnostics.find(d => d.message.includes('::narrow'));
    expect(narrowDiag).toBeDefined();
    expect(classifyDiagnosticCode(narrowDiag!.message)).toBe(HM_INVALID_NARROW);
  });
});

// ---------------------------------------------------------------------------
// From narrowMultiParamPredicate.test.ts — `::narrow` predicates whose
// narrowed parameter is NOT the first curried parameter (fpkit `hasProp.js`).
// The narrowed parameter is ALWAYS the LAST curried parameter; a `[k]` label
// may link to an earlier parameter; a label matching no parameter is flagged.
// ---------------------------------------------------------------------------

describe('::narrow on a multi-parameter curried predicate', () => {
  const SRC = `"use strict";
const isDefined = x => true;
const nil = x => false;
// ::narrow { [k] :: a }
// hasPropAlt :: k -> b -> Boolean
const hasPropAlt = key => obj =>
  !nil (obj) && isDefined (obj[key]);
`;

  test('record narrowedType on a multi-parameter predicate does not error', () => {
    const r = inferSource(SRC);
    expect(r.diagnostics.some(d => d.message.includes('::narrow'))).toBe(false);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('predicate narrows the LAST curried parameter (the tested value)', () => {
    const engine = freshEngine();
    const r = engine.infer(SRC);
    expect(r.diagnostics).toHaveLength(0);
    const ann = (engine as any).annotationMap?.get?.('hasPropAlt');
    const predicate = ann?.scheme?.typePredicate;
    expect(predicate).toBeDefined();
    // `obj` is the 2nd curried parameter (index 1); key var `k` comes from
    // the first parameter (index 0).
    expect(predicate.paramIndex).toBe(1);
    expect(predicate.keyVarName).toBe('k');
    expect(predicate.keyParamIndex).toBe(0);
    expect(predicate.narrowedType.tag).toBe('TRecord');
  });

  test('curried predicate call narrows the tested argument in the true branch', () => {
    const r = inferSource(`${SRC}
// describe :: { [k] :: a } -> String
const describe = obj => "ok";

// test :: a -> String
const test = value => {
  if (hasPropAlt ("length") (value)) {
    return describe (value);
  }
  return "fallback";
};
`);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('key label is substituted with the literal key so member access resolves', () => {
    const r = inferSource(`${SRC}
// size :: a -> Number
const size = foldable => {
  if (hasPropAlt ("length") (foldable)) {
    return foldable.length;
  }
  return 0;
};
`);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('predicate can be called with an array (arrays have a length prop)', () => {
    const r = inferSource(`${SRC}
const ok = hasPropAlt ("length") ([2]);
`);
    expect(r.diagnostics).toHaveLength(0);
  });

  test('a label `[k]` that matches no parameter is flagged', () => {
    const r = inferSource(`"use strict";
const isDefined = x => true;
const nil = x => false;
// ::narrow { [m] :: a }
// hasPropAlt :: k -> b -> Boolean
const hasPropAlt = key => obj =>
  !nil (obj) && isDefined (obj[key]);
`);
    expect(r.diagnostics.some(d =>
      d.message.includes('::narrow') && d.message.includes("'[m]'"))).toBe(true);
  });

  test('legacy single-token ::narrow on a single-parameter predicate still works', () => {
    const engine = freshEngine();
    engine.infer(`"use strict";
// ::narrow String
// isString :: a -> Boolean
const isString = x => typeof x === "string";

// use :: (String | Number) -> Number
const use = v => {
  if (isString (v)) {
    return v.length;
  }
  return v;
};
`);
    const ann = (engine as any).annotationMap?.get?.('isString');
    const predicate = ann?.scheme?.typePredicate;
    expect(predicate).toBeDefined();
    expect(predicate.paramIndex).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// From narrowOpenRowPreservesFields.test.ts — `::narrow { [k] :: a, ...r }`
// open-row preservation: when the tested value is ALREADY a concrete record,
// the `...r` tail must absorb its other fields so they stay reachable in the
// true branch (previously siblings like `fold.name` were reported missing).
// ---------------------------------------------------------------------------

describe('::narrow open-row tail preserves the value\'s other fields', () => {
  const PREDICATE = [
    '// ::narrow { [k] :: a, ...r }',
    '// hasProp :: k -> b -> Boolean',
    'const hasProp = key => obj => true;',
  ];

  test('a sibling field stays reachable in the true branch of a concrete record', () => {
    const source = [
      ...PREDICATE,
      'const run = () => {',
      '  const fold = { length: 1, name: "foemp" };',
      '  if (hasProp("length")(fold)) {',
      '    const cp = fold.name;',
      '    return cp;',
      '  }',
      '  return "x";',
      '};',
    ].join('\n');
    const r = inferSource(source);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('the narrowed key field is still usable alongside the preserved tail', () => {
    const source = [
      ...PREDICATE,
      'const run = () => {',
      '  const fold = { length: 1, name: "foemp" };',
      '  if (hasProp("length")(fold)) {',
      '    return fold.length + fold.name.length;',
      '  }',
      '  return 0;',
      '};',
    ].join('\n');
    const r = inferSource(source);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });

  test('a polymorphic parameter narrowing still satisfies a concrete return annotation', () => {
    // The reconciliation must NOT fire for a free/polymorphic value: the
    // narrowed field vars stay generalizable so `foldable.length` can satisfy
    // a `-> Number` return annotation (each use instantiates a fresh copy).
    const source = [
      '// ::narrow { [k] :: a }',
      '// hasProp :: k -> b -> Boolean',
      'const hasProp = key => obj => true;',
      '// size :: a -> Number',
      'const size = foldable => {',
      '  if (hasProp("length")(foldable)) {',
      '    return foldable.length;',
      '  }',
      '  return 0;',
      '};',
    ].join('\n');
    const r = inferSource(source);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// From tests/modules/narrowCrossModuleKeySubstitution.test.ts — cross-module
// `::narrow` (fpkit `size.js` → `hasProp.js`): the resolved typePredicate must
// travel through the export boundary so the consuming module narrows
// `foldable` to `{ length :: a }` and resolves `foldable.length`.
// ---------------------------------------------------------------------------

describe('cross-module ::narrow key-label substitution', () => {
  const project = new TempProject('narrow-cross-module');

  beforeAll(() => {
    project.setup();

    project.write('hasProp.js', [
      'const isDefined = x => true;',
      'const nil = x => false;',
      '// ::narrow { [k] :: a }',
      '// hasProp :: k -> b -> Boolean',
      'export const hasProp = key => obj =>',
      '  !nil (obj) && isDefined (obj[key]);',
      '',
    ].join('\n'));

    // Mirror the real fpkit `hasProp` whose narrowed shape keeps an open row
    // tail (`...r`): the consumer must learn `{ length :: a, ...r }`.
    project.write('hasPropRow.js', [
      'const isDefined = x => true;',
      'const nil = x => false;',
      '// ::narrow { [k] :: a, ...r }',
      '// hasProp :: k -> b -> Boolean',
      'export const hasProp = key => obj =>',
      '  !nil (obj) && isDefined (obj[key]);',
      '',
    ].join('\n'));
  });

  afterAll(() => project.cleanup());

  test('imported predicate narrows the named param and resolves the member access', () => {
    const r = project.inferSource('consumer.js', [
      'import { hasProp } from "./hasProp";',
      '// size :: a -> Number',
      'const size = foldable => {',
      '  if (hasProp ("length") (foldable)) {',
      '    return foldable.length;',
      '  }',
      '  return 0;',
      '};',
    ].join('\n'));
    const diags = r.diagnostics.map(d => d.message);
    expect(diags.filter(d => d.includes('length'))).toEqual([]);
    expect(diags).toEqual([]);
  });

  test('narrowed param keeps the open row tail and hovers as `{ length :: a, ...r }`', () => {
    const source = [
      'import { hasProp } from "./hasPropRow";',
      '// size :: a -> Number',
      'const size = foldable => {',
      '  if (hasProp ("length") (foldable)) {',
      '    const probe = foldable;',
      '    return foldable.length;',
      '  }',
      '  return 0;',
      '};',
    ].join('\n');
    const r = project.inferSource('consumer.js', source);
    expect(r.diagnostics.map(d => d.message)).toEqual([]);

    // `probe = foldable` is a BARE use of the narrowed binding (no member
    // access), so its recorded node type is the generalized record instance.
    // (A `foldable.length` member node shares `foldable`'s start offset and
    // would otherwise mask the identifier's type.)
    const offset = source.indexOf('probe = foldable') + 'probe = '.length;
    expect(hoverType(r, source, offset)).toBe('{ length :: a, ...r }');
  });
});
