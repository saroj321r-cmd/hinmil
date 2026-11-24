// Tokenizes JS through the real TextMate engine (vscode-textmate +
// vscode-oniguruma, the same engine VS Code uses) with the HM injection
// grammar, and checks which comment text gets HM type scopes.
//
// The grammar must agree with what `commentParser.ts` accepts as an
// annotation: prose comments that merely MENTION a type (`RTask :: Any`) or
// contain an arrow must stay plain comments.  Cases are taken from real code:
// the app's `server/src/lib/rtask.js` notes and fpkit's annotations.

import * as fs from 'fs';
import * as path from 'path';
import * as vsctm from 'vscode-textmate';
import * as oniguruma from 'vscode-oniguruma';

const GRAMMAR = path.join(__dirname, '../../syntaxes/hm-injection.full.tmLanguage.json');
const ACTIVE_GRAMMAR = path.join(__dirname, '../../syntaxes/hm-injection.tmLanguage.json');

// Minimal host grammar: just enough of `source.js` for the injection
// selector (`L:source.js -string -comment`) to apply as it does in VS Code.
const HOST_JS = {
  scopeName: 'source.js',
  patterns: [
    { name: 'comment.line.double-slash.js', match: '//.*$' },
    { name: 'comment.block.js', begin: '/\\*', end: '\\*/' },
    { name: 'string.quoted.double.js', match: '"(?:[^"\\\\]|\\\\.)*"' },
  ],
};

let registry: vsctm.Registry;

beforeAll(async () => {
  const wasm = fs.readFileSync(require.resolve('vscode-oniguruma/release/onig.wasm')).buffer;
  await oniguruma.loadWASM(wasm);
  registry = new vsctm.Registry({
    onigLib: Promise.resolve({
      createOnigScanner: (sources: string[]) => new oniguruma.OnigScanner(sources),
      createOnigString: (s: string) => new oniguruma.OnigString(s),
    }),
    loadGrammar: async (scopeName: string) => {
      if (scopeName === 'source.js') return vsctm.parseRawGrammar(JSON.stringify(HOST_JS), 'host.json');
      if (scopeName === 'hm-injection.js') return vsctm.parseRawGrammar(fs.readFileSync(GRAMMAR, 'utf-8'), GRAMMAR);
      return null;
    },
    getInjections: (scopeName: string) => (scopeName === 'source.js' ? ['hm-injection.js'] : undefined),
  });
});

/** Per source line: the text covered by any `.hm` scope, joined. */
async function hmText(lines: string[]): Promise<string[]> {
  const grammar = await registry.loadGrammar('source.js');
  if (!grammar) throw new Error('grammar failed to load');
  let state = vsctm.INITIAL;
  const out: string[] = [];
  for (const line of lines) {
    const r = grammar.tokenizeLine(line, state);
    // Span from the first to the last HM-scoped token (keeps inner spaces).
    const hmTokens = r.tokens.filter(t => t.scopes.some(s => s.endsWith('.hm')));
    out.push(hmTokens.length === 0
      ? ''
      : line.slice(hmTokens[0].startIndex, hmTokens[hmTokens.length - 1].endIndex).trim());
    state = r.ruleStack;
  }
  return out;
}

test('active grammar file is in sync with the full grammar', () => {
  expect(fs.readFileSync(ACTIVE_GRAMMAR, 'utf-8')).toBe(fs.readFileSync(GRAMMAR, 'utf-8'));
});

describe('// line comments', () => {
  test('prose mentioning a type is not highlighted (app rtask.js note)', async () => {
    const hm = await hmText([
      '// import {RTask} from "fpkit" resulteert in RTask :: Any',
      '// Deep import: map -> chain -> fork is de volgorde',
      'import RTask from "fpkit/RTask";',
    ]);
    expect(hm).toEqual(['', '', '']);
  });

  test('a named annotation is highlighted', async () => {
    const hm = await hmText(['// fromPromiseFn :: (a -> Promise e b) -> a -> RTask r e b']);
    expect(hm[0]).toContain('fromPromiseFn');
    expect(hm[0]).toContain('RTask r e b');
  });

  test('continuation lines directly after an annotation are highlighted (fpkit Bichain style)', async () => {
    const hm = await hmText([
      '// bichain :: Bichain m',
      '//   => (a -> m c d) -> (b -> m c d)',
      '//   -> m a b -> m c d',
      'const bichain = f => g => m => m;',
    ]);
    expect(hm[1]).toContain('(a -> m c d)');
    expect(hm[2]).toContain('m a b -> m c d');
  });

  test('a multi-line record annotation keeps its continuation', async () => {
    const hm = await hmText([
      '// tables :: { members :: Table Member,',
      '//   departments :: Table Department }',
      'const tables = {};',
    ]);
    expect(hm[1]).toContain('Table Department');
  });

  test('prose after an annotation ends the highlighting', async () => {
    const hm = await hmText([
      '// withEnv :: (r -> Promise e a) -> RTask r e a',
      '// Runs the promise function with the RTask environment.',
      'export const withEnv = fn => fn;',
    ]);
    expect(hm[0]).toContain('withEnv');
    expect(hm[1]).toBe('');
  });

  test('an arrow in prose that is not preceded by an annotation stays plain', async () => {
    const hm = await hmText([
      '// Lazy: de promise-functie draait pas bij fork',
      '// promise -> RTask conversie gebeurt in de adapter',
    ]);
    expect(hm).toEqual(['', '']);
  });
});

describe('/* block comments */', () => {
  test('quoted types inside a prose paragraph are not highlighted (app rtask.js notes)', async () => {
    const hm = await hmText([
      '/*',
      '  vraag 2:',
      '    - import {RTask} from "fpkit" resulteert in RTask :: Any. je hebt een sidecar gemaakt',
      '      namelijk:',
      '        RTask :: {',
      '          of :: a -> RTask r e a,',
      '        } al de numerieke ophoging is overbodig,',
      '',
      '    - wanneer ik de volgende lijn in comment zet',
      '*/',
      'export const fromPromiseFn = f => f;',
    ]);
    expect(hm).toEqual(Array(11).fill(''));
  });

  test('JSDoc annotation paragraph after a description is highlighted (fpkit fl/traverse.js)', async () => {
    const hm = await hmText([
      '/**',
      ' * For more info:',
      ' * https://github.com/sanctuary-js/sanctuary-type-classes/pull/19',
      ' *',
      ' * Array#traverse :: Applicative f',
      ' *                   => Array a ~> TypeRep f -> (a -> f b) -> f (Array b)',
      ' */',
    ]);
    expect(hm[1]).toBe('');
    expect(hm[2]).toBe('');
    expect(hm[4]).toContain('Array#traverse');
    expect(hm[5]).toContain('TypeRep f');
  });

  test('prose paragraph after the annotation paragraph is not highlighted', async () => {
    const hm = await hmText([
      '/**',
      ' * withEnv :: (r -> Promise e a) -> RTask r e a',
      ' *',
      ' * Runs the promise function -> with the environment.',
      ' */',
    ]);
    expect(hm[1]).toContain('withEnv');
    expect(hm[3]).toBe('');
  });

  test('single-line block annotation still works', async () => {
    const hm = await hmText(['/* add :: Number -> Number -> Number */']);
    expect(hm[0]).toContain('add');
    expect(hm[0]).toContain('Number -> Number -> Number');
  });
});
