// Realistic scenarios from the full fpkit lint run.
// Every fixture is a trimmed copy of real fpkit code (path noted per case);
// each scenario checks the positive case (valid code is accepted and typed)
// and, where meaningful, a negative case (a real mistake is still reported).

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { typeToString } from '../../src/hm/types';
import { ImportInferenceContext } from '../../src/services/importContext';
import { getHmDiagnostics } from '../../src/services/hmFileServices';

function inferOne(src: string) {
  const r = new InferenceEngine().infer(src);
  const typeOf = (name: string) => {
    const s = r.topLevelBindings.get(name);
    return s ? typeToString(r.substitution.apply(s.type)) : undefined;
  };
  return { diags: r.diagnostics.map((d) => d.message), typeOf };
}

// ---------------------------------------------------------------------------
// Cross-file: `::rep` crosses an UNANNOTATED intermediate module
// (fpkit src/fl/reduce.js → src/more/foldMap.js → src/more/mconcatMap.js)
// ---------------------------------------------------------------------------

const ROOT = '/tmp/hm-scenarios-fp-library';
const GLOBALS = [
  '// ::constraint Semigroup a { a :: { concat :: a ~> a -> a } }',
  '// ::constraint Monoid a { a :: Semigroup, a :: { empty :: () -> a } }',
  '// ::constraint Foldable f { f :: { reduce :: f a ~> (b -> a -> b) -> b -> b } }',
].join('\n');

function writeFile(rel: string, content: string): void {
  const full = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
}

function inferFile(rel: string, source: string) {
  writeFile(rel, source);
  const fileUri = pathToFileURL(path.join(ROOT, rel)).href;
  const ctx = new ImportInferenceContext(new TextDocuments<TextDocument>(TextDocument as never), { warn: () => {} });
  ctx.setProjectConfig(ROOT, { globalsSource: GLOBALS, globalsFilePath: path.join(ROOT, 'src/globals.js') });
  const engine = new InferenceEngine();
  engine.globalsSource = GLOBALS;
  const r = engine.infer(source, undefined, ctx.createImportResolver(fileUri), ctx.createTypeDirectiveResolver(fileUri), ctx.createImportTypeAliasResolver(fileUri));
  return r.diagnostics.map((d) => d.message);
}

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  writeFile('src/globals.js', GLOBALS + '\n');
  // src/fl/reduce.js (dispatch trimmed to the Array representative)
  writeFile('src/fl/reduce.js', [
    '"use strict";',
    'let natives = {};',
    '',
    '// ::rep Foldable Array#reduce',
    '// natives.Array :: Array a ~> (b -> a -> b) -> b -> b',
    'natives.Array = function (fn) {',
    '  return init => {',
    '    return this.reduce ((acc, x) => fn (acc) (x), init);',
    '  };',
    '};',
    '',
    '// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b',
    'const reduce = fn => init => foldable => foldable.reduce (fn) (init);',
    '',
    'module.exports = reduce;',
  ].join('\n'));
  // src/more/foldMap.js — deliberately UNANNOTATED, as in fpkit
  writeFile('src/more/foldMap.js', [
    '"use strict";',
    'const reduce = require ("../fl/reduce");',
    '',
    'const foldMap = fn => foldable => init =>',
    '  reduce (acc => value => acc.concat (fn (value))) (init) (foldable);',
    '',
    'module.exports = foldMap;',
  ].join('\n'));
  // src/more/mconcatMap.js — annotated, imports only foldMap
  writeFile('src/more/mconcatMap.js', [
    '"use strict";',
    'const foldMap = require ("./foldMap");',
    '',
    '// mconcatMap :: (Monoid m, Foldable f) => (b -> m) -> (a -> b) -> f a -> m',
    'const mconcatMap = typeRep => fn => foldable =>',
    '  foldMap (x => typeRep (fn (x))) (foldable) (typeRep.empty ());',
    '',
    'module.exports = mconcatMap;',
  ].join('\n'));
  // src/Sum/index.js (trimmed)
  writeFile('src/Sum/index.js', [
    '"use strict";',
    '// Sum :: Number -> Sum',
    'function Sum(value) { this.value = value; }',
    '// _Sum :: Number -> Sum',
    'function _Sum(value) { return new Sum (value); }',
    '// _Sum.empty :: () -> Sum',
    '_Sum.empty = () => _Sum (0);',
    '// Sum#concat :: Sum ~> Sum -> Sum',
    'Sum.prototype.concat = function (other) { return _Sum (this.value + other.value); };',
    'module.exports = _Sum;',
  ].join('\n'));
});

describe('::rep Foldable crosses an unannotated intermediate module (fpkit mconcatMap)', () => {
  test('an Array satisfies Foldable through mconcatMap → foldMap → reduce', () => {
    const diags = inferFile('src/more/mconcatMap.spec.js', [
      '"use strict";',
      'const mconcatMap = require ("./mconcatMap");',
      'const Sum = require ("../Sum");',
      '',
      '// total :: Sum',
      'const total = mconcatMap (Sum) (x => x + 1) ([1, 2, 3]);',
    ].join('\n'));
    expect(diags.filter((m) => /Foldable/.test(m))).toEqual([]);
  });

  test('a wrong result type is still reported', () => {
    const diags = inferFile('src/more/mconcatMapWrong.spec.js', [
      '"use strict";',
      'const mconcatMap = require ("./mconcatMap");',
      'const Sum = require ("../Sum");',
      '',
      '// total :: String',
      'const total = mconcatMap (Sum) (x => x + 1) ([1, 2, 3]);',
    ].join('\n'));
    expect(diags.some((m) => /Cannot unify 'Sum' with 'String'|'Sum' but annotation expects 'String'/.test(m))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Rank-2 chainRec (fpkit src/IO/index.js, src/RTask/index.js, src/Future/index.js)
// ---------------------------------------------------------------------------

const STEP = `
// Step :: Done b | Next a
function Step() { throw TypeError ("You can't evaluate Step."); }
// Done :: b -> Step b a
function Done(value) {
  // Step#value :: Step b a ~> (b | a)
  this.value = value;
}
// Next :: a -> Step b a
function Next(value) { this.value = value; }
Done.prototype = Object.create (Step.prototype);
Next.prototype = Object.create (Step.prototype);
// ::narrow Next
// isNext :: a -> Boolean
const isNext = x => x instanceof Next;
// IO :: (() -> a) -> IO a
function IO(run) { this.run = run; }
// _IO :: (() -> a) -> IO a
function _IO(run) { return new IO (run); }
`;

function ioChainRec(annotation: string, returned: string): string {
  return `${STEP}
// _IO.chainRec :: ${annotation}
_IO.chainRec = function (fn) {
  return value => {
    return _IO (() => {
      let acc = new Next (value);
      while (isNext (acc)) {
        acc = fn (x => new Next (x)) (x => new Done (x)) (acc.value).run ();
      }
      return ${returned};
    });
  };
};
`;
}

describe('chainRec trampolines need a rank-2 stepper (fpkit IO/RTask/Future)', () => {
  const RANK2 = '(forall c. (a -> c) -> (b -> c) -> a -> IO c) -> a -> IO b';

  test('the rank-2 annotation accepts the trampoline', () => {
    const { diags } = inferOne(ioChainRec(RANK2, 'acc.value'));
    expect(diags.filter((m) => /chainRec|Type mismatch/.test(m))).toEqual([]);
  });

  test('returning the Step instead of its value is reported', () => {
    const { diags } = inferOne(ioChainRec(RANK2, 'acc'));
    // Reported in the body (checked against rigid skolems) or on the binding.
    expect(diags.some((m) => /IO \(Step b a\)|Cannot unify 'Step b a' with 'b'/.test(m))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Sum-type methods declared on the parent type (fpkit src/Validation/index.js)
// ---------------------------------------------------------------------------

describe('sumtype methods: Validation#swap catches the swapped-variant bug', () => {
  const VALIDATION = (failureSwap: string, successSwap: string) => `
// Validation :: Failure e | Success a
function Validation() { throw TypeError ("no"); }
// Failure :: e -> Validation e a
function Failure(value) {
  // Validation#value :: Validation e a ~> e | a
  this.value = value;
}
// Success :: a -> Validation e a
function Success(value) { this.value = value; }
Failure.prototype = Object.create (Validation.prototype);
Success.prototype = Object.create (Validation.prototype);
// _Failure :: e -> Validation e a
function _Failure(value) { return new Failure (value); }
// _Success :: a -> Validation e a
function _Success(value) { return new Success (value); }

// Validation#swap :: Validation e a ~> () -> Validation a e
Failure.prototype.swap = function () {
  return ${failureSwap} (this.value);
};

Success.prototype.swap = function () {
  return ${successSwap} (this.value);
};
`;

  test('the correct swap is accepted', () => {
    const { diags } = inferOne(VALIDATION('_Success', '_Failure'));
    expect(diags).toEqual([]);
  });

  test('the original fpkit bug (Failure#swap returned a Failure) is reported', () => {
    const { diags } = inferOne(VALIDATION('_Failure', '_Success'));
    expect(diags.some((m) => /Cannot unify '(e|a)' with '(a|e)'/.test(m))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Standard globals used by fpkit (src/parser/parseInt.js, Future/Free specs)
// ---------------------------------------------------------------------------

describe('standard globals', () => {
  test('fpkit parseInt_: new RegExp (pattern, flags) and parseInt (s, radix)', () => {
    const { diags } = inferOne(`
// parseIntRadix :: Number -> String -> Number
const parseIntRadix = radix => s => {
  const charset = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ".slice (0, radix);
  const pattern = new RegExp ("^[" + charset + "]+$", "i");
  return pattern.test (s) ? parseInt (s, radix) : NaN;
};
`);
    expect(diags).toEqual([]);
  });

  test('a non-numeric radix is reported', () => {
    const { diags } = inferOne(`
// p :: String -> Number
const p = s => parseInt (s, "16");
`);
    expect(diags.some((m) => /Number \| Undefined/.test(m))).toBe(true);
  });

  test('performance.now / eval in a timing spec (fpkit Future/index.spec.js)', () => {
    const { diags } = inferOne(`
// elapsed :: (() -> a) -> Number
const elapsed = thunk => {
  const begin = performance.now ();
  thunk ();
  return performance.now () - begin;
};
// roundTrip :: String -> Number
const roundTrip = s => eval (s);
`);
    expect(diags).toEqual([]);
  });

  test('Date is a constructor and a TypeRep (fpkit fl/equals.spec.js, predicate/is.js)', () => {
    const { diags } = inferOne(`
// is :: TypeRep f -> a -> Boolean
const is = rep => x => true;
// start :: Number -> Date
const start = ms => new Date (ms);
// season :: Number -> Date
const season = year => new Date (year, 7, 1);
// now :: () -> Number
const now = () => Date.now ();
// isDate :: a -> Boolean
const isDate = x => is (Date) (x);
`);
    expect(diags).toEqual([]);
  });

  test('new Date has type Date, not Number', () => {
    const { diags } = inferOne(`
// start :: Number -> Number
const start = ms => new Date (ms);
`);
    expect(diags.some((m) => /Cannot unify 'Date' with 'Number'/.test(m))).toBe(true);
  });

  test('performance.now is typed, not Any', () => {
    const { diags } = inferOne(`
// stamp :: () -> String
const stamp = () => performance.now ();
`);
    expect(diags.some((m) => /Cannot unify 'Number' with 'String'/.test(m))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Actionable diagnostics for annotation and scoping mistakes
// ---------------------------------------------------------------------------

describe('diagnostics and scoping', () => {
  test('an unconstrained higher-kinded variable explains the fix (fpkit lst/dropWhile.js)', () => {
    const { diags } = inferOne(`
// appendOrNot :: Boolean -> f a -> a -> f a
const appendOrNot = drop => xs => x => drop ? xs : xs;
`);
    expect(diags.some((m) => /Type variable 'f' is applied to 'a' but has no constraint/.test(m))).toBe(true);
  });

  test('a concrete type in the constraint list is explained (fpkit Id/IdT.js)', () => {
    const { diags } = inferOne(`
// _T :: (TypeRep M, Monad m) => M -> IdT
const _T = M => M;
`);
    expect(diags.some((m) => /each constraint must be a class applied to a lowercase type variable/.test(m))).toBe(true);
  });

  test('a reference above an unannotated const is hoisted (fpkit Free/index.js)', () => {
    const { diags } = inferOne(`
const fallback = monad => method => (monad[method] || fallbacks[method] (monad));
const fallbacks = { map: monad => fn => monad };
`);
    expect(diags).toEqual([]);
  });

  test('main-above-helpers: the forward use flows into the helper, which stays polymorphic', () => {
    const { diags, typeOf } = inferOne(`
// main :: Number -> Number
const main = n => double (n);
const double = x => x;
const label = double ("a");
`);
    expect(diags).toEqual([]);
    expect(typeOf('label')).toBe('String');
  });

  test('a forward-referenced annotated helper used at the wrong type is reported', () => {
    const { diags } = inferOne(`
// main :: Number -> String
const main = n => shout (n);
// shout :: String -> String
const shout = s => s.toUpperCase ();
`);
    expect(diags.some((m) => /Cannot unify 'Number' with 'String'|Cannot unify 'String' with 'Number'/.test(m))).toBe(true);
  });

  test('a genuinely unknown name keeps the plain message', () => {
    const { diags } = inferOne('const x = notDefinedAnywhere + 1;');
    expect(diags).toContain("Unbound variable: 'notDefinedAnywhere'");
  });
});

// ---------------------------------------------------------------------------
// Generated SqlKit client sidecar inside sqlkit's own repository
// (sqlkit-introspect/sqlkit src/generated/client/index.hm: `::types sqlkit`)
// ---------------------------------------------------------------------------


describe('::types <own package> in a generated .hm sidecar (sqlkit-introspect)', () => {
  const PKG = '/tmp/hm-scenarios-sqlkit-self';
  const clientHm = (extra: string) => [
    '// AUTO-GENERATED by sqlkit introspect.  Do not edit by hand.',
    '::types sqlkit',
    '',
    'Selector :: (String | Prop t a p | QueryTag p o | Table b)',
    extra,
  ].join('\n');

  beforeAll(() => {
    fs.rmSync(PKG, { recursive: true, force: true });
    fs.mkdirSync(path.join(PKG, 'src/generated/client'), { recursive: true });
    fs.writeFileSync(path.join(PKG, 'package.json'), JSON.stringify({
      name: 'sqlkit', version: '5.1.23', main: './build/index.js',
      'hinmil': { sidecars: ['./sqlkit.hm', '../.sqlkit/client/index.hm'] },
    }));
    fs.writeFileSync(path.join(PKG, 'sqlkit.hm'), [
      'Prop :: (String, a) -> Prop t a p',
      'QueryTag :: (Table b, [Selector]) -> QueryTag p o',
      'Table :: String -> Table b',
    ].join('\n'));
  });

  test('sqlkit constructors resolve through the package self-reference', () => {
    const file = path.join(PKG, 'src/generated/client/index.hm');
    const src = clientHm('');
    const diags = getHmDiagnostics(pathToFileURL(file).href, src).map((d) => d.message);
    expect(diags.filter((m) => /Unknown type constructor/.test(m))).toEqual([]);
  });

  test('a constructor sqlkit does not declare is still unknown', () => {
    const file = path.join(PKG, 'src/generated/client/index.hm');
    const src = clientHm('Paged :: QueryTag p o -> Pager p o');
    const diags = getHmDiagnostics(pathToFileURL(file).href, src).map((d) => d.message);
    expect(diags).toContain("Unknown type constructor 'Pager'");
  });
});

// ---------------------------------------------------------------------------
// A user type named `Tuple` (fpkit src/Tuple/index.js + Tuple2.js) must not be
// confused with hinmil's internal multi-parameter tuple.
// ---------------------------------------------------------------------------

describe('user-defined Tuple type (fpkit Tuple)', () => {
  const TUPLE = `
// Tuple :: (Number, Array a) -> Tuple Number a
function Tuple(n, parts) {
  this.n = n;
  this.parts = parts;
}

// Tuple#n :: Tuple Number a ~> Number
// Tuple#parts :: Tuple Number a ~> [a]

// Tuple2 :: a -> a -> Tuple Number a
const Tuple2 = a => b => new Tuple (2, [a, b]);
`;

  test('a Tuple value keeps its own fields and is not a parameter tuple', () => {
    const { diags, typeOf } = inferOne(`${TUPLE}
const rates = Tuple2 (1.85) (2.1);
// size :: Number
const size = rates.n;
// first :: Number
const first = rates.parts[0];
`);
    expect(diags).toEqual([]);
    expect(typeOf('rates')).toBe('Tuple Number Number');
  });

  test('a Tuple is not accepted where a two-argument call is expected', () => {
    const { diags } = inferOne(`${TUPLE}
// margin :: (Number, Number) -> Number
const margin = (home, away) => 1 / home + 1 / away - 1;
// m :: Number
const m = margin (Tuple2 (1.85) (2.1));
`);
    expect(diags.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// An alias used only inside a method annotation loaded via `::types`
// (fpkit src/express/Component.js: `Component#matchWith :: Component ~>
// { Engine :: String -> EngineFn -> a, … } -> a`, used by create.js)
// ---------------------------------------------------------------------------

describe('aliases inside ::types-loaded method annotations (fpkit express)', () => {
  const COMPONENT = [
    '"use strict";',
    '// EngineFn :: (String, Object String Any, (e, String) -> ()) -> ()',
    '// ExpressApp :: { engine :: (String, EngineFn) -> () }',
    '',
    '// Engine :: (String, EngineFn) -> Component',
    'function Engine(ext, handler) {',
    '  this.ext = ext;',
    '  this.handler = handler;',
    '}',
    '// Component#matchWith :: Component ~> { Engine :: String -> EngineFn -> a } -> a',
    'Engine.prototype.matchWith = function (cases) {',
    '  return cases.Engine (this.ext) (this.handler);',
    '};',
    'module.exports = Engine;',
  ].join('\n');

  test('the alias expands, so the matched handler fits the app method', () => {
    writeFile('src/express/Component.js', COMPONENT);
    const diags = inferFile('src/express/create.js', [
      '"use strict";',
      '// ::types ./Component',
      '',
      '// configure :: ExpressApp -> Component -> ExpressApp',
      'const configure = app => component => {',
      '  component.matchWith ({ Engine: ext => handler => { app.engine (ext, handler); } });',
      '  return app;',
      '};',
      'module.exports = configure;',
    ].join('\n'));
    expect(diags).toEqual([]);
  });

  test('passing something else than the handler is still reported', () => {
    writeFile('src/express/Component.js', COMPONENT);
    const diags = inferFile('src/express/createWrong.js', [
      '"use strict";',
      '// ::types ./Component',
      '',
      '// configure :: ExpressApp -> Component -> ExpressApp',
      'const configure = app => component => {',
      '  component.matchWith ({ Engine: ext => handler => { app.engine (ext, ext); } });',
      '  return app;',
      '};',
      'module.exports = configure;',
    ].join('\n'));
    expect(diags.some((m) => /Cannot unify 'String' with/.test(m))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// fpkit Result/validateSpec.js (from an Express API): a 4-parameter
// helper whose body partially applies a curried function, and
// Object.assign over records and dictionaries.
// ---------------------------------------------------------------------------

describe('Result/validateSpec patterns', () => {
  // fpkit more/curry.js signature + object/objOf.js
  const OBJ_OF = `
// curry :: ((a, ...) -> z) -> a -> ... -> z
const curry = fn => fn;
// objOf :: String -> a -> { [k] :: a }
const objOf = curry ((key, value) => ({ [key]: value }));
`;

  test('a helper returning a partial application is NOT itself curried', () => {
    const { diags } = inferOne(`${OBJ_OF}
const wrapKey = (k, rules, obj, updating) => rules.map (objOf (k));
const run = spec => Object.keys (spec).map (k => wrapKey (k, spec[k], {}, false));
`);
    expect(diags.filter((m) => /Curried function called with/.test(m))).toEqual([]);
  });

  test('Object.assign merges records field by field', () => {
    const { diags } = inferOne(`
// merge :: { home :: Number } -> { away :: Number } -> { home :: Number, away :: Number }
const merge = h => a => Object.assign ({}, h, a);
`);
    expect(diags).toEqual([]);
  });

  test('Object.assign merges dictionaries and keeps their value type', () => {
    expect(inferOne(`
// mergeOdds :: (Object String Number, Object String Number) -> Object String Number
const mergeOdds = (a, b) => Object.assign ({}, a, b);
`).diags).toEqual([]);
    expect(inferOne(`
// mergeOdds :: (Object String Number, Object String Number) -> Object String String
const mergeOdds = (a, b) => Object.assign ({}, a, b);
`).diags).toContain("Type mismatch: Cannot unify '{ [String] :: Number }' with '{ [String] :: String }'");
  });
});
