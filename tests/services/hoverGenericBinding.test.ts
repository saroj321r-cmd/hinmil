// P5: hover shows the generalized type of a polymorphic top-level binding at
// its declaration site, not a type specialized by a downstream call site.
//
// Reproduces the fpkit `src/object/prop.js` leak where hovering the generic
// `walkPath`/`stepper` showed `Maybe { address :: { zip :: b } }` — the record
// shape from a later `prop([...])({address:{zip}})` call leaking into the
// generic function's displayed type. The engine now records the generalized
// scheme in `result.declaredSchemes`, keyed by the declaration offset, which
// hover prefers over the live substitution-applied node type.

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { clearCustomMethods } from '../../src/registries/methodRegistry';
import { clearDataTypes } from '../../src/registries/dataTypeRegistry';
import { prettyTypeToString, resetTypeVarCounter } from '../../src/hm/types';
import { instantiate } from '../../src/hm/env';
import type { Type } from '../../src/hm/types';

let tmpRoot: string;

beforeEach(() => {
  clearCustomMethods();
  clearDataTypes();
  resetTypeVarCounter();
});

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-hover-generic-'));
  fs.mkdirSync(path.join(tmpRoot, 'fl'), { recursive: true });
  fs.writeFileSync(path.join(tmpRoot, 'fl/reduce.js'),
    '// reduce :: Foldable f => (b -> a -> b) -> b -> f a -> b\n'
    + 'const reduce = f => acc => xs => acc;\nmodule.exports = reduce;\n');
  fs.writeFileSync(path.join(tmpRoot, 'fl/chain.js'),
    '// chain :: Chain m => (a -> m b) -> m a -> m b\n'
    + 'const chain = f => m => m;\nmodule.exports = chain;\n');
  fs.writeFileSync(path.join(tmpRoot, 'Maybe.js'),
    '// Maybe :: Nothing | Just a\nfunction Maybe() {}\n'
    + '// Nothing :: () -> Maybe a\nfunction Nothing() {}\n'
    + '// Just :: a -> Maybe a\nfunction Just(value) { this.value = value; }\n'
    + 'module.exports = { Nothing, Just };\n');
});

afterAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

const PROP_SRC = `"use strict";
const chain = require ("./fl/chain");
const reduce = require ("./fl/reduce");
const Maybe = require ("./Maybe");
const { Nothing, Just } = Maybe;

const stepper = found => key =>
  chain (prop (key)) (found);

const walkPath = keys => obj =>
  reduce (stepper) (Just (obj)) (keys);

// prop :: k1 -> { [k1] :: a } -> Maybe a
// prop :: [k1, k2] -> { [k1] :: { [k2] :: a } } -> Maybe a
const prop = key => obj => {
  return walkPath (key) (obj);
};

const city = prop(["address", "zip"])({ address: { zip: 400 } });
`;

function inferProp() {
  const file = path.join(tmpRoot, 'prop.js');
  fs.writeFileSync(file, PROP_SRC);
  const fileUri = pathToFileURL(file).href;
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  ctx.setProjectConfig(tmpRoot, {});
  const eng = new InferenceEngine();
  return eng.infer(
    PROP_SRC, undefined,
    ctx.createImportResolver(fileUri),
    ctx.createTypeDirectiveResolver(fileUri),
    ctx.createImportTypeAliasResolver(fileUri),
  );
}

/** Mirror the server hover lookup: most specific node type at an offset. */
function rawHoverTypeAt(
  result: ReturnType<InferenceEngine['infer']>, off: number,
): { bestStart: number; type: Type | null } {
  let bestStart = -1;
  let type: Type | null = null;
  for (const [start, { type: t, end }] of result.nodeTypes) {
    if (start <= off && off < end && start > bestStart) {
      type = result.substitution.apply(t);
      bestStart = start;
    }
  }
  return { bestStart, type };
}

describe('hover: generic top-level binding not specialized by call site', () => {
  test('walkPath hover shows generic type without leaked address/zip fields', () => {
    const result = inferProp();
    const off = PROP_SRC.indexOf('walkPath = ');
    const { bestStart, type } = rawHoverTypeAt(result, off);

    // The live-substitution node type no longer leaks the downstream call's
    // record shape: overload-union label vars are now freshened per call site
    // (see overloadUnionLabelFreshening.test.ts), so the `prop([...])({...})`
    // call below can no longer pin the label keys used inside `walkPath`.
    expect(type).not.toBeNull();
    expect(prettyTypeToString(type!)).not.toMatch(/address|zip/);

    // The recorded generalized scheme (what hover now displays) is generic.
    const scheme = result.declaredSchemes?.get(bestStart);
    expect(scheme).toBeDefined();
    const generic = prettyTypeToString(instantiate(scheme!));
    expect(generic).not.toMatch(/address|zip/);
  });

  test('stepper hover shows generic type without leaked fields', () => {
    const result = inferProp();
    const off = PROP_SRC.indexOf('stepper = ');
    const { bestStart } = rawHoverTypeAt(result, off);
    const scheme = result.declaredSchemes?.get(bestStart);
    expect(scheme).toBeDefined();
    const generic = prettyTypeToString(instantiate(scheme!));
    expect(generic).not.toMatch(/address|zip/);
  });
});
