// Scenario: a curry/compose utils module consumed by an app.
//
// utils.js mirrors the style of sample/readme/curry.js and
// sample/readme/pipe-compose.js: an explicit `curry` wrapper (spread-tuple
// annotation `(a, b, ...) -> z`), a variadic `pipe`/`compose` pair, and a
// plain uncurried `add` that the module curries before exporting.
//
// app.js consumes the utilities in a point-free style.  We assert the types
// of partially applied and composed functions and that wrong-argument usage
// is diagnosed.

import { TempProject } from '../helpers/project';
import { prettyTypeToString, Scheme } from '../../src/hm/types';

const project = new TempProject('scenario-utils-pipeline');

const UTILS_JS = `// curry :: ((a, b, ...) -> z) -> a -> b -> ... -> z
const curry = (fn) => {
  const collect = (...args) => {
    if (args.length >= fn.length) return fn(...args);
    return (...next) => collect(...args, ...next);
  };
  return collect;
};

// pipe :: ((a -> b), (b -> c), ..., (y -> z)) -> a -> z
const pipe = (...fns) => fns.reduce((acc, fn) => (x) => fn(acc(x)));

// compose :: ((y -> z), ..., (b -> c), (a -> b)) -> a -> z
const compose = (...fns) => fns.reduceRight((acc, fn) => (x) => fn(acc(x)));

// add :: (Number, Number) -> Number
const add = (a, b) => a + b;

const curriedAdd = curry(add);

export { curry, pipe, compose, add, curriedAdd };
`;

const APP_JS = `import { pipe, compose, curriedAdd } from './utils.js';

// Partial application: applying one Number leaves Number -> Number.
const inc = curriedAdd(1);
const three = inc(2);

// Point-free usage: the partially applied adder works as a map callback.
const bumped = [1, 2, 3].map(curriedAdd(10));

// An annotated first stage pins the pipeline's input type: a bare
// \`(s) => s.trim()\` stage would stay polymorphic (\`a -> Number\`) because
// unconstrained property access does not pin \`s\` to String.
// trimmed :: String -> String
const trimmed = (s) => s.trim();

// A left-to-right pipeline: String -> Number.
const sizeOfTrimmed = pipe(
  trimmed,
  (s) => s.length,
  (n) => n + 1,
);

// The same pipeline right-to-left with compose.
const sizeOfTrimmed2 = compose(
  (n) => n + 1,
  (s) => s.length,
  trimmed,
);

const answer = sizeOfTrimmed('  hello  ');

export { inc, three, bumped, sizeOfTrimmed, sizeOfTrimmed2, answer };
`;

function exportType(res: { exports: Map<string, Scheme> }, name: string): string {
  const scheme = res.exports.get(name);
  expect(scheme).toBeDefined();
  return prettyTypeToString(scheme!.type);
}

beforeAll(() => {
  project.setup();
  project.write('src/utils.js', UTILS_JS);
  project.write('src/app.js', APP_JS);
});

afterAll(() => project.cleanup());

describe('utils.js in isolation', () => {
  it('infers cleanly', () => {
    const res = project.inferFile('src/utils.js');
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
  });

  it('currying add yields the fully collect signature', () => {
    const res = project.inferFile('src/utils.js');
    expect(exportType(res, 'curriedAdd')).toBe('Number -> Number -> Number');
  });
});

describe('app.js — point-free consumer', () => {
  it('produces zero diagnostics', () => {
    const res = project.inferFile('src/app.js');
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
  });

  it('partially applied add is Number -> Number and applies to Number', () => {
    const res = project.inferFile('src/app.js');
    expect(exportType(res, 'inc')).toBe('Number -> Number');
    expect(exportType(res, 'three')).toBe('Number');
  });

  it('mapping a partially applied adder over [Number] keeps [Number]', () => {
    const res = project.inferFile('src/app.js');
    expect(exportType(res, 'bumped')).toBe('[Number]');
  });

  it('pipe and compose both infer the end-to-end String -> Number', () => {
    const res = project.inferFile('src/app.js');
    expect(exportType(res, 'sizeOfTrimmed')).toBe('String -> Number');
    expect(exportType(res, 'sizeOfTrimmed2')).toBe('String -> Number');
    expect(exportType(res, 'answer')).toBe('Number');
  });
});

describe('misuse is diagnosed', () => {
  // NOTE: a plain wrong-argument call to an IMPORTED function (e.g.
  // `curriedAdd('one')`) is deliberately lenient — the engine auto-unions
  // argument mismatches unless the callee is annotated in the current file.
  // The realistic failures below all surface real diagnostics.

  it('forgetting the second application and using the function as a Number is reported', () => {
    const res = project.inferSource('src/bad1.js', `import { curriedAdd } from './utils.js';
const oops = curriedAdd(1) * 2;
export { oops };
`);
    const msgs = res.diagnostics.map(d => d.message);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.some(m => m.includes('Number -> Number') && m.includes('Number'))).toBe(true);
  });

  it('feeding a Number into an annotated String -> Number pipeline is reported', () => {
    const res = project.inferSource('src/bad2.js', `import { pipe } from './utils.js';

// shout :: String -> String
const shout = (s) => s.toUpperCase() + '!';

// loudLen :: String -> Number
const loudLen = pipe(shout, (s) => s.length);

const oops = loudLen(42);
export { oops };
`);
    const msgs = res.diagnostics.map(d => d.message);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.some(m => m.includes('String') && m.includes('Number'))).toBe(true);
  });
});
