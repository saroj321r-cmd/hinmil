// Fase B: hover should display the body of every constraint named in the
// rendered signature, plus a clickable link to the originating
// `// ::constraint` directive in the sidecar that defined it.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { buildConstraintHover, buildHover, extractConstraintNamesFromRaw } from '../../src/services/hover';
import { lookupConstraint } from '../../src/registries/constraintRegistry';const tmpRoot = '/tmp/hm-constraint-source-hover-test';

function writeFile(rel: string, content: string): string {
  const full = path.join(tmpRoot, rel);
  fs.mkdirSync(path.dirname(full), { recursive: true });
  fs.writeFileSync(full, content);
  return full;
}

function inferConsumer(consumerRel: string) {
  const consumerPath = path.join(tmpRoot, consumerRel);
  const fileUri = pathToFileURL(consumerPath).href;
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  ctx.setProjectConfig(tmpRoot, {});
  const resolver = ctx.createImportResolver(fileUri);
  const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
  const eng = new InferenceEngine();
  const source = fs.readFileSync(consumerPath, 'utf8');
  return eng.infer(source, undefined, resolver, undefined, aliasResolver);
}

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  writeFile('node_modules/sqlkit/package.json', JSON.stringify({
    name: 'sqlkit', main: 'index.js', 'hinmil': { sidecars: './sqlkit.hm' },
  }));
  writeFile('node_modules/sqlkit/index.js',
    'exports.NumberProp = (col, src) => ({ kind: "NumberProp", col, src });\n');
  writeFile('node_modules/sqlkit/sqlkit.hm', [
    "// Top comment line one",
    "// Source restricts the second arg of Prop factories.",
    "::constraint Source s { s :: String | SQLTag a b }",
    "NumberProp :: Source s => (String, s) -> Prop t Number",
    "",
  ].join('\n'));

  writeFile('use.js', [
    'const { NumberProp } = require("sqlkit");',
    'const p = NumberProp("id", "col");',
    '',
  ].join('\n'));
});

describe('Fase B — constraint definition surfaces in hover', () => {
  test('ConstraintDef carries source location after sidecar registration', () => {
    inferConsumer('use.js');
    const def = lookupConstraint('Source');
    expect(def).not.toBeNull();
    expect(def!.uri).toMatch(/sqlkit\.hm$/);
    expect(typeof def!.commentStart).toBe('number');
    expect(typeof def!.commentEnd).toBe('number');
    expect(def!.bodyText).toMatch(/String\s*\|\s*SQLTag/);
  });

  test('buildConstraintHover renders directive body and source link', () => {
    inferConsumer('use.js');
    const hov = buildConstraintHover('Source');
    expect(hov).not.toBeNull();
    const md = (hov!.contents as any).value as string;
    expect(md).toMatch(/::constraint Source s/);
    expect(md).toMatch(/String \| SQLTag a b/);
    expect(md).toMatch(/defined in \[sqlkit\.hm:\d+\]\(file:\/\/.*sqlkit\.hm#L\d+\)/);
  });

  test('Per-file ::constraint directive does not get a uri (no link in hover)', () => {
    const src = '// ::constraint Local v { v :: String | Number }\nconst x = 1;\n';
    new InferenceEngine().infer(src);
    const def = lookupConstraint('Local');
    expect(def).not.toBeNull();
    expect(def!.uri).toBeUndefined();
    expect(def!.bodyText).toMatch(/String\s*\|\s*Number/);
    const md = (buildConstraintHover('Local')!.contents as any).value as string;
    expect(md).toMatch(/::constraint Local v/);
    expect(md).not.toMatch(/defined in/);
  });

  test('extractConstraintNamesFromRaw parses single + grouped headers', () => {
    expect(extractConstraintNamesFromRaw('Source s => (String, s) -> Prop t Number'))
      .toEqual(['Source s']);
    expect(extractConstraintNamesFromRaw('(Source s, Monoid (f a)) => f a -> f a'))
      .toEqual(['Source s', 'Monoid (f a)']);
    expect(extractConstraintNamesFromRaw('a -> b'))
      .toEqual([]);
    // `=>` inside parens (record arrow) is not the constraint arrow.
    expect(extractConstraintNamesFromRaw('({ a => b }) -> c'))
      .toEqual([]);
  });

  test('hover on imported NumberProp call site appends Constraints section', () => {
    const consumerPath = path.join(tmpRoot, 'use.js');
    const consumerUri = pathToFileURL(consumerPath).href;
    const result = inferConsumer('use.js');
    const source = fs.readFileSync(consumerPath, 'utf8');
    const offset = source.indexOf('NumberProp(') + 1;

    // Mimic the server's bestType lookup: scan nodeTypes for the
    // narrowest node containing `offset`.
    let bestType: any = null;
    let rawBestType: any = null;
    let bestStart = -1;
    for (const [start, info] of result.nodeTypes) {
      const { type, end } = info as any;
      if (start <= offset && offset < end && start > bestStart) {
        bestType = result.substitution.apply(type);
        rawBestType = type;
        bestStart = start;
      }
    }

    const hov = buildHover({
      source, offset, result,
      bestType, rawBestType, bestStart,
      arrayShift: 0,
      inferredTypeStyle: 'pretty',
      uri: consumerUri,
      resolveImportSpecifier: (spec) => {
        if (spec === 'sqlkit') return pathToFileURL(path.join(tmpRoot, 'node_modules/sqlkit/index.js')).href;
        return null;
      },
      extractImportSpecifiers: (s: string) => {
        const map = new Map<string, string>();
        const re = /\{\s*([\w,\s]+)\s*\}\s*=\s*require\(["']([^"']+)["']\)/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(s)) !== null) {
          for (const name of m[1].split(',').map(n => n.trim()).filter(Boolean)) {
            map.set(name, m[2]);
          }
        }
        return map;
      },
      getImportedRawSignature: (_spec, name) => {
        const sidecar = path.join(tmpRoot, 'node_modules/sqlkit/sqlkit.hm');
        const text = fs.readFileSync(sidecar, 'utf8');
        const re = new RegExp(`^${name}\\s*::\\s*(.+)$`, 'm');
        const m = re.exec(text);
        return m ? m[1].trim() : null;
      },
    });
    expect(hov).not.toBeNull();
    const md = (hov!.contents as any).value as string;
    expect(md).toMatch(/Source s =>/);
    expect(md).toMatch(/\*\*Constraints\*\*/);
    expect(md).toMatch(/::constraint Source s/);
    expect(md).toMatch(/String \| SQLTag a b/);
    expect(md).toMatch(/defined in \[sqlkit\.hm:\d+\]/);
  });
});
