// Go to definition for code (services/definitions): module paths, imported
// names and local names, across ESM, CommonJS, dynamic import and Babel
// output.  The project is a shortened copy of the app's server (routes →
// services → repositories), with an fpkit-like CommonJS package, a sqlkit-like
// package with an `.hm` sidecar, and `.mjs` / `.cjs` / Babel-compiled files.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { pathToFileURL } from 'url';
import { findCodeDefinition } from '../../src/services/definitions';

let root: string;

const files: Record<string, string> = {
  // ── app server (ESM, extensionless imports, re-exports) ───────────────
  'server/src/api/routes/departments.js': `// Departments: aanmaken en opvragen.
import get from "fpkit/express/get";
import post from "fpkit/express/post";
import { createDepartment, getDepartment } from "../../services/departments";
import { byId, created, handle } from "../http";
import * as http from "../http";

// routes :: [Component]
export default [
  post ("/departments") (handle (created (createDepartment))),
  get ("/departments/:id") (handle (byId ("department") (getDepartment))),
  get ("/departments/:id/raw") (http.handle (http.byId ("department") (getDepartment)))
];
`,
  'server/src/services/departments.js': `// Departments: aanmaken (gevalideerd) en opvragen.
import pipe from "fpkit/combinator/pipe";
import { getDepartment, insertDepartment } from "../db/repositories/departments";
import { validateDepartment } from "../domain/department";

// toDepartmentInput :: Object String Any -> { name :: String, countryId :: Null }
const toDepartmentInput = v => ({ name: v.name, countryId: null });

export const createDepartment = pipe (validateDepartment, toDepartmentInput, insertDepartment);

export { getDepartment };
`,
  'server/src/db/repositories/departments.js': `import { tables } from "../index";
import Repo from "../Repo";

const { Departments } = tables.core;

const departments = Repo (Departments);

export const getDepartment = departments.readById;

export const insertDepartment = departments.insert;
`,
  'server/src/db/index.js': `import { mkDb } from "./sqlkit";
export const { tables, sql, pool } = mkDb ();
`,
  'server/src/db/sqlkit.js': `import SqlKit from "sqlkit";
export const mkDb = () => SqlKit ({});
`,
  'server/src/db/Repo.js': `// Repo :: Table r -> RepoApi r
const Repo = model => ({ readById: id => model (id), insert: data => model (data) });

export default Repo;
`,
  'server/src/domain/department.js': `export const validateDepartment = body => body;
`,
  'server/src/api/http.js': `import pipe from "fpkit/combinator/pipe";
import { toResponse } from "./respond";

// handle :: (RequestObj -> RTask r Error (Response Any)) -> RequestObj -> RTask r (Response Any) (Response Any)
export const handle = handler => pipe (handler, toResponse);

export function byId (what) { return lookup => lookup; }

const respondWith = response => _req => response;
export { respondWith as created };
`,
  'server/src/api/respond.js': `export const toResponse = err => err;
`,
  'server/src/api/index.js': `export * from "./http";
export * as respond from "./respond";
`,
  'server/src/jobs/registry.js': `// CommonJS-consument met require en dynamische import.
const { importEvents } = require ("../services/eventImport");
const respond = require ("../api/respond");
const toResponse = require ("../api/respond").toResponse;
const api = require ("../api");

const load = async () => {
  const policy = await import ("./policy.mjs");
  return policy.backoffMs;
};

const jobs = { "events.import": importEvents };
module.exports = { jobs, load, respond, toResponse, api };
`,
  'server/src/services/eventImport.js': `export const importEvents = payload => payload;
`,
  'server/src/jobs/policy.mjs': `// backoffMs :: QueueConfig -> Number -> Number
export default function backoffMs (config) { return attempt => config.base * attempt; }
export const nextStatus = attempts => attempts < 3 ? "retrying" : "failed";
`,
  'server/src/jobs/legacy.cjs': `exports.stableStringify = value => JSON.stringify (value);
module.exports.idempotencyKey = name => name;
`,
  'server/src/jobs/useLegacy.js': `import { stableStringify, idempotencyKey } from "./legacy.cjs";
import backoffMs, { nextStatus } from "./policy.mjs";
import compiled from "./compiled";
import { helper } from "./compiled";

export const keys = [stableStringify, idempotencyKey, backoffMs, nextStatus, compiled, helper];

const shadow = stableStringify => stableStringify;
`,
  // Babel-compiled module (what \`babel src -d dist\` writes).
  'server/src/jobs/compiled.js': `"use strict";

Object.defineProperty (exports, "__esModule", { value: true });
exports.default = void 0;
Object.defineProperty (exports, "helper", { enumerable: true, get: function () { return _helper.helper; } });
var _helper = require ("./helper");
const run = () => "run";
var _default = run;
exports.default = _default;
`,
  'server/src/jobs/helper.js': `export const helper = () => "helper";
`,
  // ── fpkit-like package (CommonJS, buble output) ────────────────────────────
  'server/node_modules/fpkit/package.json': `{ "name": "fpkit", "version": "1.0.6", "main": "index.js" }`,
  'server/node_modules/fpkit/index.js': `module.exports = { pipe: require ("./combinator/pipe"), RTask: require ("./RTask") };
`,
  'server/node_modules/fpkit/combinator/pipe.js': `"use strict";

// pipe :: ((a -> b), ..., (y -> z)) -> a -> z
const pipe = (...fns) => x => fns.reduce ((acc, f) => f (acc), x);

module.exports = pipe;
`,
  'server/node_modules/fpkit/express/get.js': `"use strict";

const Component = require ("./Component");

// get :: String -> RouteFn -> Component
const get = Component.Route ("get");

module.exports = get;
`,
  'server/node_modules/fpkit/express/post.js': `"use strict";
module.exports = require ("./Component").Route ("post");
`,
  'server/node_modules/fpkit/express/Component.js': `"use strict";

function Component () { throw TypeError ("You can't evaluate Component."); }

// _Route :: String -> String | RegExp -> RouteFn -> Component
function _Route (method) { return path => handler => ({ method, path, handler }); }

Component.Route = _Route;

module.exports = Component;
`,
  'server/node_modules/fpkit/RTask/index.js': `"use strict";
function RTask (run) { this.run = run; }
module.exports = RTask;
`,
  'server/node_modules/fpkit/Result/parseReq.js': `"use strict";
const parseReqWith = onInvalid => params => req => req;
const parseReq = parseReqWith (null);
parseReq.parseReqWith = parseReqWith;
module.exports = parseReq;
`,
  // ── sqlkit-like package with an .hm sidecar and an exports field ──────────
  'server/node_modules/sqlkit/package.json': `{ "name": "sqlkit", "main": "./build/index.js", "exports": { ".": { "require": "./build/index.js" }, "./Prop": "./build/Prop.js" }, "hinmil": { "sidecars": ["./sqlkit.hm"] } }`,
  'server/node_modules/sqlkit/sqlkit.hm': `SqlKit :: Object String Any -> Tables
`,
  'server/node_modules/sqlkit/build/index.js': `"use strict";
Object.defineProperty (exports, "__esModule", { value: true });
function SqlKit (options) { return options; }
exports.default = SqlKit;
`,
  'server/node_modules/sqlkit/build/Prop.js': `"use strict";
exports.NumberProp = (as, col) => ({ as, col });
`,
  'server/src/db/props.js': `import { NumberProp } from "sqlkit/Prop";
export const idProp = NumberProp ("id", "id");
const parseReq = require ("fpkit/Result/parseReq");
const { parseReqWith } = require ("fpkit/Result/parseReq");
const RTask = require ("fpkit/RTask");
const { pipe } = require ("fpkit");
module.exports = { parseReq, parseReqWith, RTask, pipe, viaMember: parseReq.parseReqWith };
`,
};

beforeAll(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-definitions-'));
  for (const [rel, text] of Object.entries(files)) {
    const full = path.join(root, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, text);
  }
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

interface Landing {
  file: string;
  /** The text of the target span (empty for "top of file"). */
  text: string;
  /** The line the target starts on (trimmed). */
  line: string;
}

/** Go to definition on the `nth` occurrence of `needle` in `file`; the cursor
 *  sits `at` characters into the needle (default: its first character). */
function definitionAt(file: string, needle: string, opts: { nth?: number; at?: number; includeLocal?: boolean } = {}): Landing[] | null {
  const full = path.join(root, file);
  const source = fs.readFileSync(full, 'utf-8');
  let index = -1;
  for (let i = 0; i <= (opts.nth ?? 0); i++) {
    index = source.indexOf(needle, index + 1);
    if (index < 0) throw new Error(`'${needle}' (#${opts.nth ?? 0}) not found in ${file}`);
  }
  const offset = index + (opts.at ?? 0);
  const definition = findCodeDefinition(source, pathToFileURL(full).href, offset, { includeLocal: opts.includeLocal ?? true });
  if (!definition) return null;
  return definition.targets.map(t => {
    const text = fs.readFileSync(t.path, 'utf-8');
    const lineStart = text.lastIndexOf('\n', t.start - 1) + 1;
    const lineEnd = text.indexOf('\n', t.start);
    return {
      file: path.relative(root, t.path),
      text: text.slice(t.start, t.end),
      line: text.slice(lineStart, lineEnd < 0 ? text.length : lineEnd).trim(),
    };
  });
}

describe('module paths', () => {
  test('extensionless relative import opens the file', () => {
    expect(definitionAt('server/src/api/routes/departments.js', '"../../services/departments"', { at: 5 }))
      .toEqual([{ file: 'server/src/services/departments.js', text: '', line: '// Departments: aanmaken (gevalideerd) en opvragen.' }]);
  });

  test('package subpath (CommonJS file, via main-less subpath)', () => {
    expect(definitionAt('server/src/api/routes/departments.js', 'fpkit/express/get')?.[0].file)
      .toBe('server/node_modules/fpkit/express/get.js');
  });

  test('subpath to a directory index (fpkit/RTask → RTask/index.js)', () => {
    expect(definitionAt('server/src/db/props.js', '"fpkit/RTask"', { at: 2 })?.[0].file)
      .toBe('server/node_modules/fpkit/RTask/index.js');
  });

  test('require, dynamic import and a .mjs path', () => {
    expect(definitionAt('server/src/jobs/registry.js', '"../services/eventImport"', { at: 3 })?.[0].file)
      .toBe('server/src/services/eventImport.js');
    expect(definitionAt('server/src/jobs/registry.js', '"./policy.mjs"', { at: 3 })?.[0].file)
      .toBe('server/src/jobs/policy.mjs');
  });

  test('a package with an .hm sidecar opens its JavaScript, an exports subpath its target', () => {
    expect(definitionAt('server/src/db/sqlkit.js', '"sqlkit"', { at: 2 })?.[0].file)
      .toBe('server/node_modules/sqlkit/build/index.js');
    expect(definitionAt('server/src/db/props.js', '"sqlkit/Prop"', { at: 2 })?.[0].file)
      .toBe('server/node_modules/sqlkit/build/Prop.js');
  });

  test('an unresolvable path gives no answer', () => {
    const full = path.join(root, 'server/src/api/routes/departments.js');
    const source = 'import x from "./bestaat-niet";\n';
    expect(findCodeDefinition(source, pathToFileURL(full).href, 16, { includeLocal: true })).toBeNull();
  });
});

/** The clicked text (the link VS Code underlines) for a cursor position. */
function linkTextAt(file: string, needle: string, at = 0): string | null {
  const full = path.join(root, file);
  const source = fs.readFileSync(full, 'utf-8');
  const definition = findCodeDefinition(source, pathToFileURL(full).href, source.indexOf(needle) + at, { includeLocal: true });
  return definition ? source.slice(definition.origin.start, definition.origin.end) : null;
}

describe('the clicked text is one link', () => {
  test('a module path is one link, wherever the cursor is in it', () => {
    for (const at of [1, 4, 12, 18]) {
      expect(linkTextAt('server/src/api/routes/departments.js', '"../../services/departments"', at)).toBe('"../../services/departments"');
    }
    expect(linkTextAt('server/src/api/routes/departments.js', '"fpkit/express/get"', 7)).toBe('"fpkit/express/get"');
    expect(linkTextAt('server/src/jobs/registry.js', '"./policy.mjs"', 4)).toBe('"./policy.mjs"');
  });

  test('a name is one link: import specifier, use, member and local', () => {
    expect(linkTextAt('server/src/api/routes/departments.js', 'createDepartment', 4)).toBe('createDepartment');
    expect(linkTextAt('server/src/api/routes/departments.js', 'http.handle', 7)).toBe('handle');
    expect(linkTextAt('server/src/services/departments.js', 'toDepartmentInput, insertDepartment', 3)).toBe('toDepartmentInput');
  });
});

describe('ESM imports, followed through re-exports', () => {
  test('a named import in the import statement → the declaration in the service', () => {
    expect(definitionAt('server/src/api/routes/departments.js', 'createDepartment')).toEqual([
      { file: 'server/src/services/departments.js', text: 'createDepartment', line: 'export const createDepartment = pipe (validateDepartment, toDepartmentInput, insertDepartment);' },
    ]);
  });

  test('a use of the import → the same declaration', () => {
    expect(definitionAt('server/src/api/routes/departments.js', 'createDepartment', { nth: 1 })?.[0].text).toBe('createDepartment');
  });

  test('`export { getDepartment }` in the service is followed to the repository', () => {
    expect(definitionAt('server/src/api/routes/departments.js', 'getDepartment', { nth: 1 })).toEqual([
      { file: 'server/src/db/repositories/departments.js', text: 'getDepartment', line: 'export const getDepartment = departments.readById;' },
    ]);
  });

  test('`export { local as name }` and `export function`', () => {
    expect(definitionAt('server/src/api/routes/departments.js', 'created (createDepartment)')?.[0])
      .toMatchObject({ file: 'server/src/api/http.js', text: 'respondWith', line: 'const respondWith = response => _req => response;' });
    expect(definitionAt('server/src/api/routes/departments.js', 'byId (')?.[0])
      .toMatchObject({ file: 'server/src/api/http.js', text: 'byId' });
  });

  test('a namespace import: `http.handle` → the export, `http` → the module', () => {
    expect(definitionAt('server/src/api/routes/departments.js', 'http.handle', { at: 5 })?.[0])
      .toMatchObject({ file: 'server/src/api/http.js', text: 'handle' });
    expect(definitionAt('server/src/api/routes/departments.js', 'http.byId', { at: 0 })?.[0])
      .toMatchObject({ file: 'server/src/api/http.js', text: '' });
  });

  test('a default import of a CommonJS module (`module.exports = get`) → the local declaration', () => {
    expect(definitionAt('server/src/api/routes/departments.js', 'get (')?.[0])
      .toMatchObject({ file: 'server/node_modules/fpkit/express/get.js', text: 'get', line: 'const get = Component.Route ("get");' });
  });

  test('`module.exports = require ("./Component").Route ("post")` lands on that expression', () => {
    expect(definitionAt('server/src/api/routes/departments.js', 'post (')?.[0])
      .toMatchObject({ file: 'server/node_modules/fpkit/express/post.js', line: 'module.exports = require ("./Component").Route ("post");' });
  });

  test('a default import (CJS) used inside another package: pipe', () => {
    expect(definitionAt('server/src/services/departments.js', 'pipe (validateDepartment')?.[0])
      .toMatchObject({ file: 'server/node_modules/fpkit/combinator/pipe.js', text: 'pipe' });
  });

  test('a default import of a sidecar package → `exports.default = SqlKit` → the function', () => {
    expect(definitionAt('server/src/db/sqlkit.js', 'SqlKit ({')?.[0])
      .toMatchObject({ file: 'server/node_modules/sqlkit/build/index.js', text: 'SqlKit', line: 'function SqlKit (options) { return options; }' });
  });

  test('`export const { tables } = …` (destructured export) and default `export default Repo`', () => {
    expect(definitionAt('server/src/db/repositories/departments.js', 'tables.core')?.[0])
      .toMatchObject({ file: 'server/src/db/index.js', text: 'tables' });
    expect(definitionAt('server/src/db/repositories/departments.js', 'Repo (Departments)')?.[0])
      .toMatchObject({ file: 'server/src/db/Repo.js', text: 'Repo', line: 'const Repo = model => ({ readById: id => model (id), insert: data => model (data) });' });
  });

  test('`export *` and `export * as`', () => {
    const src = 'import { handle, respond } from "./index";\nexport const h = [handle, respond];\n';
    const full = path.join(root, 'server/src/api/useIndex.js');
    fs.writeFileSync(full, src);
    expect(definitionAt('server/src/api/useIndex.js', 'handle', { nth: 1 })?.[0])
      .toMatchObject({ file: 'server/src/api/http.js', text: 'handle' });
    expect(definitionAt('server/src/api/useIndex.js', 'respond', { nth: 1 })?.[0])
      .toMatchObject({ file: 'server/src/api/respond.js', text: '' });
  });
});

describe('CommonJS, .mjs/.cjs and Babel output', () => {
  test('destructured require → the export of an ESM file', () => {
    expect(definitionAt('server/src/jobs/registry.js', 'importEvents', { nth: 1 })?.[0])
      .toMatchObject({ file: 'server/src/services/eventImport.js', text: 'importEvents' });
  });

  test('`require ("x").name` and whole-module require', () => {
    expect(definitionAt('server/src/jobs/registry.js', '.toResponse', { at: 1 })?.[0])
      .toMatchObject({ file: 'server/src/api/respond.js', text: 'toResponse' });
    expect(definitionAt('server/src/jobs/registry.js', 'respond,')?.[0])
      .toMatchObject({ file: 'server/src/api/respond.js', text: '' });
  });

  test('`await import (…)` then `policy.backoffMs` → `export default function` in a .mjs file', () => {
    // `backoffMs` is the default export, not a named one: the module itself.
    expect(definitionAt('server/src/jobs/registry.js', 'policy.backoffMs', { at: 7 })?.[0])
      .toMatchObject({ file: 'server/src/jobs/policy.mjs', text: '' });
    expect(definitionAt('server/src/jobs/useLegacy.js', 'backoffMs, nextStatus, compiled')?.[0])
      .toMatchObject({ file: 'server/src/jobs/policy.mjs', text: 'backoffMs', line: 'export default function backoffMs (config) { return attempt => config.base * attempt; }' });
    expect(definitionAt('server/src/jobs/useLegacy.js', 'nextStatus, compiled')?.[0])
      .toMatchObject({ file: 'server/src/jobs/policy.mjs', text: 'nextStatus' });
  });

  test('`exports.x =` and `module.exports.x =` in a .cjs file', () => {
    expect(definitionAt('server/src/jobs/useLegacy.js', 'stableStringify, idempotencyKey, backoffMs')?.[0])
      .toMatchObject({ file: 'server/src/jobs/legacy.cjs', text: 'stableStringify' });
    expect(definitionAt('server/src/jobs/useLegacy.js', 'idempotencyKey, backoffMs')?.[0])
      .toMatchObject({ file: 'server/src/jobs/legacy.cjs', text: 'idempotencyKey' });
  });

  test('Babel output: `exports.default = _default` → the local, `Object.defineProperty (exports, "helper")`', () => {
    expect(definitionAt('server/src/jobs/useLegacy.js', 'compiled, helper')?.[0])
      .toMatchObject({ file: 'server/src/jobs/compiled.js', text: '_default', line: 'var _default = run;' });
    expect(definitionAt('server/src/jobs/useLegacy.js', 'helper]')?.[0])
      .toMatchObject({ file: 'server/src/jobs/compiled.js', text: '"helper"' });
  });

  test('`module.exports = X; X.name = …` (fpkit parseReq.parseReqWith)', () => {
    expect(definitionAt('server/src/db/props.js', 'parseReqWith }')?.[0])
      .toMatchObject({ file: 'server/node_modules/fpkit/Result/parseReq.js', text: 'parseReqWith', line: 'const parseReqWith = onInvalid => params => req => req;' });
    expect(definitionAt('server/src/db/props.js', 'parseReq.parseReqWith', { at: 9 })?.[0])
      .toMatchObject({ file: 'server/node_modules/fpkit/Result/parseReq.js', text: 'parseReqWith' });
  });

  test('a barrel `module.exports = { pipe: require ("./combinator/pipe") }`', () => {
    expect(definitionAt('server/src/db/props.js', 'pipe }')?.[0])
      .toMatchObject({ file: 'server/node_modules/fpkit/combinator/pipe.js', text: '' });
  });

  test('`module.exports = { … }` in a consumer: the property key of a whole-module require', () => {
    expect(definitionAt('server/src/db/props.js', 'RTask, pipe')?.[0])
      .toMatchObject({ file: 'server/node_modules/fpkit/RTask/index.js', text: '' });
  });
});

describe('local names and scope', () => {
  test('a local name → its declaration in the same file', () => {
    expect(definitionAt('server/src/services/departments.js', 'toDepartmentInput, insertDepartment')).toEqual([
      { file: 'server/src/services/departments.js', text: 'toDepartmentInput', line: 'const toDepartmentInput = v => ({ name: v.name, countryId: null });' },
    ]);
  });

  test('a shadowing parameter is not the import', () => {
    expect(definitionAt('server/src/jobs/useLegacy.js', 'stableStringify;')?.[0])
      .toMatchObject({ file: 'server/src/jobs/useLegacy.js', line: 'const shadow = stableStringify => stableStringify;' });
  });

  test('without includeLocal, local names give no answer (imports still do)', () => {
    expect(definitionAt('server/src/services/departments.js', 'toDepartmentInput, insertDepartment', { includeLocal: false })).toBeNull();
    expect(definitionAt('server/src/services/departments.js', 'insertDepartment);', { includeLocal: false })?.[0].file)
      .toBe('server/src/db/repositories/departments.js');
  });

  test('a re-export cycle terminates', () => {
    fs.writeFileSync(path.join(root, 'server/src/cycleA.js'), 'export { x } from "./cycleB";\n');
    fs.writeFileSync(path.join(root, 'server/src/cycleB.js'), 'export { x } from "./cycleA";\n');
    fs.writeFileSync(path.join(root, 'server/src/useCycle.js'), 'import { x } from "./cycleA";\nexport const y = x;\n');
    expect(definitionAt('server/src/useCycle.js', 'x;')?.[0].file).toMatch(/server\/src\/cycle[AB]\.js/);
  });
});
