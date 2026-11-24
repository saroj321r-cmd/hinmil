import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter, mono, tFun, tVar, Scheme } from '../../src/hm/types';

let engine: InferenceEngine;

beforeEach(() => {
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

/**
 * Mimic an external `curry.js` exporting a curry wrapper via CommonJS
 * `module.exports = curry`.  Returned scheme is marked `isCurryWrapper`.
 */
function curryModuleResolver(): (specifier: string) => Map<string, Scheme> | null {
  return (specifier: string) => {
    if (!specifier.endsWith('curry')) return null;
    const exports = new Map<string, Scheme>();
    exports.set('default', {
      ...mono(tFun(tVar('a'), tVar('b'))),
      isCurryWrapper: true,
    });
    return exports;
  };
}

/** Same as above but exposes curry as a named export (`module.exports = { curry }`). */
function curryNamedModuleResolver(): (specifier: string) => Map<string, Scheme> | null {
  return (specifier: string) => {
    if (!specifier.endsWith('curry')) return null;
    const exports = new Map<string, Scheme>();
    exports.set('curry', {
      ...mono(tFun(tVar('a'), tVar('b'))),
      isCurryWrapper: true,
    });
    return exports;
  };
}

describe('curry propagation via CommonJS require', () => {
  test('plain require with module.exports = curry marks consumer as collect', () => {
    const src = `
"use strict";
const curry = require('../more/curry');
const add = curry((a, b) => a + b);
`;
    const r = engine.infer(src, undefined, curryModuleResolver());
    expect(r.diagnostics).toHaveLength(0);
    // Binding 'add' was produced by a curry wrapper call → its node start
    // must appear in curriedNodes.
    const idx = src.indexOf('const add');
    // The decl node start points at the 'const' keyword; curriedNodes uses
    // the VariableDeclarator start (after 'const ').  Find that:
    const declStart = src.indexOf('add', idx);
    expect(r.curriedNodes.has(declStart)).toBe(true);
  });

  test('destructured require with module.exports = { curry } marks consumer as collect', () => {
    const src = `
"use strict";
const { curry } = require('../more/curry');
const add = curry((a, b) => a + b);
`;
    const r = engine.infer(src, undefined, curryNamedModuleResolver());
    expect(r.diagnostics).toHaveLength(0);
    const declStart = src.indexOf('add', src.indexOf('const add'));
    expect(r.curriedNodes.has(declStart)).toBe(true);
  });

  test('hasFunction.js pattern (fpkit) produces a collect binding', () => {
    // Resolver also serves stubs for isFunction + nil so the body type-checks.
    const resolver = (specifier: string): Map<string, Scheme> | null => {
      if (specifier.endsWith('curry')) {
        const exports = new Map<string, Scheme>();
        exports.set('default', {
          ...mono(tFun(tVar('a'), tVar('b'))),
          isCurryWrapper: true,
        });
        return exports;
      }
      if (specifier.endsWith('isFunction') || specifier.endsWith('nil')) {
        const exports = new Map<string, Scheme>();
        exports.set('default', mono(tFun(tVar('a'), tVar('b'))));
        return exports;
      }
      return null;
    };

    const src = `
"use strict";

const curry = require("../more/curry")
const isFunction = require("./isFunction");
const nil = require("./nil");

// hasFunction :: String -> a -> Boolean
const hasFunction = curry((fnName, value) =>
  nil (value) ? false : isFunction (value[fnName]));

module.exports = hasFunction;
`;
    const r = engine.infer(src, undefined, resolver);
    // The hasFunction binding must be flagged as collect.
    const declStart = src.indexOf('hasFunction', src.indexOf('const hasFunction'));
    expect(r.curriedNodes.has(declStart)).toBe(true);
  });

  test('end-to-end: real curry.js export feeds into consumer', () => {
    // First infer curry.js (the actual source used in fpkit).
    const curryEngine = new InferenceEngine();
    const currySrc = `
"use strict";

// curry :: ((a, b, ...) -> z) -> a -> b -> ... -> z
const curry = fn => {
  const collect = (...args) => {
    if (args.length >= fn.length) {
      return fn(...args);
    }
    return (...next) => collect(...args, ...next);
  }
  return collect;
}

module.exports = curry
`;
    const curryResult = curryEngine.infer(currySrc);
    // curry.js must export 'default' as a curry wrapper.
    const defaultScheme = curryResult.exports.get('default');
    expect(defaultScheme).toBeDefined();
    expect(defaultScheme!.isCurryWrapper).toBe(true);

    // Now infer the consumer using curry.js's exports.
    const consumerSrc = `
"use strict";
const curry = require('../more/curry');

// cHas :: String -> a -> Boolean
const cHas = curry((fnName, value) => typeof value[fnName] === 'function');
`;
    const consumerEngine = new InferenceEngine();
    const r = consumerEngine.infer(consumerSrc, undefined, (specifier) => {
      if (specifier.endsWith('curry')) return curryResult.exports;
      return null;
    });

    const declStart = consumerSrc.indexOf('cHas', consumerSrc.indexOf('const cHas'));
    expect(r.curriedNodes.has(declStart)).toBe(true);
  });

  test('collect annotation propagates types to lambda params', () => {
    const src = `
"use strict";
// curry :: ((a, b, ...) -> z) -> a -> b -> ... -> z
const curry = fn => fn;

// hasFunction :: String -> a -> Boolean
const hasFunction = curry((fnName, value) => value[fnName] === fnName);
`;
    const r = engine.infer(src);
    const fnNamePos = src.indexOf('fnName,');
    const entry = r.nodeTypes.get(fnNamePos);
    expect(entry).toBeDefined();
    const { typeToString } = require('../../src/hm/types');
    const s = typeToString(entry!.type);
    expect(s).toMatch(/String/);
    expect(s).not.toMatch(/Number/);
  });
});
