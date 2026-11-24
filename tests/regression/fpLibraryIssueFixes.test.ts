// Regression coverage for the fpkit issue set (10 fixes):
//   1.  Hover surfaces `::narrow` narrowing info.
//   2.  `::rep Setoid Function#equals` accepts a `(* -> a)` (TFun) receiver.
//   3.  Typed-array builtin types (Uint8Array, …) are known + carry methods.
//   4.  Generator functions (`function*`) infer `Generator <element>`.
//   5.  Relational operators (`<`, `>`, `<=`, `>=`) accept String operands.
//   6.  Static `::rep` uses a `.` separator and binds `natives.<Type>` forms.
//   7.  Global `String`/`Number`/`Boolean` are polymorphic (no cross-call pin).
//   8.  `toString` / `valueOf` are callable methods, not opaque properties.
//   9.  Bare global `toString` is in scope (`toString.call(x)`).
//   10. Hover surfaces `TypeRep` type-representative info.

import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, prettyTypeToString } from '../../src/hm/types';
import type { Type } from '../../src/hm/types';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';
import { clearCustomMethods } from '../../src/registries/methodRegistry';
import { clearConstraints } from '../../src/registries/constraintRegistry';
import { buildHover } from '../../src/services/hover';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  clearDataTypes();
  clearCustomMethods();
  clearConstraints();
  engine = new InferenceEngine();
});

/** Error-severity diagnostics only (severity 1 or undefined). */
function errors(r: ReturnType<InferenceEngine['infer']>) {
  return r.diagnostics.filter((d) => d.severity === 1 || d.severity === undefined);
}

/** Substituted, pretty-printed type of the node covering an identifier use.
 *  Scans every standalone occurrence of `token` and returns the first that has
 *  a recorded node type (declaration identifiers record none, so this lands on
 *  a usage). */
function typeAtToken(
  src: string,
  r: ReturnType<InferenceEngine['infer']>,
  token: string,
): string | null {
  const re = new RegExp(`(?<![A-Za-z0-9_$])${token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Za-z0-9_$])`, 'g');
  for (let m = re.exec(src); m; m = re.exec(src)) {
    const off = m.index;
    let best: Type | null = null;
    let bestStart = -1;
    for (const [start, entry] of r.nodeTypes.entries()) {
      const end = (entry as { end?: number }).end ?? start;
      if (start <= off && off < end && start > bestStart) {
        bestStart = start;
        best = (entry as { type: Type }).type;
      }
    }
    if (best) return prettyTypeToString(r.substitution.apply(best));
  }
  return null;
}

/** Hover markdown at the given source offset. */
function hoverAt(src: string, r: ReturnType<InferenceEngine['infer']>, offset: number): string | null {
  let bestStart = -1;
  let bestType: Type | null = null;
  for (const [s, info] of r.nodeTypes) {
    const end = (info as { end: number }).end;
    if (s <= offset && offset < end && s > bestStart) {
      bestStart = s;
      bestType = r.substitution.apply((info as { type: Type }).type);
    }
  }
  const h = buildHover({
    source: src, offset, result: r, bestType, bestStart, arrayShift: 0,
    inferredTypeStyle: 'pretty', uri: 'file:///t.js',
    resolveImportSpecifier: () => null,
    extractImportSpecifiers: () => new Map(),
  } as Parameters<typeof buildHover>[0]);
  return h ? (h.contents as { value: string }).value : null;
}

// ── Issue 1: hover narrowing info ─────────────────────────────────────────
describe('issue 1 — hover surfaces ::narrow info', () => {
  const src = `
// ::narrow String
// isString :: a -> Boolean
const isString = x => typeof x === "string";
const probe = isString;
`;
  test('hover on isString mentions the narrowed type', () => {
    const r = engine.infer(src);
    // Hover the usage `isString` in `const probe = isString;`.
    const off = src.indexOf('isString', src.indexOf('probe')) + 2;
    const h = hoverAt(src, r, off);
    expect(h).toContain('Narrows');
    expect(h).toContain('String');
    expect(h).toContain('::narrow');
  });
});

// ── Issue 2: ::rep Function#equals with TFun receiver ─────────────────────
describe('issue 2 — ::rep Setoid Function#equals accepts (* -> a) receiver', () => {
  const src = `
// ::constraint Setoid a { a :: { equals :: a ~> a -> Boolean } }

// ::rep Setoid Function#equals
// Function#equals :: (* -> a) ~> (* -> a) -> Boolean
const _eqImpl = f => g => f === g;
`;
  test('no "no following signature" diagnostic for the Function rep', () => {
    const r = engine.infer(src);
    const bad = r.diagnostics.filter((d) =>
      /::rep Setoid .*equals.*no following/.test(d.message),
    );
    expect(bad).toHaveLength(0);
  });
});

// ── Issue 3: typed-array builtin types ────────────────────────────────────
describe('issue 3 — typed arrays are known builtins with methods', () => {
  test('Uint8Array annotation is accepted (no unknown-type diagnostic)', () => {
    const src = `
// buf :: Uint8Array
const buf = new Uint8Array(4);
`;
    const r = engine.infer(src);
    const unknown = r.diagnostics.filter((d) => /Uint8Array/.test(d.message) && /[Uu]nknown/.test(d.message));
    expect(unknown).toHaveLength(0);
  });

  test('typed-array instance method resolves', () => {
    const src = `
// buf :: Uint8Array
const buf = new Uint8Array(4);
const sub = buf.subarray(0, 2);
const subUse = sub;
`;
    const r = engine.infer(src);
    expect(typeAtToken(src, r, 'sub')).toBe('Uint8Array');
    const methodErr = errors(r).filter((d) => /subarray/.test(d.message));
    expect(methodErr).toHaveLength(0);
  });
});

// ── Issue 4: generator functions ──────────────────────────────────────────
describe('issue 4 — generator functions infer Generator <element>', () => {
  test('calling a generator yields a Generator whose .next().value is the element', () => {
    const src = `
function* g() {
  yield 1;
  yield 2;
}
const it = g();
const r = it.next();
const v = r.value;
const vUse = v;
`;
    const res = engine.infer(src);
    expect(errors(res)).toHaveLength(0);
    expect(typeAtToken(src, res, 'it')).toBe('Generator Number');
    expect(typeAtToken(src, res, 'v')).toBe('Number');
  });

  test('annotated generator with for/of body matches its element annotation', () => {
    const src = `
// chunkGen :: (Number, Array a) -> Array a
function* chunkGen(no, arr) {
  for (let i = 0; i < arr.length; i += no) {
    yield arr.slice(i, i + no);
  }
}
const gen = chunkGen(2, [1, 2, 3, 4]);
let c = gen.next();
const val = c.value;
const valUse = val;
`;
    const res = engine.infer(src);
    expect(errors(res)).toHaveLength(0);
    expect(typeAtToken(src, res, 'gen')).toBe('Generator [Number]');
  });
});

// ── Issue 5: relational operators with String operands ────────────────────
describe('issue 5 — relational operators accept String operands', () => {
  test('a <= b with String args does not force Number', () => {
    const src = `
const lte = a => b => a <= b;
const r = lte("x")("y");
`;
    const r = engine.infer(src);
    const unify = errors(r).filter((d) => /Cannot unify 'String' with 'Number'/.test(d.message));
    expect(unify).toHaveLength(0);
  });
});

// ── Issue 6: static ::rep separator + natives binding ─────────────────────
describe('issue 6 — static ::rep uses dot separator and binds natives.<Type>', () => {
  const src = `
// ::constraint Monoid m { m :: { empty :: () -> m } }

let natives = {};

// ::rep Monoid String.empty
// natives.String :: () -> String
natives.String = () => "";
`;
  test('no instance/static mismatch and the rep binds the natives.String signature', () => {
    const r = engine.infer(src);
    const sep = r.diagnostics.filter((d) =>
      /is an instance method|is a static method|no following/.test(d.message),
    );
    expect(sep).toHaveLength(0);
  });
});

// ── Issue 7: polymorphic String/Number/Boolean globals ────────────────────
describe('issue 7 — global String/Number/Boolean do not pin across calls', () => {
  test('String(null) then String(undefined) does not conflict', () => {
    const src = `
const a = String(null);
const b = String(undefined);
const aUse = a;
const bUse = b;
`;
    const r = engine.infer(src);
    const conflict = errors(r).filter((d) =>
      /Cannot unify 'Undefined' with 'Null'|Cannot unify 'Null' with 'Undefined'/.test(d.message),
    );
    expect(conflict).toHaveLength(0);
    expect(typeAtToken(src, r, 'a')).toBe('String');
    expect(typeAtToken(src, r, 'b')).toBe('String');
  });
});

// ── Issue 8: toString / valueOf are callable methods ──────────────────────
describe('issue 8 — toString/valueOf are callable methods', () => {
  test('(42).toString() is callable and returns String', () => {
    const src = `const s = (42).toString();
const sUse = s;`;
    const r = engine.infer(src);
    const notCallable = errors(r).filter((d) => /not callable/.test(d.message));
    expect(notCallable).toHaveLength(0);
    expect(typeAtToken(src, r, 's')).toBe('String');
  });

  test('"x".valueOf() returns String', () => {
    const src = `const v = "x".valueOf();
const vUse = v;`;
    const r = engine.infer(src);
    expect(errors(r).filter((d) => /not callable/.test(d.message))).toHaveLength(0);
    expect(typeAtToken(src, r, 'v')).toBe('String');
  });
});

// ── Issue 9: bare global toString ─────────────────────────────────────────
describe('issue 9 — bare global toString is in scope', () => {
  test('toString.call(x) does not report an unbound/unknown toString', () => {
    const src = `
// isObject :: a -> Boolean
const isObject = value => toString.call(value) === "[object Object]";
`;
    const r = engine.infer(src);
    const bad = errors(r).filter((d) =>
      /toString/.test(d.message) && /(not known|Unbound|not callable)/.test(d.message),
    );
    expect(bad).toHaveLength(0);
  });
});

// ── Issue 10: hover TypeRep info ──────────────────────────────────────────
describe('issue 10 — hover surfaces TypeRep info', () => {
  const src = `
// typeRepId :: TypeRep m -> TypeRep m
const typeRepId = tr => tr;
`;
  test('hover on a TypeRep-typed expression explains the type representative', () => {
    const r = engine.infer(src);
    // Hover the returned `tr` (its type is `TypeRep m`).
    const off = src.lastIndexOf('tr');
    const h = hoverAt(src, r, off);
    expect(h).toContain('Type representative');
  });
});
