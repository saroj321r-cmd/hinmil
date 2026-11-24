// Narrowing through compound guards and nullable ternaries, as in an HTML
// table reader that walks rows:
//  - `if (names.length < 2 || link == null) return;` leaves `link` non-null
//    (a `||` guard: after it, BOTH sides are false);
//  - `c ? null : f (x)` with `f :: a -> String | Null` is `String | Null`
//    (it was the narrower branch, `Null`), so `if (found != null)` narrows it
//    to `String`;
//  - removing Null from a union also removes it from nested unions.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const ROOT = '/tmp/hm-scenarios-compound-guards';

function lint(name: string, source: string): string[] {
  fs.mkdirSync(path.join(ROOT, 'src'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'src', `${name}.js`), source);
  let stdout = '';
  runCli([`src/${name}.js`, '--project', '.'], {
    cwd: ROOT,
    stdout: (t) => { stdout += t; },
    stderr: () => {},
  });
  return stdout.split('\n').filter((l) => / error /.test(l));
}

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  fs.writeFileSync(path.join(ROOT, 'package.json'), '{ "name": "compound-guards" }');
});

const PRELUDE = `// linkOf :: String -> { id :: String, division :: String } | Null
const linkOf = href => href.split ("/").length < 4 ? null : { id: "x", division: "y" };

// dateOf :: String -> String | Null
const dateOf = text => text === "" ? null : text;
`;

test('positive: a || guard with an early return narrows the nullable side', () => {
  expect(lint('orGuard', `${PRELUDE}
// rowId :: [String] -> String -> String
export const rowId = names => href => {
  const link = linkOf (href);
  if (names.length < 2 || link == null) return "";
  return link.id + "/" + link.division;
};

// inCallback :: [String] -> [String]
export const inCallback = hrefs => {
  const ids = [];
  hrefs.forEach (href => {
    const link = linkOf (href);
    if (href === "" || link == null) return;
    ids.push (link.id);
  });
  return ids;
};
`)).toEqual([]);
});

test('negative: an && guard does not narrow what comes after it', () => {
  expect(lint('andGuard', `${PRELUDE}
// rowId :: [String] -> String -> String
export const rowId = names => href => {
  const link = linkOf (href);
  if (names.length < 2 && link == null) return "";
  return link.id;
};
`)).toEqual([
    "src/andGuard.js:11:15 error HM1005 Property 'id' does not exist on type 'Null' in union '{ id :: String, division :: String } | Null'",
  ]);
});

test('positive: a ternary with a null branch keeps the nullable union, and a guard narrows it', () => {
  expect(lint('ternary', `${PRELUDE}
// lastDate :: String -> [String] -> String
export const lastDate = initial => headers => {
  let date = initial;
  headers.forEach (h => {
    const found = h.length > 40 ? null : dateOf (h);
    if (found != null) date = found;
  });
  return date;
};
`)).toEqual([]);
});

test('negative: the nullable ternary is not a plain String', () => {
  expect(lint('ternaryBad', `${PRELUDE}
// firstDate :: String -> String
export const firstDate = h => h.length > 40 ? null : dateOf (h);
`)).toEqual([
    "src/ternaryBad.js:8:14 error HM1003 Type mismatch: 'firstDate' has type 'String -> Null | String' but annotation expects 'String -> String'",
  ]);
});

const QUERY = `// Query :: { from :: Date | Undefined, queue :: String | Undefined }
`;

test('positive: a member null check narrows the field in a ternary', () => {
  expect(lint('memberNull', `${QUERY}
// fromOr :: Date -> Query -> Number
export const fromOr = now => q => (q.from == null ? now : q.from).getTime ();

// queueOf :: Query -> String
export const queueOf = q => q.queue !== undefined ? q.queue : "default";
`)).toEqual([]);
});

test('negative: the field stays nullable in the branch where it is missing', () => {
  expect(lint('memberNullBad', `${QUERY}
// queueOf :: Query -> String
export const queueOf = q => q.queue == null ? q.queue : "default";
`)).toEqual([
    "src/memberNullBad.js:4:14 error HM1003 Type mismatch: 'queueOf' has type 'Query -> String | Undefined' but annotation expects 'Query -> String'",
  ]);
});

// `::narrow` with a union target, written below the signature (both orders
// are accepted): the else-branch of `nil (x) ? d : x` drops Null/Undefined,
// also from a union with a type variable.
const NIL = `// nil :: a -> Boolean
// ::narrow Null | Undefined
const nil = value => value == null;
`;

test('positive: a union ::narrow below the signature narrows the else-branch', () => {
  expect(lint('nilNarrow', `${NIL}
// defaultTo :: a -> a | Null | Undefined -> a
export const defaultTo = def => val => nil (val) ? def : val;

// orZero :: Number | Null -> Number
export const orZero = n => nil (n) ? 0 : n;
`)).toEqual([]);
});

test('negative: the then-branch is the nullable side', () => {
  expect(lint('nilNarrowBad', `${NIL}
// pick :: Number | Null -> Number
export const pick = n => nil (n) ? n : 0;
`)).toEqual([
    "src/nilNarrowBad.js:6:14 error HM1003 Type mismatch: 'pick' has type 'Null | Number -> Null | Number' but annotation expects 'Null | Number -> Number'",
  ]);
});

// A curried constructor with a nullable parameter, called once with a value
// and once with null in the two callbacks of a higher-order function: the
// call results are the DECLARED record (`reason :: String | Null`), not a
// copy of each argument, so both callbacks agree on `Summary`.
const SUMMARY = `// Summary :: { status :: String, reason :: String | Null }

// summaryOf :: String | Null -> String -> Summary
const summaryOf = reason => status => ({ status, reason });

// both :: (Number -> a) -> (Number -> a) -> a
const both = f => g => f (1);
`;

test('positive: a declared record result is not narrowed by the argument', () => {
  expect(lint('declaredResult', `${SUMMARY}
// close :: Number -> Summary
export const close = n => both (_x => summaryOf ("boom") ("paused")) (_y => summaryOf (null) ("ok"));
`)).toEqual([]);
});

test('negative: the declared field stays nullable after a non-null argument', () => {
  expect(lint('declaredResultBad', `${SUMMARY}
// reasonLength :: Number -> Number
export const reasonLength = n => summaryOf ("boom") ("paused").reason.length;
`)).toEqual([
    "src/declaredResultBad.js:10:71 error HM1005 Property 'length' does not exist on type 'Null' in union 'Null | String'",
  ]);
});
