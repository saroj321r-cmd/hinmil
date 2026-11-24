// Regression for fpkit src/test/laws/Alt.js:
//
//   // associativity :: (Alt f, Setoid (f a)) => f a -> f a -> f a -> Boolean
//   const associativity = a => b => c => ...;
//   // distributivity :: (Alt f, Setoid (f a), Functor f) => f a -> f a -> (a -> b) -> Boolean
//   const distributivity = a => b => f => ...;
//   const altLaws = () => ({ associativity, distributivity });
//
// Hovering `altLaws` must show the per-field constraint prefixes — they used
// to be dropped, rendering `() -> { associativity :: f a -> f a -> f a ->
// Boolean, ... }` with no mention of Alt/Setoid/Functor.
import { InferenceEngine } from '../../src/infer';
import { resetTypeVarCounter } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';
import { buildHover, applyDeclaredSchemeDisplay } from '../../src/services/hover';
import type { Type } from '../../src/hm/types';

let engine: InferenceEngine;

beforeEach(() => {
  clearCustomMethods();
  resetTypeVarCounter();
  engine = new InferenceEngine();
});

function hoverAt(src: string, offset: number): string | null {
  const r = engine.infer(src);
  return hoverFromResult(src, r, offset, 'file:///t.js');
}

/**
 * Mirrors the server's onHover node selection INCLUDING the declaration-site
 * `declaredSchemes` branch (which re-instantiates the generic scheme for
 * display but must keep `rawBestType` as the constraint source — the
 * regression this file guards against).
 */
function hoverFromResult(
  src: string,
  r: ReturnType<InferenceEngine['infer']>,
  offset: number,
  uri: string,
): string | null {
  let bestStart = -1;
  let bestType: Type | null = null;
  let rawBestType: Type | null = null;
  for (const [s, info] of r.nodeTypes) {
    const end = (info as { end: number }).end;
    if (s <= offset && offset < end && s > bestStart) {
      bestStart = s;
      bestType = r.substitution.apply((info as { type: Type }).type);
      rawBestType = (info as { type: Type }).type;
    }
  }
  if (bestStart >= 0) {
    // Same declaration-site branch as the server's onHover: show the generic
    // scheme but keep rawBestType so kvConstraints lookups (raw var ids) hit.
    ({ bestType, rawBestType } = applyDeclaredSchemeDisplay(r, bestStart, bestType, rawBestType));
  }
  const h = buildHover({
    source: src, offset, result: r, bestType, rawBestType, bestStart, arrayShift: 0,
    inferredTypeStyle: 'pretty', uri,
    resolveImportSpecifier: () => null,
    extractImportSpecifiers: () => new Map(),
  } as Parameters<typeof buildHover>[0]);
  return h ? (h.contents as { value: string }).value : null;
}

const SRC = `"use strict";
// ::constraint Setoid s { s :: { equals :: s ~> s -> Boolean } }
// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }
// ::constraint Alt f { f :: { alt :: f a ~> f a -> f a } }

// alt :: Alt f => f a -> f a -> f a
const alt = a => b => a;
// equals :: Setoid a => a -> a -> Boolean
const equals = a => b => true;
// map :: Functor f => (a -> b) -> f a -> f b
const map = f => fa => fa;

// associativity :: (Alt f, Setoid (f a)) => f a -> f a -> f a -> Boolean
const associativity = a => b => c =>
  equals (alt (alt (c) (b)) (a)) (alt (c) (alt (b) (a)));

// distributivity :: (Alt f, Setoid (f a), Functor f) => f a -> f a -> (a -> b) -> Boolean
const distributivity = a => b => f =>
  equals (alt (map (f) (b)) (map (f) (a))) (map (f) (alt (b) (a)));

const altLaws = () => ({
  associativity,
  distributivity
});
`;

describe('altLaws hover: constraints preserved on object-literal fields', () => {
  test('hover on altLaws keeps per-field constraint prefixes', () => {
    const off = SRC.indexOf('altLaws') + 1;
    const h = hoverAt(SRC, off)!;
    expect(h).not.toBeNull();
    // Both fields must be present
    expect(h).toContain('associativity ::');
    expect(h).toContain('distributivity ::');
    // Constraints must not be dropped
    expect(h).toContain('Alt');
    expect(h).toContain('Setoid');
    expect(h).toContain('Functor');
  });

  test('hover on the shorthand field inside the object keeps constraints', () => {
    const off = SRC.lastIndexOf('associativity') + 1;
    const h = hoverAt(SRC, off)!;
    expect(h).not.toBeNull();
    expect(h).toContain('Alt');
    expect(h).toContain('Setoid');
  });
});

// ---------------------------------------------------------------------------
// Cross-module variant: the fl helpers are require()d (as in the real fpkit
// layout) and the constraint definitions come from the project globals file.
// ---------------------------------------------------------------------------
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { ImportInferenceContext } from '../../src/services/importContext';

const tmpRoot = '/tmp/hm-altlaws-hover-test';

const GLOBALS = [
  '// ::constraint Alt f { f :: { alt :: f a ~> f a -> f a } }',
  '// ::constraint Setoid s { s :: { equals :: s ~> s -> Boolean } }',
  '// ::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }',
].join('\n');

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  writeFile('fl/alt.js', [
    '"use strict";',
    '// alt :: Alt f => f a -> f a -> f a',
    'const alt = a => b => a;',
    'module.exports = alt;',
  ].join('\n'));
  writeFile('fl/equals.js', [
    '"use strict";',
    '// equals :: Setoid a => a -> a -> Boolean',
    'const equals = a => b => true;',
    'module.exports = equals;',
  ].join('\n'));
  writeFile('fl/map.js', [
    '"use strict";',
    '// map :: Functor f => (a -> b) -> f a -> f b',
    'const map = f => fa => fa;',
    'module.exports = map;',
  ].join('\n'));
});

const ALT_LAWS_SRC = `"use strict";

const alt = require ("./fl/alt");
const equals = require ("./fl/equals");
const map = require ("./fl/map");

// associativity :: (Alt f, Setoid (f a)) => f a -> f a -> f a -> Boolean
const associativity = a => b => c => {
  const lhs = alt (c) (alt (b) (a));
  const rhs = alt (alt (c) (b)) (a);

  return equals (rhs) (lhs);
};

// distributivity :: (Alt f, Setoid (f a), Functor f) => f a -> f a -> (a -> b) -> Boolean
const distributivity = a => b => f => {
  const lhs = map (f) (alt (b) (a));
  const rhs = alt (map (f) (b)) (map (f) (a));

  return equals (rhs) (lhs);
};

const altLaws = () => ({
  associativity,
  distributivity
});

module.exports = altLaws;
`;

function hoverCrossModule(src: string, offset: number): string | null {
  const consumerPath = writeFile('laws/Alt.js', src);
  const fileUri = pathToFileURL(consumerPath).href;
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  const resolver = ctx.createImportResolver(fileUri);
  const typeResolver = ctx.createTypeDirectiveResolver(fileUri);
  const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
  const eng = new InferenceEngine();
  eng.globalsSource = GLOBALS;
  const r = eng.infer(src, undefined, resolver, typeResolver, aliasResolver);
  return hoverFromResult(src, r, offset, fileUri);
}

describe('altLaws hover (cross-module, globals-file constraints)', () => {
  test('hover on altLaws keeps the field constraints', () => {
    const off = ALT_LAWS_SRC.indexOf('const altLaws') + 'const '.length + 1;
    const h = hoverCrossModule(ALT_LAWS_SRC, off)!;
    expect(h).not.toBeNull();
    expect(h).toContain('associativity ::');
    expect(h).toContain('distributivity ::');
    expect(h).toContain('Alt');
    expect(h).toContain('Setoid');
    expect(h).toContain('Functor');
  });
});
