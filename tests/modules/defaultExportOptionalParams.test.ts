// A function with JS default parameters (`(key, url, pollMs = 0) => …`) may be
// called with fewer arguments.  That must hold at the import site too, and for
// every export form: a named export, `export default <identifier>` and
// `export default function …`.  The default-export forms rebuilt the scheme of
// `default` and dropped the optional-parameter slots, so a default import of a
// data-loading hook asked for every argument ("Expected 4 arguments but got 3").

import * as fs from 'fs';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { ImportInferenceContext } from '../../src/services/importContext';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

const tmpRoot = '/tmp/hm-default-export-optional-params';

beforeEach(() => clearCustomMethods());

beforeAll(() => {
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  fs.mkdirSync(tmpRoot, { recursive: true });
});

function inferConsumer(helperSource: string, consumerSource: string): string[] {
  fs.writeFileSync(path.join(tmpRoot, 'useResource.js'), helperSource);
  const consumerPath = path.join(tmpRoot, 'screen.js');
  fs.writeFileSync(consumerPath, consumerSource);

  const fileUri = pathToFileURL(consumerPath).href;
  const docs = new TextDocuments<TextDocument>(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => {} });
  ctx.setProjectConfig(tmpRoot, {});
  const eng = new InferenceEngine();
  const result = eng.infer(
    consumerSource,
    undefined,
    ctx.createImportResolver(fileUri),
    ctx.createTypeDirectiveResolver(fileUri),
    ctx.createImportTypeAliasResolver(fileUri),
  );
  return result.diagnostics.filter(d => d.severity !== 3).map(d => d.message);
}

// A loader that fetches once, or polls when an interval is given.
const LOADER_BODY = `(key, url, params, pollMs = 0) => ({
  key,
  url: url + "?" + params.join("&"),
  polling: pollMs > 0
})`;

const LOADER_TYPE = '(String, String, [String], Number) -> { key :: String, url :: String, polling :: Boolean }';

const SCREEN = (importLine: string) => `${importLine}

// statusUrl :: () -> String
export const statusUrl = () => useResource ("status", "/status", []).url;

// jobsPolling :: () -> Boolean
export const jobsPolling = () => useResource ("jobs", "/jobs", ["limit=1"], 30000).polling;
`;

describe('JS default parameters survive a default export', () => {
  test('named export (control): the trailing default may be omitted', () => {
    const diags = inferConsumer(
      `// useResource :: ${LOADER_TYPE}\nexport const useResource = ${LOADER_BODY};\n`,
      SCREEN('import { useResource } from "./useResource";'),
    );
    expect(diags).toEqual([]);
  });

  test('export default <identifier>: the trailing default may be omitted', () => {
    const diags = inferConsumer(
      `// useResource :: ${LOADER_TYPE}\nconst useResource = ${LOADER_BODY};\n\nexport default useResource;\n`,
      SCREEN('import useResource from "./useResource";'),
    );
    expect(diags).toEqual([]);
  });

  test('export default <identifier> without an annotation', () => {
    const diags = inferConsumer(
      `const useResource = ${LOADER_BODY};\n\nexport default useResource;\n`,
      SCREEN('import useResource from "./useResource";'),
    );
    expect(diags).toEqual([]);
  });

  test('export default function declaration: the trailing default may be omitted', () => {
    const diags = inferConsumer(
      `// useResource :: ${LOADER_TYPE}
export default function useResource(key, url, params, pollMs = 0) {
  return { key, url: url + "?" + params.join("&"), polling: pollMs > 0 };
}
`,
      SCREEN('import useResource from "./useResource";'),
    );
    expect(diags).toEqual([]);
  });

  test('a parameter without a default is still required through a default import', () => {
    const diags = inferConsumer(
      `// useResource :: ${LOADER_TYPE}\nconst useResource = ${LOADER_BODY};\n\nexport default useResource;\n`,
      `import useResource from "./useResource";

// statusUrl :: () -> String
export const statusUrl = () => useResource ("status", "/status").url;
`,
    );
    expect(diags).toEqual(['Expected 4 arguments but got 2']);
  });

  test('the type of an omitted-default call is still checked', () => {
    const diags = inferConsumer(
      `// useResource :: ${LOADER_TYPE}\nconst useResource = ${LOADER_BODY};\n\nexport default useResource;\n`,
      `import useResource from "./useResource";

// statusUrl :: () -> Number
export const statusUrl = () => useResource ("status", "/status", []).url;
`,
    );
    expect(diags.length).toBeGreaterThan(0);
    expect(diags.join('\n')).toMatch(/String|Number/);
  });
});
