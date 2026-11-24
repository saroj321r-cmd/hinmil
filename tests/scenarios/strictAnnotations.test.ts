// Strict annotation checking for `const f = (…) => …` — consumer scenarios on
// REAL fpkit code (fixture: tests/fixtures/scenarios/fp-library,
//).  //
// The hinmil rules these scenarios rely on:
//   1. A polymorphic annotation on a const-bound arrow is checked like one on a
//      `function` declaration: the body runs against rigid skolems, so it can
//      never return (or mix up) the wrong type variable.  Overloads and `...`
//      variadics keep the lenient structural check.
//   2. Type variables are lexically scoped: a nested annotation that names a
//      variable of an enclosing annotation means THAT variable (like a generic
//      `T` inside an inner function in TypeScript).
//   3. `::narrow` on a method of an IMPORTED sumtype (`either.isLeft` with
//      `Either` from `require`) also narrows a callback parameter.
//   4. A JS default parameter (`(s, n, ch = " ")`) makes a missing argument
//      put no constraint on that slot.
//   5. A record literal introduces a nominal type known only from its
//      constructor annotation (`Point :: (Number, Number) -> Point`); anything
//      else (`v => v`) is still a mismatch.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'scenarios', 'fp-library');
const ROOT = '/tmp/hm-scenarios-fpkit-strict';

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyTree(path.join(from, e.name), path.join(to, e.name));
    else fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
  }
}

/** Lint `src/scenario/<name>.js`; return `line CODE message` per error. */
function lint(name: string, source: string): string[] {
  const rel = `src/scenario/${name}.js`;
  fs.mkdirSync(path.join(ROOT, 'src/scenario'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, rel), source);
  let stdout = '';
  runCli([rel, '--project', '.'], { cwd: ROOT, stdout: (t) => { stdout += t; }, stderr: () => {} });
  return stdout.split('\n')
    .filter((l) => / error /.test(l))
    .map((l) => l.replace(/^\S+?:(\d+):\d+ error /, '$1 '));
}

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  copyTree(FIXTURE, ROOT);
});

describe('1. const arrows are checked against rigid annotation variables', () => {
  test('a fold over Either that applies the handlers in order is clean', () => {
    expect(lint('eitherFold', `"use strict";
const Either = require ("../Either");

// either :: (a -> c) -> (b -> c) -> Either a b -> c
const either = onLeft => onRight => e =>
  (e.isLeft ? onLeft (e.value) : onRight (e.value));

module.exports = either;
`)).toEqual([]);
  });

  test('returning the wrong parameter is reported (was silently accepted)', () => {
    const errors = lint('pairFirst', `"use strict";
// fst :: (a, b) -> a
const fst = (first, second) => second;

module.exports = fst;
`);
    expect(errors).toEqual([
      "3 HM1003 Type mismatch: 'fst' has type '(a, b) -> b' but annotation expects '(a, b) -> a'",
    ]);
  });

  test('a ternary over two variables keeps the annotated union', () => {
    expect(lint('preferLeft', `"use strict";
const Maybe = require ("../Maybe");

// orElse :: (Maybe a, Maybe b) -> Maybe a | Maybe b
const orElse = (preferred, fallback) =>
  (preferred.isJust ? preferred : fallback);

module.exports = orElse;
`)).toEqual([]);
  });
});

describe('2. type variables are lexically scoped', () => {
  // Shape of fpkit Future/cache.js: the helpers forward the OUTER future's
  // rejection `e` and value `a`.
  const CACHE = (whenValue: string) => `"use strict";
const Future = require ("../Future");

// cacheFuture :: Future e a -> Future e a
const cacheFuture = future => {
  let rejection;
  let resolution;
  let status = "IDLE";

  // whenFail :: (e -> b) -> e -> ()
  const whenFail = rej => err => {
    status = "REJECTED";
    rejection = err;
    rej (err);
  };

${whenValue}

  // start :: (e -> b) -> (a -> b) -> c
  const start = rej => res => future.fork (whenFail (rej)) (whenValue (res));

  return Future (rej => res => {
    if (status === "REJECTED") return rej (rejection);
    if (status === "RESOLVED") return res (resolution);
    return start (rej) (res);
  });
};

module.exports = cacheFuture;
`;

  test('nested helpers annotated with the outer e and a are clean', () => {
    expect(lint('cacheScoped', CACHE(`  // whenValue :: (a -> b) -> a -> ()
  const whenValue = res => val => {
    status = "RESOLVED";
    resolution = val;
    res (val);
  };`))).toEqual([]);
  });

  test('a nested helper that stores the outer e where a is promised is reported', () => {
    const errors = lint('cacheScopedWrong', CACHE(`  // whenValue :: (a -> b) -> a -> ()
  const whenValue = res => val => {
    status = "RESOLVED";
    resolution = val;
    res (rejection);
  };`));
    expect(errors.some((e) => /Cannot unify 'e' with 'a'|Cannot unify 'a' with 'e'/.test(e))).toBe(true);
  });
});

describe('3. ::narrow through an imported sumtype narrows a callback parameter', () => {
  // Shape of fpkit Future/FutureEither.js `chainEither`.
  const CHAIN = (leftBranch: string) => `"use strict";
const Either = require ("../Either");
const Future = require ("../Future");

// chainResult :: Future e (Either l a) -> (a -> Future e (Either l b)) -> Future e (Either l b)
const chainResult = source => fn =>
  Future (rej => res =>
    source.fork (rej) (either => {
      if (either.isLeft) ${leftBranch};
      else fn (either.value).fork (rej) (res);
    }));

module.exports = chainResult;
`;

  test('a Left is passed on as-is (its value slot is phantom)', () => {
    expect(lint('chainResult', CHAIN('res (either)'))).toEqual([]);
  });

  test('passing the un-narrowed value on the Right path is still reported', () => {
    const errors = lint('chainResultWrong', `"use strict";
const Either = require ("../Either");
const Future = require ("../Future");

// chainResult :: Future e (Either l a) -> (a -> Future e (Either l b)) -> Future e (Either l b)
const chainResult = source => fn =>
  Future (rej => res =>
    source.fork (rej) (either => {
      if (either.isRight) res (either);
      else fn (either.value).fork (rej) (res);
    }));

module.exports = chainResult;
`);
    expect(errors).toEqual([
      "9 HM1001 Type mismatch: Cannot unify 'a' with 'b'",
    ]);
  });
});

test('4. a JS default parameter accepts a shorter call', () => {
  expect(lint('padStart', `"use strict";
// padStart :: (String, Number, String) -> String
const padStart = (text, width, fill = " ") =>
  (text.length >= width ? text : fill.repeat (width - text.length) + text);

const score = padStart ("7", 3);
const code = padStart ("7", 3, "0");

module.exports = { padStart, score, code };
`)).toEqual([]);
});

describe('5. a record literal introduces a nominal type', () => {
  test('a constructor annotation names the record it returns', () => {
    expect(lint('point', `"use strict";
// Point :: (Number, Number) -> Point
const Point = (x, y) => ({ x, y });

const origin = Point (0, 0);

module.exports = { Point, origin };
`)).toEqual([]);
  });

  test('returning the argument itself is not a constructor', () => {
    const errors = lint('boxStub', `"use strict";
// Box :: a -> Box a
const Box = value => value;

module.exports = Box;
`);
    expect(errors).toEqual([
      "3 HM1003 Type mismatch: 'Box' has type 'a -> a' but annotation expects 'a -> Box a'",
    ]);
  });
});

// ---------------------------------------------------------------------------
// Rules added while bringing fpkit/src to zero errors.
// ---------------------------------------------------------------------------

test('6. a forEach callback may return a value (it is ignored)', () => {
  expect(lint('collectIds', `"use strict";
// collectIds :: [{ id :: Number, ...r }] -> [Number]
const collectIds = rows => {
  const ids = [];
  rows.forEach (row => ids.push (row.id));
  return ids;
};

module.exports = collectIds;
`)).toEqual([]);
});

describe('7. Array#pop / Array#shift return the element', () => {
  test('the element of an unconstrained array is not called', () => {
    // `takeFirst` is unannotated, so its element type is a free variable.
    expect(lint('drainQueue', `"use strict";
// Shape of fpkit fl/chainRec.js: \`const todo = [value]; … todo.shift ()\`.
const firstOf = value => {
  const todo = [value];
  return todo.shift ();
};

// plusOne :: Number -> Number
const plusOne = n => firstOf (n) + 1;

module.exports = plusOne;
`)).toEqual([]);
  });

  test('the element type is enforced', () => {
    expect(lint('lastLabel', `"use strict";
// lastLabel :: [a] -> String
const lastLabel = xs => xs.pop ();

module.exports = lastLabel;
`).length).toBeGreaterThan(0);
  });
});

test('8. a variadic expected shape fixes only the positions before `...`', () => {
  // fpkit Result/validateSpec.js: `curryN (3) ((spec, obj, updating) => …)`
  // with `curryN :: Number -> ((a, b, ...) -> z) -> a -> b -> ... -> z`.
  expect(lint('flagged', `"use strict";
// curryAt :: Number -> ((a, b, ...) -> z) -> a -> b -> ... -> z
const curryAt = n => fn => fn;

// describeFlag :: Boolean -> String
const describeFlag = flag => (flag ? "on" : "off");

const flagged = curryAt (3) ((name, value, flag) => name + "=" + value + " " + describeFlag (flag));

module.exports = flagged;
`)).toEqual([]);
});

test('9. Promise#then flattens a callback that returns a Promise', () => {
  expect(lint('loadName', `"use strict";
// fetchUser :: Number -> Promise Error { name :: String }
const fetchUser = id => Promise.resolve ({ name: "user " + id });

// loadName :: Number -> Promise Error String
const loadName = id =>
  Promise.resolve (id)
    .then (n => fetchUser (n))
    .then (user => user.name);

module.exports = loadName;
`)).toEqual([]);
});

describe('10. narrowing through a loop exit and a `::narrow` variant predicate', () => {
  // Shape of fpkit IO.chainRec: after `while (isNext (acc))` the step is Done.
  const TRAMPOLINE = (returned: string) => `"use strict";
const Step = require ("../Step");
const isNext = require ("../Step/isNext");

const { Next, Done } = Step;

// runSteps :: (forall c. (a -> c) -> (b -> c) -> a -> c) -> a -> b
const runSteps = fn => value => {
  let acc = Next (value);
  while (isNext (acc)) {
    acc = fn (Next) (Done) (acc.value);
  }
  return ${returned};
};

module.exports = runSteps;
`;

  test("the Done step's value is the result", () => {
    expect(lint('runSteps', TRAMPOLINE('acc.value'))).toEqual([]);
  });

  test('returning the step itself is reported', () => {
    expect(lint('runStepsWrong', TRAMPOLINE('acc')).length).toBeGreaterThan(0);
  });
});

test('11. same-named helpers in different closures are separate bindings', () => {
  // fpkit RTask#chain and RTask#bichain each declare `safeReject`.
  expect(lint('twoClosures', `"use strict";
// lengths :: [String] -> [Number]
const lengths = words => {
  // measure :: String -> Number
  const measure = word => word.length;
  return words.map (measure);
};

// labels :: [Number] -> [String]
const labels = ns => {
  // measure :: Number -> String
  const measure = n => "#" + n;
  return ns.map (measure);
};

module.exports = { lengths, labels };
`)).toEqual([]);
});

test('12. a transformer instance may annotate its own method override', () => {
  // fpkit State/StateFuture.js: a parallel `ap` for one StateT instance.
  expect(lint('stateFutureAp', `"use strict";
const Future = require ("../Future");
const StateT = require ("../State/StateT");

// StateFutureX :: TypeRep (StateT (Future e) s)
const StateFutureX = StateT (Future);

// StateFutureX#ap :: StateT (Future e) s a ~> StateT (Future e) s (a -> b) -> StateT (Future e) s b
StateFutureX.prototype.ap = function (other) {
  return this.chain (a => other.map (f => f (a)));
};

module.exports = StateFutureX;
`)).toEqual([]);
});

// ---------------------------------------------------------------------------
// Rules added while bringing fpkit's specs to zero errors.
// ---------------------------------------------------------------------------

describe('13. a method on a transformer instance is visible on its values', () => {
  // fpkit Future/FutureEither.js: `FutureEither#matchWith` exists only on the
  // FutureT (Either l) instance.
  const MATCH = (right: string) => `"use strict";
const Either = require ("../Either");
const FutureEither = require ("../Future/FutureEither");
const matchWith = require ("../more/matchWith");

const { Right } = Either;
const { lift } = FutureEither;

// toUpper :: String -> String
const toUpper = s => s.toUpperCase ();

// shout :: String -> Future e String
const shout = s => matchWith ({ Left: toUpper, Right: ${right} }) (lift (Right (s)));

module.exports = shout;
`;

  test('a well-typed pattern is accepted', () => {
    expect(lint('instanceMatch', MATCH('toUpper'))).toEqual([]);
  });

  test('a pattern that does not fit the instance is reported', () => {
    expect(lint('instanceMatchWrong', MATCH('n => n + 1')).length).toBeGreaterThan(0);
  });
});

test('14. superclass instances count, also through ::types (fl/zero)', () => {
  // `Plus` needs `Alt` and `Functor`; their Array/Object instances live in
  // fl/alt.js and fl/map.js, which fl/zero.js references with `::types`.
  expect(lint('zeroes', `"use strict";
const zero = require ("../fl/zero");

const noItems = zero (Array);
const noFields = zero (Object);

module.exports = { noItems, noFields };
`)).toEqual([]);
});

test('15. `&&` narrows through typeof and ::narrow predicates', () => {
  expect(lint('isSafeInt', `"use strict";
// isWholeNumber :: a -> Boolean
const isWholeNumber = x =>
  typeof x === "number" && Math.floor (x) === x && x >= 0;

module.exports = isWholeNumber;
`)).toEqual([]);
});

test('16. a user sumtype shadows a builtin of the same name (Response)', () => {
  // fpkit express/Response.js vs the Fetch API Response.
  expect(lint('responseMatch', `"use strict";
const Response = require ("../express/Response");
const matchWith = require ("../more/matchWith");

const { Redirect } = Response;

// describeResponse :: Response a -> String
const describeResponse = res => matchWith ({
  Redirect: status => url => "redirect " + status + " " + url,
  Render: view => options => "render " + view,
  Send: status => headers => body => "send " + status
}) (res);

const login = describeResponse (Redirect (302) ("/login"));

module.exports = { describeResponse, login };
`)).toEqual([]);
});

describe('17. functions are the reader functor (`f := Function [x]`)', () => {
  const READER = (fn: string) => `"use strict";
const map = require ("../fl/map");

// withInc :: Number -> Function [{ inc :: Number }] Number
const withInc = n => map (${fn}) (env => n + env.inc);

module.exports = withInc;
`;

  test('mapping over a function composes', () => {
    expect(lint('readerMap', READER('x => x * 2'))).toEqual([]);
  });

  test('the mapped function must accept the result', () => {
    expect(lint('readerMapWrong', READER('x => String (x)')).length).toBeGreaterThan(0);
  });
});

test('18. `Function` as a type representative (`chainRec (Function)`)', () => {
  expect(lint('readerChainRec', `"use strict";
const chainRec = require ("../fl/chainRec");
const map = require ("../fl/map");

// countTo :: Number -> Number
const countTo = limit => chainRec (Function) (next => done => n =>
  n >= limit ? map (done) (env => n) : map (next) (env => n + 1)
) (0) ({});

module.exports = countTo;
`)).toEqual([]);
});

test('19. curryN-style wrappers support every argument grouping', () => {
  expect(lint('curryNGroups', `"use strict";
const curryN = require ("../more/curryN");

// volume :: Number -> Number -> Number -> Number
const volume = curryN (3) ((l, w, h) => l * w * h);

const a = volume (1) (2) (3);
const b = volume (1, 2) (3);
const c = volume (1) (2, 3);

module.exports = { volume, a, b, c };
`)).toEqual([]);
});

test('20. a function value is checked against the Function instances', () => {
  // fpkit fl/equals.js: `::rep Setoid Function#equals`.
  expect(lint('sameFunction', `"use strict";
const equals = require ("../fl/equals");

// sameStep :: (a -> a) -> Boolean
const sameStep = f => equals (f) (f);

module.exports = sameStep;
`)).toEqual([]);
});

test('21. timer handles can be written in annotations', () => {
  expect(lint('later', `"use strict";
// later :: (() -> ()) -> TimeoutId
const later = fn => setTimeout (fn, 0);

module.exports = later;
`)).toEqual([]);
});

test('22. a `::narrow` variant predicate narrows both branches (fpkit Step)', () => {
  expect(lint('stepValue', `"use strict";
const Step = require ("../Step");
const isNext = require ("../Step/isNext");

const { Done } = Step;

// finish :: Step b a -> (a -> b) -> b
const finish = step => onNext => {
  if (isNext (step)) return onNext (step.value);
  return step.value;
};

const answer = finish (Done (42)) (n => n);

module.exports = { finish, answer };
`)).toEqual([]);
});
