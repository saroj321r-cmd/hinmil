// Tests for the `.hm` declarations-only language services
// (validation, hover, go-to-definition, document symbols).

import * as fs from 'fs';
import * as path from 'path';
import {
  buildHmOffsetMap,
  parseHm,
  getHmDiagnostics,
  getHmHover,
  getHmDefinition,
  getHmDocumentSymbols,
  clearHmParseCache,
  HmServiceContext,
} from '../../src/services/hmFileServices';

const FIXTURE_PATH = path.join(__dirname, '..', 'fixtures', 'sqlkit.hm');
const FIXTURE_URI = 'file://' + FIXTURE_PATH;

const emptyCtx: HmServiceContext = {
  findTypeDefinitions: () => [],
  globals: null,
};

beforeEach(() => clearHmParseCache());

describe('buildHmOffsetMap', () => {
  test('round-trips offsets for non-comment and comment lines', () => {
    const src = [
      'foo :: Number -> Number',
      '// a real comment',
      '',
      'Bar :: a -> b',
    ].join('\n');
    const map = buildHmOffsetMap(src);
    // Wrapped non-comment lines gain `// ` prefix (3 chars).
    expect(map.wrapped.split('\n')[0]).toBe('// foo :: Number -> Number');
    expect(map.wrapped.split('\n')[1]).toBe('                 '); // blanked comment
    expect(map.wrapped.split('\n')[3]).toBe('// Bar :: a -> b');

    // Round-trip the start of `Bar`: original column 0 of line 3.
    const lineStartOrig = src.indexOf('Bar');
    const wrapped = map.toWrapped(lineStartOrig);
    expect(map.wrapped.slice(wrapped, wrapped + 3)).toBe('Bar');
    expect(map.toOriginal(wrapped)).toBe(lineStartOrig);
  });

  test('handles offsets at line starts of wrapped lines', () => {
    const src = 'foo :: Int';
    const map = buildHmOffsetMap(src);
    // Start of file maps to start of file in either direction.
    expect(map.toOriginal(0)).toBe(0);
    expect(map.toWrapped(0)).toBe(0);
    // wrapped offset 3 = 'f' of 'foo' → maps back to original column 0.
    expect(map.toOriginal(3)).toBe(0);
    // original offset 1 = 'o' of 'foo' → wrapped offset 4 (after `// `).
    expect(map.toWrapped(1)).toBe(4);
  });
});

describe('getHmDiagnostics', () => {
  test('clean source produces no diagnostics', () => {
    const src = 'foo :: Number -> Number\nBar :: a -> [a]\n';
    expect(getHmDiagnostics('file:///x.hm', src)).toEqual([]);
  });

  test('parse errors surface as diagnostics with mapped ranges', () => {
    const src = 'foo :: Number ->\nBar :: a\n';
    const diags = getHmDiagnostics('file:///x.hm', src);
    expect(diags.length).toBeGreaterThan(0);
    expect(diags[0].severity).toBe(1 /* Error */);
    // First diagnostic should reference line 0 (the foo declaration).
    expect(diags[0].range.start.line).toBe(0);
  });

  test('sqlkit.hm fixture has zero parse-error diagnostics', () => {
    const src = fs.readFileSync(FIXTURE_PATH, 'utf-8');
    const diags = getHmDiagnostics(FIXTURE_URI, src);
    expect(diags).toEqual([]);
  });

  test('flags arity mismatches against local constructor declarations', () => {
    const src = [
      'Pair :: (a, b) -> Pair a b',
      'foo :: Pair a -> Pair a',
      '',
    ].join('\n');
    const diags = getHmDiagnostics('file:///x.hm', src);
    const arity = diags.filter(d => /expects 2 type argument/.test(d.message));
    expect(arity.length).toBeGreaterThan(0);
    expect(arity[0].severity).toBe(1 /* Error */);
    // Range should land on the foo declaration (line 1), not Pair's own line.
    expect(arity[0].range.start.line).toBe(1);
  });

  test('flags bare zero-arg use of a constructor that requires type args', () => {
    const src = [
      'Prop :: (String, a) -> Prop b',
      'foo :: Prop -> Prop',
      '',
    ].join('\n');
    const diags = getHmDiagnostics('file:///x.hm', src);
    const arity = diags.filter(d => /'Prop'.*expects 1.*got 0/.test(d.message));
    expect(arity.length).toBeGreaterThan(0);
    expect(arity[0].range.start.line).toBe(1);
  });

  test('flags unknown type constructors that cannot be resolved cross-file', () => {
    const src = 'foo :: Property -> Property\n';
    const diags = getHmDiagnostics('file:///x.hm', src, emptyCtx);
    const unknown = diags.filter(d => /Unknown type constructor 'Property'/.test(d.message));
    expect(unknown.length).toBe(1);
    expect(unknown[0].severity).toBe(1);
  });

  test('cross-file fallback suppresses unknown-type diagnostics', () => {
    const src = 'foo :: Prop a -> Prop a\n';
    const ctx: HmServiceContext = {
      findTypeDefinitions: (n) => n === 'Prop'
        ? [{ raw: 'a -> Prop a', origin: 'globals', sourcePath: null, commentStart: 0, commentEnd: 0 }]
        : [],
      globals: null,
    };
    const diags = getHmDiagnostics('file:///x.hm', src, ctx);
    expect(diags).toEqual([]);
  });
});

describe('getHmDocumentSymbols', () => {
  test('lists every named annotation in sqlkit.hm', () => {
    const src = fs.readFileSync(FIXTURE_PATH, 'utf-8');
    const symbols = getHmDocumentSymbols(FIXTURE_URI, src);
    const names = symbols.map(s => s.name);
    expect(names).toEqual(expect.arrayContaining([
      'SqlKit', 'Tables', 'default',
      'Table#insert', 'Table#update', 'Table#delete',
      'QueryTag', 'SQLTag',
    ]));
  });

  test('preserves declaration order and assigns valid ranges', () => {
    const src = 'foo :: Int\nBar :: a -> b\n';
    const symbols = getHmDocumentSymbols('file:///x.hm', src);
    expect(symbols.map(s => s.name)).toEqual(['foo', 'Bar']);
    expect(symbols[0].range.start.line).toBe(0);
    expect(symbols[1].range.start.line).toBe(1);
  });
});

describe('getHmHover', () => {
  test('renders the user signature when hovering on the LHS name', () => {
    const src = 'foo :: Number -> Number\n';
    const offset = src.indexOf('foo') + 1;
    const hover = getHmHover('file:///x.hm', src, offset, emptyCtx);
    expect(hover).not.toBeNull();
    const md = (hover!.contents as any).value as string;
    expect(md).toContain('foo :: Number -> Number');
  });

  test('renders cross-file definitions for an uppercase name on the RHS', () => {
    const src = 'foo :: Bar -> Bar\n';
    const offset = src.indexOf('Bar');
    const ctx: HmServiceContext = {
      findTypeDefinitions: (n) => n === 'Bar'
        ? [{ raw: 'a -> a', origin: 'globals', sourcePath: null, commentStart: 0, commentEnd: 0 }]
        : [],
      globals: null,
    };
    const hover = getHmHover('file:///x.hm', src, offset, ctx);
    expect(hover).not.toBeNull();
    const md = (hover!.contents as any).value as string;
    expect(md).toContain('Bar :: a -> a');
    expect(md).toContain('globals');
  });
});

describe('getHmDefinition', () => {
  test('returns null on lowercase identifiers', () => {
    const src = 'foo :: Int\n';
    expect(getHmDefinition('file:///x.hm', src, src.indexOf('foo'), emptyCtx)).toBeNull();
  });

  test('returns Location for an uppercase RHS identifier', () => {
    const tmp = '/tmp/hm-definition-target.hm';
    fs.writeFileSync(tmp, 'Bar :: a -> a\n');
    const src = 'foo :: Bar -> Bar\n';
    const ctx: HmServiceContext = {
      findTypeDefinitions: (n) => n === 'Bar'
        ? [{ raw: 'a -> a', origin: 'globals', sourcePath: tmp, commentStart: 0, commentEnd: 13 }]
        : [],
      globals: null,
    };
    const loc = getHmDefinition('file:///x.hm', src, src.indexOf('Bar'), ctx);
    expect(loc).not.toBeNull();
    const single = Array.isArray(loc) ? loc[0] : loc!;
    expect(single.uri).toContain('hm-definition-target.hm');
  });
});
