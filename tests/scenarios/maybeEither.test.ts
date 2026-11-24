// Scenario: a small functional library project.
//
// The "project" consists of three files written the way a real user would
// write them (annotation style copied from sample/Maybe.js / sample/Either.js):
//
//   src/Maybe.js  — Just/Nothing sum type (`// Maybe :: Just a | Nothing`)
//                   with annotated map/chain/fold and helper constructors.
//   src/Either.js — Left/Right sum type with map/chain/fold.
//   src/app.js    — imports both and builds a safeDivide + parsing pipeline.
//
// We assert that the clean app produces zero diagnostics, that the exported
// bindings have the exact types a user would expect to see on hover, and
// that a deliberately broken variant of the app IS flagged with a helpful
// message.

import { TempProject } from '../helpers/project';
import { prettyTypeToString, Scheme } from '../../src/hm/types';

const project = new TempProject('scenario-maybe-either');

const MAYBE_JS = `// Maybe :: Just a | Nothing

// Just :: a -> Maybe a
class Just {
  constructor(value) {
    // Maybe#value :: Maybe a ~> a
    this.value = value;
  }

  // Maybe#map :: Maybe a ~> (a -> b) -> Maybe b
  map(fn) {
    return new Just(fn(this.value));
  }

  // Maybe#chain :: Maybe a ~> (a -> Maybe b) -> Maybe b
  chain(fn) {
    return fn(this.value);
  }

  // Maybe#fold :: Maybe a ~> (() -> b, a -> b) -> b
  fold(_onNothing, onJust) {
    return onJust(this.value);
  }

  // Maybe.of :: a -> Maybe a
  static of(value) {
    return new Just(value);
  }
}

// Nothing :: () -> Maybe a
class Nothing {
  map(_fn) {
    return new Nothing();
  }

  chain(_fn) {
    return new Nothing();
  }

  fold(onNothing, _onJust) {
    return onNothing();
  }
}

// just :: a -> Maybe a
const just = (value) => new Just(value);

// nothing :: () -> Maybe a
const nothing = () => new Nothing();

export { Just, Nothing, just, nothing };
`;

const EITHER_JS = `// Either :: Left e | Right a

// Left :: e -> Either e a
class Left {
  constructor(value) {
    // Either#value :: Either e a ~> (e | a)
    this.value = value;
  }

  // Either#map :: Either e a ~> (a -> b) -> Either e b
  map(_fn) {
    return new Left(this.value);
  }

  // Either#chain :: Either e a ~> (a -> Either e b) -> Either e b
  chain(_fn) {
    return new Left(this.value);
  }

  // Either#fold :: Either e a ~> (e -> c, a -> c) -> c
  fold(onLeft, _onRight) {
    return onLeft(this.value);
  }
}

// Right :: a -> Either e a
class Right {
  constructor(value) {
    this.value = value;
  }

  map(fn) {
    return new Right(fn(this.value));
  }

  chain(fn) {
    return fn(this.value);
  }

  fold(_onLeft, onRight) {
    return onRight(this.value);
  }
}

// left :: e -> Either e a
const left = (e) => new Left(e);

// right :: a -> Either e a
const right = (a) => new Right(a);

export { Left, Right, left, right };
`;

// The happy-path application: divide safely, parse user input, chain the
// two pipelines together and fold back out to plain values.
const APP_JS = `import { just, nothing } from './Maybe.js';
import { left, right } from './Either.js';

// safeDivide :: Number -> Number -> Maybe Number
const safeDivide = (num) => (den) =>
  den === 0 ? nothing() : just(num / den);

// halfOf :: Number -> Maybe Number
const halfOf = (n) => safeDivide(n)(2);

// describeRatio :: Number -> String
const describeRatio = (den) =>
  safeDivide(100)(den)
    .map((x) => x * 2)
    .chain(halfOf)
    .fold(() => 'no ratio', (x) => 'ratio: ' + String(x));

// parseAge :: String -> Either String Number
const parseAge = (raw) => {
  const n = Number(raw);
  return Number.isNaN(n) ? left('not a number: ' + raw) : right(n);
};

// ageBadge :: String -> String
const ageBadge = (raw) =>
  parseAge(raw)
    .map((age) => age + 1)
    .fold((err) => err, (age) => 'age ' + String(age));

export { safeDivide, halfOf, describeRatio, parseAge, ageBadge };
`;

function exportType(res: { exports: Map<string, Scheme> }, name: string): string {
  const scheme = res.exports.get(name);
  expect(scheme).toBeDefined();
  return prettyTypeToString(scheme!.type);
}

beforeAll(() => {
  project.setup();
  project.write('src/Maybe.js', MAYBE_JS);
  project.write('src/Either.js', EITHER_JS);
  project.write('src/app.js', APP_JS);
});

afterAll(() => project.cleanup());

describe('Maybe module in isolation', () => {
  it('infers cleanly and exports the annotated constructors', () => {
    const res = project.inferFile('src/Maybe.js');
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
    expect(exportType(res, 'just')).toBe('a -> Maybe a');
    expect(exportType(res, 'nothing')).toBe('() -> Maybe a');
  });
});

describe('Either module in isolation', () => {
  it('infers cleanly and exports the annotated constructors', () => {
    const res = project.inferFile('src/Either.js');
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
    expect(exportType(res, 'left')).toBe('e -> Either e a');
    expect(exportType(res, 'right')).toBe('a -> Either e a');
  });
});

describe('app.js — the happy path', () => {
  it('produces zero diagnostics for the whole pipeline', () => {
    const res = project.inferFile('src/app.js');
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
  });

  it('exports the expected types for the Maybe pipeline', () => {
    const res = project.inferFile('src/app.js');
    expect(exportType(res, 'safeDivide')).toBe('Number -> Number -> Maybe Number');
    expect(exportType(res, 'halfOf')).toBe('Number -> Maybe Number');
    expect(exportType(res, 'describeRatio')).toBe('Number -> String');
  });

  it('exports the expected types for the Either pipeline', () => {
    const res = project.inferFile('src/app.js');
    expect(exportType(res, 'parseAge')).toBe('String -> Either String Number');
    expect(exportType(res, 'ageBadge')).toBe('String -> String');
  });
});

describe('app-broken.js — deliberate misuse is flagged', () => {
  it('reports passing a String where safeDivide expects a Number', () => {
    const res = project.inferSource('src/app-broken.js', `import { just, nothing } from './Maybe.js';

// safeDivide :: Number -> Number -> Maybe Number
const safeDivide = (num) => (den) =>
  den === 0 ? nothing() : just(num / den);

const oops = safeDivide('100')(2);
export { oops };
`);
    const msgs = res.diagnostics.map(d => d.message);
    expect(msgs.length).toBeGreaterThan(0);
    // The message should be helpful: mention both the offending String and
    // the expected Number.
    expect(msgs.some(m => m.includes('String') && m.includes('Number'))).toBe(true);
  });

  it('reports a mismatched fold: branches must agree on the result type', () => {
    const res = project.inferSource('src/app-broken2.js', `import { just } from './Maybe.js';

// describe :: Number -> String
const describe = (n) =>
  just(n).fold(() => 'nothing', (x) => x * 2);

export { describe };
`);
    const msgs = res.diagnostics.map(d => d.message);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.some(m => m.includes('String') && m.includes('Number'))).toBe(true);
  });
});
