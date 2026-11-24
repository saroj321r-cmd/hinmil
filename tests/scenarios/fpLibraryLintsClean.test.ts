// fpkit outside its specs lints clean — consumer scenarios on REAL fpkit code
// (fixture: tests/fixtures/scenarios/fp-library).
// The hinmil rules these scenarios rely
// on:
//   - `this.field = [a, b]` takes the annotated field type (`T#f :: T a b ~> [a, b]`)
//     as expected type, so the literal becomes a tuple (Tuple2…Tuple5);
//   - a tuple flows into `[Any]` (Tuple's `applyParts`);
//   - a bare parameterised constructor bound through `TypeRep m` (`First`)
//     unifies with its application (`First String`) in a value slot
//     (Monoid laws on First / Last);
//   - `Any` in a constraint's method shape is a wildcard (Unwrappable);
//   - `String#split` accepts a RegExp separator.
// The fpkit side uses only documented hinmil forms: open-record method
// signatures (`{ swap :: () -> r, ...s } -> r`), overloads in declaration order
// (Array first, then the generic `f a`), `::narrow` predicates and Merge.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'scenarios', 'fp-library');
const ROOT = '/tmp/hm-scenarios-fpkit-nonspec';

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyTree(path.join(from, e.name), path.join(to, e.name));
    else fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
  }
}

function run(rels: string[]): string[] {
  let stdout = '';
  runCli([...rels, '--project', '.'], { cwd: ROOT, stdout: (t) => { stdout += t; }, stderr: () => {} });
  return stdout.split('\n').filter((l) => / error /.test(l));
}

/** Lint `src/scenario/<name>.js`; return `line CODE message` per error. */
function lint(name: string, source: string): string[] {
  const rel = `src/scenario/${name}.js`;
  fs.mkdirSync(path.join(ROOT, 'src/scenario'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, rel), source);
  return run([rel]).map((l) => l.replace(/^\S+?:(\d+):\d+ error /, '$1 '));
}

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  copyTree(FIXTURE, ROOT);
});

test('every fpkit module in the fixture lints clean', () => {
  expect(run(['src'])).toEqual([]);
});

test('Monoid laws accept First / Last / Sum as type representative', () => {
  expect(lint('monoidLaws', `"use strict";
const First = require ("../First");
const Sum = require ("../Sum");
const Maybe = require ("../Maybe");
const monoidLaws = require ("../test/laws/Monoid");

const firstLaws = monoidLaws (First);
// okFirst :: Boolean
const okFirst = firstLaws.leftIdentity (First (Maybe.Just ("a")));
// okSum :: Boolean
const okSum = monoidLaws (Sum).rightIdentity (Sum (1));
// wrong :: First Number
const wrong = First (Maybe.Just ("a"));

module.exports = { okFirst, okSum, wrong };
`)).toEqual(["13 HM1001 Type mismatch: Cannot unify 'String' with 'Number'"]);
});

test('swap / mapLeft / matchWith take their result from the receiver method', () => {
  expect(lint('receiverMethods', `"use strict";
const Either = require ("../Either");
const Result = require ("../Result");
const Pair = require ("../Pair");
const swap = require ("../more/swap");
const mapLeft = require ("../fl/mapLeft");
const matchWith = require ("../more/matchWith");

// toUpper :: String -> String
const toUpper = s => s.toUpperCase ();

// swapped :: Either Number String
const swapped = swap (Either.Left ("x"));
// flipped :: Pair Number String
const flipped = swap (Pair ("a") (1));
// shout :: Result String Number
const shout = mapLeft (toUpper) (Result.Err ("abc"));
// label :: String
const label = matchWith ({ Err: e => e, Ok: n => String (n) }) (Result.Ok (1));

// wrongSwap :: Pair String String
const wrongSwap = swap (Pair ("a") (1));
// wrongLabel :: Number
const wrongLabel = matchWith ({ Err: e => e, Ok: n => String (n) }) (Result.Ok (1));

module.exports = { swapped, flipped, shout, label, wrongSwap, wrongLabel };
`)).toEqual([
    "22 HM1001 Type mismatch: Cannot unify 'Number' with 'String'",
    "24 HM1001 Type mismatch: Cannot unify 'Number' with 'String'",
  ]);
});

// One generic signature covers the Array fast path too.
test('dropWhile / sortBy: one generic signature serves Arrays and other Foldables', () => {
  expect(lint('overloads', `"use strict";
const dropWhile = require ("../lst/dropWhile");
const sortBy = require ("../lst/sortBy");
const List = require ("../List");

// rates :: [Number]
const rates = dropWhile (n => n < 3) ([1, 2, 3, 4]);
// rest :: List Number
const rest = dropWhile (n => n < 3) (List.of (1));
// sorted :: [String]
const sorted = sortBy (s => s.length) (["ccc", "a", "bb"]);

// wrong :: [String]
const wrong = dropWhile (n => n < 3) ([1, 2, 3, 4]);

module.exports = { rates, rest, sorted, wrong };
`)).toEqual(['14 HM1001 Type mismatch: Cannot unify \'Number\' with \'String\'']);
});

test('words / unlines and concat on records', () => {
  expect(lint('strings', `"use strict";
const words = require ("../string/words");
const unlines = require ("../string/unlines");
const concat = require ("../fl/concat");

// ws :: [String]
const ws = words ("North  South");
// text :: String
const text = unlines (ws);
// merged :: { host :: String, deliverables :: Number }
const merged = concat ({ deliverables: 2 }) ({ host: "North" });

// wrongMerge :: { host :: Number, deliverables :: Number }
const wrongMerge = concat ({ deliverables: 2 }) ({ host: "North" });

module.exports = { ws, text, merged, wrongMerge };
`)).toEqual([
    "14 HM1003 Type mismatch: 'wrongMerge' has type '{ host :: String, deliverables :: Number }' but annotation expects '{ host :: Number, deliverables :: Number }'",
  ]);
});

test('mreduce: Sum / First satisfy Unwrappable (`value :: m ~> Any`)', () => {
  expect(lint('mreduce', `"use strict";
const mreduce = require ("../more/mreduce");
const Sum = require ("../Sum");
const First = require ("../First");
const Maybe = require ("../Maybe");

// total :: Number
const total = mreduce (Sum) ([1, 2, 3]);
// first :: Maybe Number
const first = mreduce (First) ([Maybe.Just (1), Maybe.Just (2)]);

module.exports = { total, first };
`)).toEqual([]);
});
