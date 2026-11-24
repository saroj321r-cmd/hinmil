// Tests for the convenience fallback that lets a known concrete type name
// be used directly as a constraint head, e.g. `Number r => r -> r`.  No
// `::constraint` definition is required; the constrained variable is baked
// to the concrete type (`r := Number`).
//
// Also exercises `.hm` sidecars carrying bare `::constraint` directives so
// importing files can use them.

import { resetTypeVarCounter, schemeToString } from '../../src/hm/types';
import { InferenceEngine } from '../../src/infer/index';
import { wrapHmSource } from '../../src/services/files';
import { extractConstraintDirectives } from '../../src/commentParser';
import { parseConstraintDirective, clearConstraints } from '../../src/registries/constraintRegistry';

beforeEach(() => {
  resetTypeVarCounter();
  clearConstraints();
});

function inferAndGet(src: string, names: string[]): Record<string, string> {
  const eng = new InferenceEngine();
  const r = eng.infer(src);
  const out: Record<string, string> = {};
  out.__diagnostics__ = r.diagnostics.map(d => d.message).join('\n');
  for (const n of names) {
    const sch = r.topLevelBindings.get(n);
    if (sch) out[n] = schemeToString(sch);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Type-as-constraint fallback
// ---------------------------------------------------------------------------

describe('type-as-constraint fallback', () => {
  test('`Number run =>` constrains run to Number on numeric arg', () => {
    const out = inferAndGet(`
// LimitA :: Number run => run -> LimitA run
const LimitA = (x) => x;

const a = LimitA(5);
`, ['a']);
    expect(out.__diagnostics__).not.toMatch(/Unknown constraint/);
    expect(out.a).toBe('LimitA Number');
  });

  test('`Number run =>` rejects a String argument', () => {
    const out = inferAndGet(`
// LimitA :: Number run => run -> LimitA run
const LimitA = (x) => x;

const b = LimitA("oops");
`, ['b']);
    expect(out.__diagnostics__).toMatch(/Cannot unify 'String' with 'Number'/);
  });

  test('`String s =>` works for the String built-in', () => {
    const out = inferAndGet(`
// tag :: String s => s -> [s]
const tag = x => [x];

const t = tag("hi");
`, ['t']);
    expect(out.__diagnostics__).not.toMatch(/Unknown constraint/);
    expect(out.t).toBe('[String]');
  });

  test('genuinely unknown name still produces an Unknown constraint diagnostic', () => {
    const out = inferAndGet(`
// f :: Bogus x => x -> x
const f = x => x;
`, ['f']);
    expect(out.__diagnostics__).toMatch(/Unknown constraint 'Bogus'/);
  });
});

// ---------------------------------------------------------------------------
// Bare `::constraint` / `::narrow` in `.hm` sources via wrapHmSource
// ---------------------------------------------------------------------------

describe('bare directives in `.hm` sources (no `//` prefix needed)', () => {
  test('bare `::constraint` is picked up after wrapHmSource', () => {
    const hm = `
::constraint Runnable r { r :: (a -> r) | r }

run :: Runnable r => r -> Limit r
`;
    const wrapped = wrapHmSource(hm);
    const directives = extractConstraintDirectives(wrapped);
    expect(directives.length).toBe(1);
    const def = parseConstraintDirective(directives[0].text);
    expect(def).not.toBeNull();
    expect(def!.name).toBe('Runnable');
    expect(def!.headerParams).toEqual(['r']);
    expect(def!.selfClauses?.length).toBe(1);
  });

  test('bare `::narrow` is picked up after wrapHmSource', () => {
    const hm = `
::narrow Boolean

isReady :: a -> Boolean
`;
    const wrapped = wrapHmSource(hm);
    expect(wrapped).toMatch(/^\/\/ ::narrow Boolean$/m);
  });
});

// ---------------------------------------------------------------------------
// `::constraint` in `.hm` sidecars is registered when the sidecar is loaded
// ---------------------------------------------------------------------------

describe('`::constraint` directives in `.hm` sidecars', () => {
  test('a wrapped `.hm` globals source registers its `::constraint` directive', () => {
    const hm = `
::constraint Runnable r { r :: (a -> r) | r }
`;
    const eng = new InferenceEngine();
    eng.globalsSource = wrapHmSource(hm);
    const r = eng.infer(`
// run :: Runnable r => r -> Limit r
const run = (x) => x;

// getLimit :: { limit :: Number } -> Number
const getLimit = p => p.limit;

const a = run(5);
const b = run(getLimit);
`);
    const diag = r.diagnostics.map(d => d.message).join('\n');
    expect(diag).not.toMatch(/Unknown constraint 'Runnable'/);
    const a = r.topLevelBindings.get('a');
    const b = r.topLevelBindings.get('b');
    expect(a && schemeToString(a)).toBe('Limit Number');
    expect(b && schemeToString(b)).toBe('Limit ({ limit :: Number } -> Number)');
  });
});
