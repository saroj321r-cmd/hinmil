// Everyday browser-client code (a React client with an HTTP layer):
//
//  - a falsiness guard with an early return (`if (!evidence) return "–";`)
//    narrows a `T | Null` value for the rest of the function;
//  - `toLocaleString`/`toLocaleDateString`/`toLocaleTimeString` take a
//    locale and `Intl` options (Number, Date);
//  - `new AbortController ()` cancels a request through its `signal`;
//  - `globalThis` is the global object (test setup installs stubs on it).

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';

beforeEach(() => resetTypeVarCounter());

function errors(src: string): string[] {
  return new InferenceEngine().infer(src).diagnostics
    .filter(d => d.severity !== 3)
    .map(d => d.message);
}

describe('falsiness guard with an early return', () => {
  test('if (!x) return … narrows x after the guard', () => {
    expect(errors(`
// Evidence :: { agreements :: Number, conflicts :: Number }

// evidenceText :: Evidence | Null -> String
const evidenceText = evidence => {
  if (!evidence) return "–";
  return String(evidence.agreements) + " gelijk, " + String(evidence.conflicts) + " conflicten";
};
`)).toEqual([]);
  });

  test('a guard on a member: if (!job.error) return …', () => {
    expect(errors(`
// Job :: { id :: Number, error :: { message :: String } | Null }

// errorLine :: Job -> String
const errorLine = job => {
  const error = job.error;
  if (!error) return "";
  return "#" + String(job.id) + ": " + error.message;
};
`)).toEqual([]);
  });

  test('without the return the value stays nullable', () => {
    const errs = errors(`
// Evidence :: { agreements :: Number }

// evidenceText :: Evidence | Null -> String
const evidenceText = evidence => {
  if (!evidence) console.log("geen bewijs");
  return String(evidence.agreements);
};
`);
    expect(errs.join('\\n')).toMatch(/agreements/);
  });

  test('a double negation is a truthiness test, not a guard', () => {
    const errs = errors(`
// Evidence :: { agreements :: Number }

// evidenceText :: Evidence | Null -> String
const evidenceText = evidence => {
  if (!!evidence) return "er is bewijs";
  return String(evidence.agreements);
};
`);
    expect(errs.join('\\n')).toMatch(/agreements/);
  });
});

describe('locale formatting', () => {
  test('Number and Date take a locale and Intl options', () => {
    expect(errors(`
// money :: Number -> String
const money = x => x.toLocaleString("nl-BE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// kickoff :: Date -> String
const kickoff = d => d.toLocaleString("nl-BE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" });

// matchDay :: Date -> String
const matchDay = d => d.toLocaleDateString(["nl-BE", "en-GB"], { year: "numeric" }) + " " + d.toLocaleTimeString("nl-BE");

// plain :: Number -> String
const plain = x => x.toLocaleString();
`)).toEqual([]);
  });

  test('the result is a String', () => {
    const errs = errors(`
// money :: Number -> Number
const money = x => x.toLocaleString("nl-BE");
`);
    expect(errs.length).toBeGreaterThan(0);
  });

  test('the locale is a String (or a list of them)', () => {
    const errs = errors(`
// money :: Number -> String
const money = x => x.toLocaleString(32, {});
`);
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe('AbortController', () => {
  test('a cancellable request', () => {
    expect(errors(`
// cancellable :: String -> { cancel :: () -> (), aborted :: () -> Boolean }
const cancellable = url => {
  const controller = new AbortController();
  fetch(url, { signal: controller.signal });
  return { cancel: () => controller.abort(), aborted: () => controller.signal.aborted };
};
`)).toEqual([]);
  });

  test('signal is an AbortSignal, not a Boolean', () => {
    const errs = errors(`
// isAborted :: () -> Boolean
const isAborted = () => new AbortController().signal;
`);
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe('globalThis', () => {
  test('test setup installs a stub on the global object', () => {
    expect(errors(`
class ResizeObserverStub {
  observe() {}
  disconnect() {}
}
globalThis.ResizeObserver = globalThis.ResizeObserver || ResizeObserverStub;
`)).toEqual([]);
  });
});

describe('positional destructuring of an unknown value', () => {
  test('an operator callback receives a pair: each position its own type', () => {
    expect(errors(`
// The [action, state] pair a stream operator passes (an untyped library).
const undoReason = ([{ payload: id }, state]) => String(id) + ": " + state.matching.reason;

// latestQuery :: Any -> String
const latestQuery = pair => {
  const [action, state] = pair;
  return String(action.type) + String(state.lists.fixtures.query);
};
`)).toEqual([]);
  });

  test('a real list still fits: ([x, y]) => x + y with [1, 2]', () => {
    expect(errors(`
const total = ([home, away]) => home + away;

// score :: () -> Number
const score = () => total([2, 1]);
`)).toEqual([]);
  });

  test('the positions are still checked against what is passed', () => {
    const errs = errors(`
const total = ([home, away]) => home * away;

// score :: () -> Number
const score = () => total(["twee", "een"]);
`);
    expect(errs.length).toBeGreaterThan(0);
  });

  test('a rest element keeps the list form', () => {
    expect(errors(`
const headAndRest = ([first, ...rest]) => first + rest.length;

// count :: () -> Number
const count = () => headAndRest([1, 2, 3]);
`)).toEqual([]);
  });
});

describe('array predicates read their callback result as truthy or falsy', () => {
  const BET = `// Bet :: { won :: Boolean | Null, name :: String | Null, profitFlat :: Number | Null }
`;

  test('filter with a nullable field, inside an annotated function', () => {
    expect(errors(`${BET}
// totals :: [Bet] -> { won :: Number, named :: Number }
const totals = bets => ({
  won: bets.filter(b => b.won).length,
  named: bets.filter(function (b) { return b.name; }).length
});
`)).toEqual([]);
  });

  test('find, some, every and findIndex', () => {
    expect(errors(`${BET}
// summary :: [Bet] -> String
const summary = bets => {
  const firstNamed = bets.find(b => b.name);
  const anyProfit = bets.some(b => b.profitFlat);
  const allSettled = bets.every(b => b.won !== null);
  return String(bets.findIndex(b => b.name)) + String(anyProfit) + String(allSettled) + String(firstNamed);
};
`)).toEqual([]);
  });

  test('the elements stay typed: filter keeps [Bet]', () => {
    const errs = errors(`${BET}
// names :: [Bet] -> [Number]
const names = bets => bets.filter(b => b.won);
`);
    expect(errs.length).toBeGreaterThan(0);
  });

  test('the callback parameter is still the element type', () => {
    const errs = errors(`${BET}
// wins :: [Bet] -> Number
const wins = bets => bets.filter(b => b.won * 2).length;
`);
    expect(errs.length).toBeGreaterThan(0);
  });
});

describe('unions in annotations', () => {
  test('an alias for a union of existing types', () => {
    expect(errors(`
// Een tabelcel: tekst, een getal of leeg.
// Cell :: String | Number | Null

// scoreCell :: Number | Null -> Cell
const scoreCell = n => (n === null ? null : n);
`)).toEqual([]);
  });

  test('a narrower union result fits a wider declared union (arrow and function)', () => {
    expect(errors(`
// Node :: ReactElement | String | Null | [ReactElement | String | Null]

// spinner :: Boolean -> Node
const spinner = loading => (loading ? <span>Laden…</span> : null);

// label :: Boolean -> String | Number | Null
function label(settled) {
  if (settled) return "afgerekend";
  return null;
}

// pick :: (Boolean, a) -> a | String | Null
function pick(keep, value) {
  if (keep) return value;
  return null;
}

// status :: (Boolean, Boolean) -> Node
const status = (ready, loading) => {
  if (!ready) return loading ? <span>Laden…</span> : null;
  return "klaar";
};
`)).toEqual([]);
  });

  test('a member outside the declared union is still an error', () => {
    const errs = errors(`
// Cell :: String | Number | Null

// cell :: Boolean -> Cell
const cell = b => (b ? "ja" : true);

// label :: Boolean -> String | Null
function label(settled) {
  if (settled) return "afgerekend";
  return 2;
}
`);
    expect(errs.length).toBe(2);
  });

  test('a user sum type is still a sum type', () => {
    expect(errors(`
// Outcome :: Won | Lost | Pending
// Won :: Outcome
// Lost :: Outcome
// Pending :: Outcome

// outcomeLabel :: Outcome -> String
const outcomeLabel = o => String(o);
`)).toEqual([]);
  });
});
