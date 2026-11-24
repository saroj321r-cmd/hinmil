// Regression: Either#ap with cross-module imported chain/map (with
// `Chain m =>` / `Functor f =>` constraints) used to produce inferred
// types containing a unary `Either` (e.g. `Either e (a -> Either e)`).
import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { wrapHmSource } from '../../src/services/files';
import { prettyTypeToString, resetTypeVarCounter, Type } from '../../src/hm/types';

const tmpRoot = '/tmp/hm-either-ap-test';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  writeFile('globals.hm', [
    '::constraint Functor f { f :: { map :: f a ~> (a -> b) -> f b } }',
    '::constraint Chain m { m :: { chain :: m a ~> (a -> m b) -> m b } }',
    '',
  ].join('\n'));

  writeFile('fl/chain.js', [
    '"use strict";',
    '// chain :: Chain m => (a -> m b) -> m a -> m b',
    'const chain = fn => chainable => chainable.chain (fn);',
    'module.exports = chain;',
  ].join('\n'));

  writeFile('fl/map.js', [
    '"use strict";',
    '// map :: Functor f => (a -> b) -> f a -> f b',
    'const map = fn => functor => functor.map (fn);',
    'module.exports = map;',
  ].join('\n'));
});

beforeEach(() => resetTypeVarCounter());

function inferConsumer(source: string) {
  const consumerPath = writeFile('Either.js', source);
  const fileUri = pathToFileURL(consumerPath).href;
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  const globalsFilePath = path.join(tmpRoot, 'globals.hm');
  const globalsSource = wrapHmSource(fs.readFileSync(globalsFilePath, 'utf-8'));
  ctx.setProjectConfig(tmpRoot, { globalsSource, globalsFilePath });
  const resolver = ctx.createImportResolver(fileUri);
  const typeResolver = ctx.createTypeDirectiveResolver(fileUri);
  const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
  const eng = new InferenceEngine();
  eng.globalsSource = globalsSource;
  return eng.infer(source, undefined, resolver, typeResolver, aliasResolver);
}

describe('Either#ap cross-module — unary Either regression', () => {
  const eitherSource = `
"use strict";
const chain = require ("./fl/chain");
const map = require ("./fl/map");

// Either :: Left e | Right a
// Left :: e -> Either e a
function Left(value) { this.value = value; }
// Right :: a -> Either e a
function Right(value) { this.value = value; }

// Either#map :: Either e a ~> (a -> b) -> Either e b
Left.prototype.map = function (_fn) { return this; };
Right.prototype.map = function (fn) { return new Right (fn (this.value)); };

// Either#ap :: Either e a ~> Either e (a -> b) -> Either e b
Left.prototype.ap = function (other) {
  return chain (fn => map (fn) (this)) (other);
};

Right.prototype.ap = function (other) {
  return chain (fn => map (fn) (this)) (other);
};

// Either#chain :: Either e a ~> (a -> Either e b) -> Either e b
Left.prototype.chain = function (_fn) { return this; };
Right.prototype.chain = function (fn) { return fn (this.value); };
`;

  test('hover signature for ap uses annotation verbatim', () => {
    const r = inferConsumer(eitherSource);
    const apOffset = eitherSource.indexOf('Left.prototype.ap') + 'Left.prototype.'.length;
    const sig = r.methodSignatures.get(apOffset);
    expect(sig).toBeDefined();
    expect(sig).toContain('Either e a ~> Either e (a -> b) -> Either e b');
  });

  test('no recorded node type renders a unary Either', () => {
    const r = inferConsumer(eitherSource);
    const offenders: Array<{ offset: number; rendered: string }> = [];
    const visit = (t: Type, offset: number) => {
      if (t.tag === 'TCon' && t.name === 'Either' && t.args.length !== 2) {
        offenders.push({ offset, rendered: prettyTypeToString(t) });
      }
      if (t.tag === 'TCon') t.args.forEach(a => visit(a, offset));
      if (t.tag === 'TFun') { visit(t.param, offset); visit(t.result, offset); }
    };
    for (const [offset, entry] of r.nodeTypes.entries()) {
      visit(r.substitution.apply(entry.type), offset);
    }
    expect(offenders).toEqual([]);
  });

  test('no Type mismatch diagnostic mentions unary Either', () => {
    const r = inferConsumer(eitherSource);
    const bad = r.diagnostics.filter(d =>
      /Either e \([^()]*-> Either e\)/.test(d.message) ||
      /Either e \(Either e\)/.test(d.message),
    );
    expect(bad.map(d => d.message)).toEqual([]);
  });

  // Order-dependence regression: opening `chain.js` before re-validating
  // Either.js used to change the diagnostics for Either#ap (user's
  // "flicker" bug).  Two passes against the same context should produce
  // the same diagnostic set.
  test('diagnostics for Either#ap are stable across context re-use', () => {
    const consumerPath = writeFile('Either.js', eitherSource);
    const consumerUri = pathToFileURL(consumerPath).href;
    const chainPath = path.join(tmpRoot, 'fl/chain.js');
    const chainUri = pathToFileURL(chainPath).href;
    const chainSource = fs.readFileSync(chainPath, 'utf-8');

    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    const globalsFilePath = path.join(tmpRoot, 'globals.hm');
    const globalsSource = wrapHmSource(fs.readFileSync(globalsFilePath, 'utf-8'));
    ctx.setProjectConfig(tmpRoot, { globalsSource, globalsFilePath });

    const runEither = () => {
      resetTypeVarCounter();
      const eng = new InferenceEngine();
      eng.globalsSource = globalsSource;
      return eng.infer(
        eitherSource,
        undefined,
        ctx.createImportResolver(consumerUri),
        ctx.createTypeDirectiveResolver(consumerUri),
        ctx.createImportTypeAliasResolver(consumerUri),
      );
    };

    const runChain = () => {
      resetTypeVarCounter();
      const eng = new InferenceEngine();
      eng.globalsSource = globalsSource;
      return eng.infer(
        chainSource,
        undefined,
        ctx.createImportResolver(chainUri),
        ctx.createTypeDirectiveResolver(chainUri),
        ctx.createImportTypeAliasResolver(chainUri),
      );
    };

    // Pass 1: Either inferred fresh, chain pulled in lazily via resolver.
    const r1 = runEither();
    const diags1 = r1.diagnostics.map(d => d.message).sort();

    // Now simulate user opening chain.js — invalidate its cache and
    // re-infer it (this updates the cached snapshot for chain.js).
    ctx.invalidateFileCache(chainUri);
    runChain();

    // Pass 2: re-infer Either.js with the (now possibly different)
    // cached state for chain.js.
    ctx.invalidateFileCache(consumerUri);
    const r2 = runEither();
    const diags2 = r2.diagnostics.map(d => d.message).sort();

    expect(diags2).toEqual(diags1);

    // Likewise, methodSignature for ap must be stable.
    const apOffset = eitherSource.indexOf('Left.prototype.ap') + 'Left.prototype.'.length;
    expect(r2.methodSignatures.get(apOffset)).toBe(r1.methodSignatures.get(apOffset));
  });

  // Fase 1: getImportedRawSignature must surface the verbatim
  // `// chain :: ...` annotation written in fl/chain.js even though the
  // providing module is a JS file (no .hm sidecar).  Used by hover to
  // show the imported binding's annotation on the import line.
  test('getImportedRawSignature reads JS comment annotations', () => {
    const consumerPath = writeFile('Either.js', eitherSource);
    const consumerUri = pathToFileURL(consumerPath).href;
    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(tmpRoot, {});

    const chainRaw = ctx.getImportedRawSignature('./fl/chain', 'chain', consumerUri);
    expect(chainRaw).toBe('Chain m => (a -> m b) -> m a -> m b');

    const mapRaw = ctx.getImportedRawSignature('./fl/map', 'map', consumerUri);
    expect(mapRaw).toBe('Functor f => (a -> b) -> f a -> f b');
  });

  // Fase 2: hovering `const chain = …` at its declaration site in
  // chain.js must show the verbatim annotation rather than the inferred
  // narrower type.  Verified via the annotation lookup the hover branch
  // performs (`result.annotations.get('chain')`).
  test('chain.js declaration carries its verbatim annotation', () => {
    const chainPath = path.join(tmpRoot, 'fl/chain.js');
    const chainUri = pathToFileURL(chainPath).href;
    const chainSource = fs.readFileSync(chainPath, 'utf-8');

    resetTypeVarCounter();
    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    const globalsFilePath = path.join(tmpRoot, 'globals.hm');
    const globalsSource = wrapHmSource(fs.readFileSync(globalsFilePath, 'utf-8'));
    ctx.setProjectConfig(tmpRoot, { globalsSource, globalsFilePath });

    const eng = new InferenceEngine();
    eng.globalsSource = globalsSource;
    const r = eng.infer(
      chainSource,
      undefined,
      ctx.createImportResolver(chainUri),
      ctx.createTypeDirectiveResolver(chainUri),
      ctx.createImportTypeAliasResolver(chainUri),
    );

    const ann = r.annotations.get('chain');
    expect(ann).toBeDefined();
    expect(ann?.raw).toBe('Chain m => (a -> m b) -> m a -> m b');
    expect(ann?.receiver).toBeUndefined();
    expect(ann?.name).toBe('chain');
  });

  // Annotation-authoritative cross-file export: regardless of how the
  // body of `chain.js` infers (`chainable.chain(fn)` causes the kv-var
  // `m` to unify with consumer-side concrete types during body
  // inference), the *exported* scheme that other files see MUST be the
  // annotation scheme verbatim — preserving the `Chain m` constraint
  // and the polymorphic `m a -> m b` shape.
  test('exported scheme is annotation-authoritative (no body leakage)', () => {
    const chainPath = path.join(tmpRoot, 'fl/chain.js');
    const chainUri = pathToFileURL(chainPath).href;
    const chainSource = fs.readFileSync(chainPath, 'utf-8');

    resetTypeVarCounter();
    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    const globalsFilePath = path.join(tmpRoot, 'globals.hm');
    const globalsSource = wrapHmSource(fs.readFileSync(globalsFilePath, 'utf-8'));
    ctx.setProjectConfig(tmpRoot, { globalsSource, globalsFilePath });

    const eng = new InferenceEngine();
    eng.globalsSource = globalsSource;
    const result = eng.infer(
      chainSource,
      undefined,
      ctx.createImportResolver(chainUri),
      ctx.createTypeDirectiveResolver(chainUri),
      ctx.createImportTypeAliasResolver(chainUri),
    );
    const exported = result.exports.get('chain');
    expect(exported).toBeDefined();

    // The exported scheme must carry the `Chain m =>` constraint.
    expect(exported!.constraints).toBeDefined();
    expect(exported!.constraints!.length).toBeGreaterThan(0);
    expect(exported!.constraints!.some((c: { className: string }) => c.className === 'Chain')).toBe(true);

    // It must NOT have been concretised against any specific functor —
    // the pretty-printed type must not mention `Either`, `Maybe`, etc.,
    // nor any `$kv:` substitution marker that would only appear after
    // unifying with a consumer-side container.
    const pretty = prettyTypeToString(exported!.type as Type);
    expect(pretty).not.toMatch(/Either|Maybe|\$kv|\$error/);
  });

  // Mismatched body still produces the correct exported scheme: the
  // annotation says `a -> a` (identity), but the body returns a fixed
  // number.  Cross-file consumers must still see `a -> a`; the
  // mismatch surfaces inside the declaring file as a diagnostic — not
  // by mutating the exported signature.
  test('body that mismatches annotation does not corrupt export', () => {
    const idSource = [
      '"use strict";',
      '// badId :: a -> a',
      'const badId = (x) => 42;',
      'module.exports = badId;',
    ].join('\n');
    const idPath = writeFile('fl/badId.js', idSource);
    const idUri = pathToFileURL(idPath).href;

    resetTypeVarCounter();
    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(tmpRoot, {});

    const eng = new InferenceEngine();
    const result = eng.infer(
      idSource,
      undefined,
      ctx.createImportResolver(idUri),
      ctx.createTypeDirectiveResolver(idUri),
      ctx.createImportTypeAliasResolver(idUri),
    );
    const exported = result.exports.get('badId');
    expect(exported).toBeDefined();
    const pretty = prettyTypeToString(exported!.type as Type);
    // Exported type must remain the polymorphic identity `a -> a`,
    // not the body-inferred concrete `a -> Number`.
    expect(pretty).not.toMatch(/Number|number/);
  });
});

