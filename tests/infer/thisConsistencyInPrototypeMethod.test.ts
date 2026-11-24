// Verifies `this` is consistently typed as `[a]` inside the body of an
// Array-style prototype method declared via a `Type a ~> Type a -> R`
// annotation on an object property assignment
// (`natives.Array = function(other){...}`).  The user reported that hover
// for `this` is not uniformly `[a]` across the body — this test pins down
// the actual behaviour.

import { parseStrict } from '../../src/parsing';
import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, prettyTypeToString } from '../../src/hm/types';
import { scrubSkolems } from '../../src/hm/typeUtils';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

let engine: InferenceEngine;

// Mirror the server's hover path: a function/method body checked against an
// annotation is inferred against rigid skolems, which are scrubbed back to the
// annotation's display letters before being shown to the user.
const show = (t: unknown): string =>
  prettyTypeToString(scrubSkolems((engine as any).subst.apply(t), (engine as any).skolemDisplayNames));

beforeEach(() => {
  resetTypeVarCounter();
  clearDataTypes();
  clearCustomMethods();
  engine = new InferenceEngine();
});

const collectThisOffsets = (src: string): number[] => {
  const ast = parseStrict(src);
  const offsets: number[] = [];
  const walk = (node: any) => {
    if (!node || typeof node !== 'object') return;
    if (node.type === 'ThisExpression' && typeof node.start === 'number') {
      offsets.push(node.start);
    }
    for (const k of Object.keys(node)) {
      const v = (node as any)[k];
      if (Array.isArray(v)) v.forEach(walk);
      else if (v && typeof v === 'object' && typeof v.type === 'string') walk(v);
    }
  };
  walk(ast);
  return offsets;
};

describe('`this` typing inside prototype-style Array method', () => {
  test('every `this` node resolves to `[a]`', () => {
    const src = `
const natives = {};
// natives.Array :: Array a ~> Array a -> Boolean
natives.Array = function (other) {
  const buh = other.constructor;
  if (this.length === other.length) return false;
  return this.every(function (item, idx) { return item === other[idx]; });
};
`;
    const r = engine.infer(src);
    const errs = r.diagnostics.filter(d => d.severity !== 3 && !d.message.includes('Unused'));
    // Don't fail the test on unrelated diagnostics — just print them.
    if (errs.length > 0) {
      // eslint-disable-next-line no-console
      console.log('Diagnostics:', errs.map(d => d.message));
    }

    const offsets = collectThisOffsets(src);
    expect(offsets.length).toBeGreaterThan(0);

    const types: { off: number; pretty: string }[] = [];
    for (const off of offsets) {
      const entry = (r as any).nodeTypes?.get(off);
      const t = entry?.type;
      const applied = t ? show(t) : null;
      types.push({ off, pretty: applied ?? '<none>' });
    }

    // Pretty-print all `this` types so we can see drift in the failure msg.
    // eslint-disable-next-line no-console
    console.log('this offsets:\n' + types.map(({ off, pretty }) => `  this @${off} -> ${pretty}`).join('\n'));
    const message = types.map(({ off, pretty }) => `  this @${off} -> ${pretty}`).join('\n');
    for (const { pretty } of types) {
      expect({ at: types, expected: '[a]', actual: pretty, message }).toMatchObject({ actual: '[a]' });
    }
  });

  // Regression: the user's `equals.js` shape — exact same pattern,
  // additionally checks `other` (the method parameter) and `buh`
  // (a local bound to `other.constructor`).
  test('parameter `other` is `[a]` and `other.constructor` is the Array ctor', () => {
    const src = `
const natives = {};
// natives.Array :: Array a ~> Array a -> Boolean
natives.Array = function (other) {
  const buh = other.constructor;
  return this.length === other.length;
};
`;
    const r = engine.infer(src);

    // Find every 'other' identifier inside the function body.
    const fnStart = src.indexOf('function (other)');
    const bodyEnd = src.indexOf('};', fnStart);
    const otherRe = /\bother\b/g;
    otherRe.lastIndex = fnStart;
    const otherOffsets: number[] = [];
    let m: RegExpExecArray | null;
    while ((m = otherRe.exec(src)) !== null && m.index < bodyEnd) {
      otherOffsets.push(m.index);
    }
    expect(otherOffsets.length).toBeGreaterThanOrEqual(3);
    for (const off of otherOffsets) {
      const e = (r as any).nodeTypes.get(off);
      expect(e).toBeDefined();
      expect(show(e.type)).toBe('[a]');
    }

    // `buh` (the const binding) must have the Array constructor type.
    const buhStart = src.indexOf('buh = ') - 'const '.length;
    const buhIdent = src.indexOf('buh', buhStart);
    const buhEntry = (r as any).nodeTypes.get(buhIdent);
    expect(buhEntry).toBeDefined();
    expect(show(buhEntry.type)).toBe('(..., a | Number) -> [a]');

    // `other.constructor` member access also has the Array ctor type.
    const propStart = src.indexOf('constructor', buhIdent);
    const propEntry = (r as any).nodeTypes.get(propStart);
    expect(propEntry).toBeDefined();
    expect(show(propEntry.type)).toBe('(..., a | Number) -> [a]');
  });
});
