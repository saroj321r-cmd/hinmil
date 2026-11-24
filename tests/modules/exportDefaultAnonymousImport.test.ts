// An anonymous `export default function () {}` / `export default class {}` has
// no name of its own, but must still be bound as the module's `default` export
// so that a default import (`import name from './file'`) can pick it up and give
// it a name at the import site. Regression for the "does export default function
// syntax work?" investigation.

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

const tmpRoot = '/tmp/hm-export-default-anon';

beforeEach(() => clearCustomMethods());

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

function inferConsumer(helperSource: string, consumerSource: string) {
  fs.writeFileSync(path.join(tmpRoot, 'helper.js'), helperSource);
  const consumerPath = path.join(tmpRoot, 'consumer.js');
  fs.writeFileSync(consumerPath, consumerSource);

  const fileUri = pathToFileURL(consumerPath).href;
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  ctx.setProjectConfig(tmpRoot, {});
  const importResolver = ctx.createImportResolver(fileUri);
  const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
  const typeDirResolver = ctx.createTypeDirectiveResolver(fileUri);

  const eng = new InferenceEngine();
  return eng.infer(consumerSource, undefined, importResolver, typeDirResolver, aliasResolver);
}

describe('anonymous export default flows to the default import', () => {
  test('anonymous `export default function () {}` is importable by name', () => {
    const result = inferConsumer(
      'export default function () { return 1; }\n',
      ['import helper from "./helper";', 'const y = helper;', ''].join('\n'),
    );
    // `helper` must be bound — no unbound-variable diagnostic.
    expect(result.diagnostics.some(d => /Unbound variable: 'helper'/.test(d.message))).toBe(false);
  });

  test('anonymous `export default class {}` is importable by name', () => {
    const result = inferConsumer(
      'export default class { foo() { return 1; } }\n',
      ['import Widget from "./helper";', 'const w = Widget;', ''].join('\n'),
    );
    expect(result.diagnostics.some(d => /Unbound variable: 'Widget'/.test(d.message))).toBe(false);
  });

  test('named `export default function foo () {}` still importable by name', () => {
    const result = inferConsumer(
      'export default function foo () { return 1; }\n',
      ['import helper from "./helper";', 'const y = helper;', ''].join('\n'),
    );
    expect(result.diagnostics.some(d => /Unbound variable: 'helper'/.test(d.message))).toBe(false);
  });

  test('anonymous `export default x => x` still importable by name', () => {
    const result = inferConsumer(
      'export default x => x;\n',
      ['import id from "./helper";', 'const y = id;', ''].join('\n'),
    );
    expect(result.diagnostics.some(d => /Unbound variable: 'id'/.test(d.message))).toBe(false);
  });
});
