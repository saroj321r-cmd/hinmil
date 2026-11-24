// Benchmark harness for the refactor: measures inference time + memory over
// representative sample files. Run with: npm run bench
//
// Usage:
//   npm run bench            — full run (5 warmup + 20 measured iterations)
//   npm run bench -- --quick — quick run (1 warmup + 5 measured iterations)
//
// Output is deterministic in structure so runs can be diffed across phases.

import * as fs from 'fs';
import * as path from 'path';
import { InferenceEngine } from '../src/infer';
import { resetTypeVarCounter } from '../src/hm/types';
import { clearCustomMethods } from '../src/registries/methodRegistry';

const SAMPLE_DIR = path.join(__dirname, '..', 'sample');

// Representative files: mix of heavy (fantasyLand, sanctuary), medium and small.
const FILES = [
  'fantasyLand.js',
  'sanctuary.js',
  'monadTransformers.js',
  'ArraysAndObjects.js',
  'classes.js',
  'Either.js',
  'Maybe.js',
  'demo.js',
  'demo5.js',
  'demo9.js',
  'lens.js',
  'RTask.js',
];

const quick = process.argv.includes('--quick');
const WARMUP = quick ? 1 : 5;
const ITERATIONS = quick ? 5 : 20;

interface FileResult {
  file: string;
  lines: number;
  medianMs: number;
  meanMs: number;
  minMs: number;
  maxMs: number;
  diagnostics: number;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function inferOnce(source: string): number {
  clearCustomMethods();
  resetTypeVarCounter();
  const engine = new InferenceEngine();
  return engine.infer(source).diagnostics.length;
}

function benchFile(file: string): FileResult | null {
  const full = path.join(SAMPLE_DIR, file);
  if (!fs.existsSync(full)) {
    console.warn(`  (skipped, missing: ${file})`);
    return null;
  }
  const source = fs.readFileSync(full, 'utf8');
  const lines = source.split('\n').length;

  let diagnostics = 0;
  for (let i = 0; i < WARMUP; i++) diagnostics = inferOnce(source);

  const times: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = process.hrtime.bigint();
    inferOnce(source);
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }

  return {
    file,
    lines,
    medianMs: median(times),
    meanMs: times.reduce((a, b) => a + b, 0) / times.length,
    minMs: Math.min(...times),
    maxMs: Math.max(...times),
    diagnostics,
  };
}

function fmt(n: number): string {
  return n.toFixed(2).padStart(9);
}

function main(): void {
  console.log(`hinmil inference benchmark (${WARMUP} warmup, ${ITERATIONS} iterations per file)\n`);
  console.log('file'.padEnd(28) + 'lines'.padStart(6) + 'median ms'.padStart(10) + 'mean ms'.padStart(10) + 'min ms'.padStart(10) + 'max ms'.padStart(10) + 'diags'.padStart(7));
  console.log('-'.repeat(81));

  const results: FileResult[] = [];
  for (const file of FILES) {
    const r = benchFile(file);
    if (!r) continue;
    results.push(r);
    console.log(
      r.file.padEnd(28) +
        String(r.lines).padStart(6) +
        fmt(r.medianMs).padStart(10) +
        fmt(r.meanMs).padStart(10) +
        fmt(r.minMs).padStart(10) +
        fmt(r.maxMs).padStart(10) +
        String(r.diagnostics).padStart(7)
    );
  }

  const totalMedian = results.reduce((a, r) => a + r.medianMs, 0);
  const totalLines = results.reduce((a, r) => a + r.lines, 0);
  console.log('-'.repeat(81));
  console.log('TOTAL'.padEnd(28) + String(totalLines).padStart(6) + fmt(totalMedian).padStart(10));

  benchSidecarScenario();

  if (global.gc) global.gc();
  const mem = process.memoryUsage();
  console.log(`\nheapUsed: ${(mem.heapUsed / 1024 / 1024).toFixed(1)} MB   rss: ${(mem.rss / 1024 / 1024).toFixed(1)} MB`);
}

// ---------------------------------------------------------------------------
// Sidecar-heavy scenario: a synthetic npm package shipping a large
// auto-generated `.hm` sidecar (à la a query-builder's introspect output —
// ~TABLE_COUNT tables with Row/Selector/Tag declarations, per-table
// overloads, `::extend` directives and a giant `Tables` record), consumed
// by a project file through a shared ImportInferenceContext, exactly like
// the LSP does.  Measures the end-to-end consumer inference time plus the
// sidecar pipeline stage breakdown from `sidecarPerf`.
// ---------------------------------------------------------------------------

const TABLE_COUNT = 50;
const COLS_PER_TABLE = 12;

function genColumns(t: number): Array<[string, string]> {
  const base: Array<[string, string]> = [
    ['id', 'Number'], ['name', 'String'], ['active', 'Boolean'],
    ['createdAt', 'Date'], ['updatedAt', 'Date'],
  ];
  for (let c = base.length; c < COLS_PER_TABLE; c++) {
    base.push([`field${t}_${c}`, c % 2 === 0 ? 'String' : 'Number']);
  }
  return base;
}

function genBaseSidecar(): string {
  return `
// Base sidecar for the synthetic "dbkit" package (mirrors a query-builder
// library's hand-written sidecar).
Tables :: a
tables :: Tables

::constraint Runnable t r { r :: (a -> t) | t }
::constraint Source s { s :: String | SQLTag a b }

Table :: [a] -> QueryTag p o
Table#insert   :: Table p ~> [a] -> QueryTag q b
Table#update   :: Table p ~> [a] -> QueryTag q b
Table#delete   :: Table p ~> [a] -> QueryTag q b
Table#props    :: Table a ~> b

QueryTag :: (a, b) -> QueryTag a b
QueryTag() :: p -> Promise [o]
QueryTag#concat :: QueryTag p1 r1 ~> QueryTag p2 r2 -> QueryTag (Merge p1 p2) (Merge r1 r2)
QueryTag#run    :: QueryTag p o ~> (p, a) -> Promise [o]

SQLTag :: (a, b) -> SQLTag a b
SQLTag() :: p -> Promise [o]
SQLTag#concat :: SQLTag p1 r1 ~> SQLTag p2 r2 -> SQLTag (Merge p1 p2) (Merge r1 r2)

sql :: a

Limit :: Runnable Number r => r -> Limit r
Offset :: Runnable Number r => r -> Offset r

GenericSelector :: (Prop tag a | Limit l | Offset o | SQLTag p o)

Prop :: Source s => (String, s) -> Prop t a
Prop#eq    :: Runnable a r      => Prop t a ~> r -> Prop t a
Prop#iLike :: Runnable String r => Prop t a ~> r -> Prop t a
Prop#in    :: Runnable [a] r    => Prop t a ~> r -> Prop t a
Prop#gt    :: Runnable a r      => Prop t a ~> r -> Prop t a
Prop#asc   :: Prop t a ~> () -> Prop t a
Prop#desc  :: Prop t a ~> () -> Prop t a
Prop#or    :: Prop t a ~> Prop t b -> Prop t a
Prop#and   :: Prop t a ~> Prop t b -> Prop t a
`;
}

function genIntrospectSidecar(): string {
  const parts: string[] = [
    '// AUTO-GENERATED introspect sidecar (synthetic benchmark fixture).',
    '::types dbkit',
    '',
  ];
  // Giant Tables record.
  const tableEntries: string[] = [];
  for (let t = 0; t < TABLE_COUNT; t++) {
    const cols = genColumns(t);
    const props = cols.map(([n, ty]) => `  ${n} :: Prop T${t}Tag ${ty}`).join(',\n');
    tableEntries.push(
      `    T${t} :: ({ props :: {\n${props}\n} } | Table T${t}Row | ([T${t}Selector] -> QueryTag p (Picked T${t}Row T${t}Selector)))`,
    );
  }
  parts.push(`Tables :: {\n  main :: {\n${tableEntries.join(',\n')}\n  }\n}`);
  parts.push('');
  // Per-table declarations.
  for (let t = 0; t < TABLE_COUNT; t++) {
    const cols = genColumns(t);
    parts.push(`T${t}Tag :: () -> T${t}Tag`);
    parts.push(`T${t}Row :: {\n${cols.map(([n, ty]) => `  ${n} :: ${ty}`).join(',\n')}\n}`);
    parts.push(`T${t}Selector :: GenericSelector T${t}Tag`);
    parts.push(`::extend T${t}Selector ${cols.map(([n]) => `'${n}'`).join(' | ')}`);
    parts.push(`T${t} :: Table T${t}Row`);
    parts.push(`T${t} :: [T${t}Selector] -> QueryTag p (Picked T${t}Row T${t}Selector)`);
    parts.push(`T${t}#insert :: T${t} ~> [T${t}Selector] -> QueryTag p T${t}Row`);
    parts.push(`T${t}#update :: T${t} ~> [T${t}Selector] -> QueryTag p T${t}Row`);
    parts.push(`T${t}#props :: T${t} ~> {\n${cols.map(([n, ty]) => `  ${n} :: Prop T${t}Tag ${ty}`).join(',\n')}\n}`);
    parts.push('');
  }
  return parts.join('\n');
}

function genConsumer(): string {
  return `
import { tables, Limit, Offset } from "dbkit";

const { T1, T2, T3 } = tables.main;

const { id, name, active } = T1.props;

export const readBasic = T1([
  "id",
  "name",
  "active",
  "createdAt",
]);

export const search = T1([
  name.iLike(p => \`%\${p.q}%\`),
]);

export const readPage = readBasic.concat(T1([
  id.desc(),
  Limit(p => p.limit),
  Offset(p => p.limit * p.page),
]));

export const byId = T1([
  id.eq(p => p.id),
]);

export const other = T2(["id", "name"]);
export const third = T3(["id"]);
`;
}

function benchSidecarScenario(): void {
  /* eslint-disable @typescript-eslint/no-var-requires */
  const os = require('os') as typeof import('os');
  const { pathToFileURL } = require('url') as typeof import('url');
  const { TextDocuments } = require('vscode-languageserver/node') as typeof import('vscode-languageserver/node');
  const { TextDocument } = require('vscode-languageserver-textdocument') as typeof import('vscode-languageserver-textdocument');
  const { ImportInferenceContext } = require('../src/services/importContext') as typeof import('../src/services/importContext');
  const { resetSidecarPerf, getSidecarPerf } = require('../src/services/sidecarPerf') as typeof import('../src/services/sidecarPerf');
  /* eslint-enable @typescript-eslint/no-var-requires */

  const root = path.join(os.tmpdir(), 'hm-bench-sidecar');
  fs.rmSync(root, { recursive: true, force: true });
  const write = (rel: string, content: string): void => {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  };

  write('package.json', JSON.stringify({ name: 'bench-consumer', 'hinmil': {} }));
  write('node_modules/dbkit/package.json', JSON.stringify({
    name: 'dbkit',
    main: 'index.js',
    'hinmil': { sidecars: ['./dbkit.hm', '../.dbkit/client/index.hm'] },
  }));
  write('node_modules/dbkit/index.js', 'module.exports = { tables: {}, Limit: () => {}, Offset: () => {}, sql: () => {} };');
  write('node_modules/dbkit/dbkit.hm', genBaseSidecar());
  write('node_modules/.dbkit/client/index.hm', genIntrospectSidecar());
  const consumerSource = genConsumer();
  write('src/consumer.js', consumerSource);

  const sidecarLines = genIntrospectSidecar().split('\n').length;
  console.log(`\nsidecar scenario (${TABLE_COUNT} tables, generated sidecar ${sidecarLines} lines)`);

  // Shared context across iterations — mirrors the long-lived LSP process.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const docs: any = new TextDocuments(TextDocument as never);
  const ctx = new ImportInferenceContext(docs, { warn: () => { /* noop */ } });
  ctx.setProjectConfig(root, {});
  const fileUri = pathToFileURL(path.join(root, 'src/consumer.js')).href;

  const inferConsumer = (): number => {
    clearCustomMethods();
    resetTypeVarCounter();
    const engine = new InferenceEngine();
    const r = engine.infer(
      consumerSource,
      undefined,
      ctx.createImportResolver(fileUri),
      ctx.createTypeDirectiveResolver(fileUri),
      ctx.createImportTypeAliasResolver(fileUri),
    );
    return r.diagnostics.length;
  };

  let diags = 0;
  for (let i = 0; i < WARMUP; i++) diags = inferConsumer();

  resetSidecarPerf();
  const times: number[] = [];
  for (let i = 0; i < ITERATIONS; i++) {
    const t0 = process.hrtime.bigint();
    inferConsumer();
    const t1 = process.hrtime.bigint();
    times.push(Number(t1 - t0) / 1e6);
  }
  const perf = getSidecarPerf();

  console.log(
    'consumer.js'.padEnd(28) +
      String(consumerSource.split('\n').length).padStart(6) +
      fmt(median(times)).padStart(10) +
      fmt(times.reduce((a, b) => a + b, 0) / times.length).padStart(10) +
      fmt(Math.min(...times)).padStart(10) +
      fmt(Math.max(...times)).padStart(10) +
      String(diags).padStart(7)
  );
  const per = (ms: number, n: number): string => `${(ms / ITERATIONS).toFixed(2)}ms/iter (${n} calls)`;
  console.log(`  sidecar parse:    ${per(perf.parseMs, perf.parseCount)}`);
  console.log(`  alias extraction: ${per(perf.aliasMs, perf.aliasCount)}`);
  console.log(`  registration:     ${per(perf.registerMs, perf.registerCount)}`);
  console.log(`  directive I/O:    ${per(perf.directiveMs, perf.directiveCount)}`);

  fs.rmSync(root, { recursive: true, force: true });
}

main();
