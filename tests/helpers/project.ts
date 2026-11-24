// Shared temp-project helper for cross-module tests (imports, sidecars,
// type directives).  Replaces the per-file `writeFile` + resolver plumbing
// that used to be duplicated across import/sidecar test files.
//
// Usage:
//   const project = new TempProject('my-feature');
//   beforeAll(() => project.setup());
//   afterAll(() => project.cleanup());
//
//   project.write('lib.js', '...');
//   const r = project.inferFile('consumer.js');   // file previously written
//   const r2 = project.inferSource('consumer.js', 'import ...');

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { pathToFileURL } from 'url';
import { TextDocuments } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { InferenceEngine } from '../../src/infer';
import { InferenceResult } from '../../src/infer/types';
import { ImportInferenceContext } from '../../src/services/importContext';
import { resetTypeVarCounter } from '../../src/hm/types';
import { clearCustomMethods } from '../../src/registries/methodRegistry';

export class TempProject {
  readonly root: string;

  constructor(name: string, public projectConfig: Record<string, unknown> = {}) {
    this.root = path.join(os.tmpdir(), `hm-test-${name}`);
  }

  /** Remove any stale directory and create a fresh root (call in beforeAll). */
  setup(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
    fs.mkdirSync(this.root, { recursive: true });
  }

  /** Delete the project directory (call in afterAll). */
  cleanup(): void {
    fs.rmSync(this.root, { recursive: true, force: true });
  }

  /** Write a file relative to the project root; parent dirs are created. */
  write(rel: string, content: string): string {
    const full = path.join(this.root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
    return full;
  }

  /** Absolute path of a file inside the project. */
  pathOf(rel: string): string {
    return path.join(this.root, rel);
  }

  /** Fresh ImportInferenceContext rooted at this project. */
  createContext(): ImportInferenceContext {
    const docs = new TextDocuments<TextDocument>(TextDocument as never);
    const ctx = new ImportInferenceContext(docs, { warn: () => {} });
    ctx.setProjectConfig(this.root, this.projectConfig);
    return ctx;
  }

  /**
   * Infer `source` as if it were the contents of the file at `rel`
   * (imports resolve relative to that path).  `configureEngine` may tweak
   * the engine before inference (e.g. set `globalsSource`).
   */
  inferSource(
    rel: string,
    source: string,
    configureEngine?: (engine: InferenceEngine) => void,
  ): InferenceResult {
    const fileUri = pathToFileURL(this.pathOf(rel)).href;
    const ctx = this.createContext();
    const importResolver = ctx.createImportResolver(fileUri);
    const typeResolver = ctx.createTypeDirectiveResolver(fileUri);
    const aliasResolver = ctx.createImportTypeAliasResolver(fileUri);
    clearCustomMethods();
    resetTypeVarCounter();
    const engine = new InferenceEngine();
    configureEngine?.(engine);
    return engine.infer(source, undefined, importResolver, typeResolver, aliasResolver);
  }

  /** Infer a previously written file by relative path. */
  inferFile(rel: string): InferenceResult {
    const source = fs.readFileSync(this.pathOf(rel), 'utf8');
    return this.inferSource(rel, source);
  }
}
