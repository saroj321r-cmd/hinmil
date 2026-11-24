// Plan v6.4 Werkstroom 5 — Node.js globals (process, Buffer, __dirname,
// __filename, setImmediate, clearImmediate, queueMicrotask, global).

import { InferenceEngine } from '../../src/infer';
import { typeToString, resetTypeVarCounter } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

let engine: InferenceEngine;

beforeEach(() => {
  clearCustomMethods();
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

function noUnbound(diags: { message: string }[], name: string): void {
  const found = diags.filter(d =>
    d.message.includes(`Unbound variable: '${name}'`),
  );
  expect(found).toEqual([]);
}

describe('Plan v6.4 W5 — Node.js globals', () => {
  test('process.exit(0) infers without diagnostic', () => {
    const src = `process.exit(0);`;
    const r = engine.infer(src);
    noUnbound(r.diagnostics, 'process');
  });

  test('process.argv :: [String]', () => {
    const src = `const xs = process.argv;`;
    const r = engine.infer(src);
    expect(typeToString(r.topLevelBindings.get('xs')!.type)).toBe('[String]');
  });

  test('process.versions.node :: String', () => {
    const src = `const v = process.versions.node;`;
    const r = engine.infer(src);
    expect(typeToString(r.topLevelBindings.get('v')!.type)).toBe('String');
  });

  test('process.pid :: Number', () => {
    const src = `const p = process.pid;`;
    const r = engine.infer(src);
    expect(typeToString(r.topLevelBindings.get('p')!.type)).toBe('Number');
  });

  test('process.cwd() :: String', () => {
    const src = `const c = process.cwd();`;
    const r = engine.infer(src);
    expect(typeToString(r.topLevelBindings.get('c')!.type)).toBe('String');
  });

  test('typeof process !== "undefined" guard has no Unbound diag', () => {
    // Pattern from fpkit's src/Either/index.js.
    const src = `
if (
  typeof process !== "undefined" &&
  process != null &&
  process.versions != null &&
  process.versions.node != null
) {
  const x = 1;
}
    `;
    const r = engine.infer(src);
    noUnbound(r.diagnostics, 'process');
  });

  test('__dirname and __filename are String', () => {
    const src = `const d = __dirname; const f = __filename;`;
    const r = engine.infer(src);
    expect(typeToString(r.topLevelBindings.get('d')!.type)).toBe('String');
    expect(typeToString(r.topLevelBindings.get('f')!.type)).toBe('String');
  });

  test('Buffer.from("hi") :: Buffer', () => {
    const src = `const b = Buffer.from("hi");`;
    const r = engine.infer(src);
    expect(typeToString(r.topLevelBindings.get('b')!.type)).toBe('Buffer');
  });

  test('Buffer.from("hi").length :: Number', () => {
    const src = `const n = Buffer.from("hi").length;`;
    const r = engine.infer(src);
    expect(typeToString(r.topLevelBindings.get('n')!.type)).toBe('Number');
  });

  test('Buffer.isBuffer(x) :: Boolean', () => {
    const src = `const b = Buffer.isBuffer(42);`;
    const r = engine.infer(src);
    expect(typeToString(r.topLevelBindings.get('b')!.type)).toBe('Boolean');
  });

  test('setImmediate / queueMicrotask are bound', () => {
    const src = `
setImmediate(() => null);
queueMicrotask(() => null);
    `;
    const r = engine.infer(src);
    noUnbound(r.diagnostics, 'setImmediate');
    noUnbound(r.diagnostics, 'queueMicrotask');
  });

  test('global is bound', () => {
    const src = `const g = global;`;
    const r = engine.infer(src);
    noUnbound(r.diagnostics, 'global');
  });
});
