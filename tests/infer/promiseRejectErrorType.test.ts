import { InferenceEngine } from '../../src/infer';
import { typeToString, resetTypeVarCounter } from '../../src/hm/types';

beforeEach(() => resetTypeVarCounter());

function typeOfConst(res: any, src: string, name: string): string {
  const off = src.indexOf(`const ${name} `) + 'const '.length;
  const entry = res.nodeTypes.get(off);
  expect(entry).toBeDefined();
  return typeToString(entry.type);
}

describe('Promise.reject error channel (p8)', () => {
  test('`Promise.reject(2)` carries the error type in the e channel', () => {
    const src = `const r = Promise.reject(2);`;
    const engine = new InferenceEngine();
    const res = engine.infer(src);
    expect(res.diagnostics.map((d: any) => d.message)).toEqual([]);
    expect(typeOfConst(res, src, 'r')).toBe('Promise Number a');
  });

  test('`Promise.reject` inside a function preserves the error type', () => {
    const src = `
const make = () => Promise.reject(2);
const r = make();
`;
    const engine = new InferenceEngine();
    const res = engine.infer(src);
    expect(res.diagnostics.map((d: any) => d.message)).toEqual([]);
    expect(typeOfConst(res, src, 'r')).toBe('Promise Number a');
  });

  test('`Array.of(2)` links the element type to the argument', () => {
    const src = `const r = Array.of(2);`;
    const engine = new InferenceEngine();
    const res = engine.infer(src);
    expect(res.diagnostics.map((d: any) => d.message)).toEqual([]);
    expect(typeOfConst(res, src, 'r')).toBe('[Number]');
  });
});
