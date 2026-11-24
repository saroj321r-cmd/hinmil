// =============================================================================
// Rank-N phase 6 — the sample/rankN/ files stay diagnostic-free, and their
// documented negative cases (commented out in the samples) really fire.
// =============================================================================

import * as fs from 'fs';
import * as path from 'path';
import { inferSource, diags } from '../helpers/infer';

const SAMPLE_DIR = path.join(__dirname, '..', '..', 'sample', 'rankN');

const SAMPLES = [
  '01-applyBoth.js',
  '02-naturality.js',
  '03-interpreter.js',
  '04-hoist.js',
  '05-lens.js',
  '06-withResource.js',
  '07-church.js',
  '08-dictionary.js',
];

function sampleSource(name: string): string {
  return fs.readFileSync(path.join(SAMPLE_DIR, name), 'utf8');
}

describe('rank-N samples are clean', () => {
  for (const name of SAMPLES) {
    test(name, () => {
      const r = inferSource(sampleSource(name));
      expect(r.diagnostics.map(d => d.message)).toEqual([]);
    });
  }
});

describe('rank-N samples: documented negative cases fire', () => {
  test('01-applyBoth: monomorphic callback rejected', () => {
    const src = sampleSource('01-applyBoth.js')
      + `\nconst bad = applyBoth(x => x + 1)(1, "one");\n`;
    const d = diags(src);
    expect(d.some(m => m.includes('not polymorphic enough'))).toBe(true);
  });

  test('01-applyBoth: wrong argument type in the curried second call rejected', () => {
    const src = sampleSource('01-applyBoth.js')
      + `\nconst bad = applyBoth(x => x)(true, "one");\n`;
    const d = diags(src);
    expect(d.some(m => m.includes('Boolean') && m.includes('Number'))).toBe(true);
  });

  test('02-naturality: Number-only transformation rejected', () => {
    const src = sampleSource('02-naturality.js') + `
// onlyNumbers :: Maybe Number -> Maybe Number
const onlyNumbers = mx => mx.map(x => x * 2);
const bad = applyNat(onlyNumbers)(Just(1), Just("one"));
`;
    const d = diags(src);
    expect(d.some(m => m.includes('not polymorphic enough'))).toBe(true);
  });

  test('03-interpreter: Number-only handler rejected', () => {
    const src = sampleSource('03-interpreter.js') + `
// numHead :: [Number] -> Maybe Number
const numHead = xs => (xs.length > 0 ? Just(xs[0] * 1) : Nothing());
const bad = firstOf(numHead)({ nums: [1], strs: ["a"] });
`;
    const d = diags(src);
    expect(d.some(m => m.includes('not polymorphic enough'))).toBe(true);
  });

  test('04-hoist: Maybe-specific step rejected', () => {
    const src = sampleSource('04-hoist.js') + `
// maybeOnly :: Maybe Number -> Maybe Number
const maybeOnly = mx => mx;
const bad = hoistTwice(maybeOnly)(Just(1));
`;
    const d = diags(src);
    expect(d.some(m => m.includes('not polymorphic enough'))).toBe(true);
  });

  test('06-withResource: monomorphic callback rejected', () => {
    const src = sampleSource('06-withResource.js') + `
// mono :: Number -> Number
const mono = x => x + 1;
const bad = withSecret(mono);
`;
    const d = diags(src);
    expect(d.some(m => m.includes('not polymorphic enough'))).toBe(true);
  });

  test('07-church: fake numeral rejected', () => {
    const src = sampleSource('07-church.js') + `
const fake = f => x => f(x) + 1;
const bad = toNumber(fake);
`;
    const d = diags(src);
    expect(d.some(m => m.includes('not polymorphic enough'))).toBe(true);
  });

  test('08-dictionary: identity-shaped map rejected', () => {
    const src = sampleSource('08-dictionary.js') + `
// badOps :: { map :: forall a b. (a -> b) -> [a] -> [b], name :: String }
const badOps = {
  map: _fn => xs => xs,
  name: "bad",
};
`;
    const d = diags(src);
    expect(d.some(m => m.includes('not polymorphic enough'))).toBe(true);
  });
});
