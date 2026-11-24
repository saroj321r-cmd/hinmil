// A lookup that can miss: `Map#get` returns `v | Undefined`.
//
// The caller decides what a miss means.  Narrowing (`== null`, `??`) handles
// it in code; an annotation on the binding (`// rate :: Number` above
// `const rate = rates.get (code)`) states that the key is known to be
// present — the annotation may drop `Undefined`/`Null` from a value that
// comes from a lookup (a call, a member access or an `await`), and nothing
// else: the remaining type must still match, and a value that is
// `undefined` by construction (`cond ? 1 : undefined`) is still reported.

import { diags } from '../helpers/infer';

const RATES = `
// rates :: Map String Number
const rates = new Map ([["NL", 0.21], ["BE", 0.21], ["DE", 0.19]]);
`;

describe('Map#get may miss', () => {
  test('returning the lookup where a Number is promised is reported', () => {
    const errors = diags(RATES + `
// vatRate :: String -> Number
const vatRate = (country) => rates.get (country);
`);
    expect(errors).toEqual([expect.stringMatching(/Number \| Undefined/)]);
  });

  test('narrowing handles the miss', () => {
    expect(diags(RATES + `
// vatRate :: String -> Number
const vatRate = (country) => {
  const rate = rates.get (country);
  return rate == null ? 0 : rate;
};

// vatOrDefault :: String -> Number
const vatOrDefault = (country) => rates.get (country) ?? 0.21;
`)).toEqual([]);
  });

  test('the result type mentions the miss', () => {
    expect(diags(RATES + `
// vatRate :: String -> Number | Undefined
const vatRate = (country) => rates.get (country);
`)).toEqual([]);
  });
});

describe('an annotation states that the key is present', () => {
  test('at top level', () => {
    expect(diags(RATES + `
// dutchVat :: Number
const dutchVat = rates.get ("NL");

// dutchVatLabel :: String
const dutchVatLabel = dutchVat.toFixed (2);
`)).toEqual([]);
  });

  test('inside a function', () => {
    expect(diags(RATES + `
// grossOf :: (String, Number) -> Number
const grossOf = (country, net) => {
  // rate :: Number
  const rate = rates.get (country);
  return net * (1 + rate);
};

// rateOf :: String -> Number
const rateOf = (country) => {
  // rate :: Number
  const rate = rates.get (country);
  return rate;
};
`)).toEqual([]);
  });

  test('for an awaited lookup and a member access', () => {
    expect(diags(`
// Invoice :: { number :: String, paidAt :: Date | Undefined }

// loadInvoice :: String -> Promise Error (Invoice | Undefined)
const loadInvoice = (number) => Promise.resolve (undefined);

// paidAtOf :: String -> Promise Error Date
const paidAtOf = async (number) => {
  // invoice :: Invoice
  const invoice = await loadInvoice (number);
  // paidAt :: Date
  const paidAt = invoice.paidAt;
  return paidAt;
};
`)).toEqual([]);
  });

  test('the rest of the type must still match', () => {
    const errors = diags(RATES + `
// dutchVat :: String
const dutchVat = rates.get ("NL");
`);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join('\n')).toMatch(/String/);
  });

  test('a value that is undefined by construction is still reported', () => {
    const errors = diags(`
// discount :: Boolean -> Number
const discount = (member) => {
  // percentage :: Number
  const percentage = member ? 10 : undefined;
  return percentage;
};
`);
    expect(errors.length).toBeGreaterThan(0);
  });
});

// `has` before `get`: the key is known to be present, so `get` cannot miss.
// Recognised: a `has` test on the same map and key (by path: `m`, `this.m`,
// `state.byTeam`; key an identifier, a member path or a literal) in a
// ternary or `if` (also negated and inside `&&` / `||`), a guard that
// leaves the block (`if (!m.has (k)) return …;`), and a guard that adds the
// key (`if (!m.has (k)) m.set (k, []);`).
const GROUPS = `
// Fixture :: { id :: Number, team :: Number }
`;

describe('has before get', () => {
  test('a ternary on has', () => {
    expect(diags(GROUPS + `
// idsByTeam :: [Fixture] -> Map Number [Number]
const idsByTeam = (fixtures) => fixtures.reduce ((acc, f) =>
  acc.set (f.team, (acc.has (f.team) ? acc.get (f.team) : []).concat ([f.id])), new Map ());
`)).toEqual([]);
  });

  test('a guard that adds the key, also in a loop body', () => {
    expect(diags(GROUPS + `
// groupByTeam :: [Fixture] -> Map Number [Fixture]
const groupByTeam = (fixtures) => {
  const byTeam = new Map ();
  fixtures.forEach (f => {
    if (!byTeam.has (f.team)) byTeam.set (f.team, []);
    byTeam.get (f.team).push (f);
  });
  for (const f of fixtures) {
    if (!byTeam.has (f.team)) {
      byTeam.set (f.team, []);
    }
    byTeam.get (f.team).push (f);
  }
  return byTeam;
};
`)).toEqual([]);
  });

  test('a guard that leaves the block', () => {
    expect(diags(GROUPS + `
// countOf :: (Map Number [Fixture], Number) -> Number
const countOf = (byTeam, team) => {
  if (!byTeam.has (team)) return 0;
  return byTeam.get (team).length;
};

// countIn :: (Map Number [Fixture], Number) -> Number
const countIn = (byTeam, team) => {
  if (byTeam.has (team) && byTeam.get (team).length > 0) return byTeam.get (team).length;
  return 0;
};
`)).toEqual([]);
  });

  test('another key or another map is still a possible miss', () => {
    const errors = diags(GROUPS + `
// countOf :: (Map Number [Fixture], Number, Number) -> Number
const countOf = (byTeam, team, other) => {
  if (!byTeam.has (team)) return 0;
  return byTeam.get (other).length;
};
`);
    expect(errors.length).toBeGreaterThan(0);
  });

  test('the else branch of has is still a possible miss', () => {
    const errors = diags(GROUPS + `
// countOf :: (Map Number [Fixture], Number) -> Number
const countOf = (byTeam, team) => byTeam.has (team) ? 0 : byTeam.get (team).length;
`);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe('has before get, with an else', () => {
  test('the key is present after both branches and inside the else', () => {
    expect(diags(GROUPS + `
// TeamState :: { id :: Number, games :: Number }

// play :: (Map Number TeamState, Number) -> Number
const play = (teams, id) => {
  if (!teams.has (id)) teams.set (id, { id, games: 0 });
  else teams.get (id).games += 1;
  return teams.get (id).games;
};
`)).toEqual([]);
  });
});
