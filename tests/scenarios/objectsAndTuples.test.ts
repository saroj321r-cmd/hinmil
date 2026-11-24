// fpkit object helpers and tuples on REAL fpkit code (entry:
// tests/fixtures/scenarios/fp-library).
// fpkit's src/object and src/Tuple were re-typed
// with what hinmil offers for objects — label polymorphism (`{ [k] :: a }`),
// open rows (`...r`), key paths as fixed-length tuples (`[k1, k2]`), paths
// ending in an array index (`[k1, Number]`) — and per-arity tuple types
// (`Tuple2 a b`).  The overloads rely on declaration-order resolution and on
// rejecting a branch whose trial errors (an array-literal path against a
// tuple branch with a mismatching element).

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'scenarios', 'fp-library');
const ROOT = '/tmp/hm-scenarios-fpkit-objects';

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

/** Lint `src/scenario/<name>.js`; return `line:col CODE message` per error. */
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

test('the fpkit object helpers, Tuple, merge and fanout lint clean', () => {
  expect(run(['src/object', 'src/Tuple', 'src/more/merge.js', 'src/more/fanout.js'])).toEqual([]);
});

test('prop: keys, indices and key paths are typed; wrong result types are reported', () => {
  expect(lint('prop', `"use strict";
const prop = require ("../object/prop");
const entry = { host: "North", deliverables: 2, rates: { host: 1.85, guest: 2.1 }, authors: ["Jansen"] };

// deliverables :: Maybe Number
const deliverables = prop ("deliverables") (entry);
// guestRate :: Maybe Number
const guestRate = prop (["rates", "guest"]) (entry);
// firstAuthor :: Maybe String
const firstAuthor = prop (["authors", 0]) (entry);
// second :: Maybe String
const second = prop (1) (["x", "y"]);

// wrongKey :: Maybe String
const wrongKey = prop ("deliverables") (entry);
// wrongPath :: Maybe String
const wrongPath = prop (["rates", "guest"]) (entry);

module.exports = { deliverables, guestRate, firstAuthor, second, wrongKey, wrongPath };
`)).toEqual([
    "15 HM1001 Type mismatch: Cannot unify 'Number' with 'String'",
    "17 HM1001 Type mismatch: Cannot unify 'Number' with 'String'",
  ]);
});

test('set / over / unset / value / objOf keep the record type', () => {
  expect(lint('records', `"use strict";
const set = require ("../object/set");
const over = require ("../object/over");
const unset = require ("../object/unset");
const value = require ("../object/value");
const objOf = require ("../object/objOf");
const entry = { host: "North", deliverables: 2, rates: { host: 1.85, guest: 2.1 } };

// scored :: { host :: String, deliverables :: Number, rates :: { host :: Number, guest :: Number } }
const scored = set ("deliverables") (3) (entry);
// labelled :: { host :: String, deliverables :: String, rates :: { host :: Number, guest :: Number } }
const labelled = over ("deliverables") (g => String (g)) (entry);
// noDeliverables :: { host :: String, rates :: { host :: Number, guest :: Number } }
const noDeliverables = unset ("deliverables") (entry);
// moved :: { host :: String, deliverables :: Number, rates :: { host :: Number, guest :: Number } }
const moved = set (["rates", "guest"]) (2.2) (entry);
// n :: Number
const n = value ("deliverables") (entry);
// one :: { a :: Number }
const one = objOf ("a") (1);

// badValue :: String
const badValue = value ("deliverables") (entry);

module.exports = { scored, labelled, noDeliverables, moved, n, one, badValue };
`)).toEqual(["23 HM1001 Type mismatch: Cannot unify 'Number' with 'String'"]);
});

test('Tuple2 is heterogeneous; merge consumes Pair and Tuple2 alike; fanout builds TupleN', () => {
  expect(lint('tuples', `"use strict";
const Tuple2 = require ("../Tuple/Tuple2");
const merge = require ("../more/merge");
const fanout = require ("../more/fanout");
const prop = require ("../object/prop");

// score :: Tuple2 String Number
const score = Tuple2 ("North") (2);
// line :: String
const line = merge (department => deliverables => department + " " + deliverables) (score);
// both :: Tuple2 (Maybe String) (Maybe Number)
const both = fanout ([prop ("host"), prop ("deliverables")]) ({ host: "North", deliverables: 2 });

// wrong :: Tuple2 Number Number
const wrong = Tuple2 ("North") (2);

module.exports = { score, line, both, wrong };
`)).toEqual([expect.stringMatching(/^15 HM1001 Type mismatch: Cannot unify 'String' with 'Number'$/)]);
});
