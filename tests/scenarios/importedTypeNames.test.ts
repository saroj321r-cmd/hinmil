// Type names travel with imports.
//
// A consumer that imports a VALUE from an inline-annotated module can use the
// type names that module declares — its standalone `// Name :: …` aliases and,
// recursively, whatever its own `// ::types …` directives load — in its own
// annotations, without repeating `// ::types` lines.  Before, only `.hm`
// sidecar aliases travelled; the app's `api/app.js` (imports fpkit
// `express/createWith`, annotates `createApp :: () -> ExpressApp`) needed
// `// ::types fpkit/express/Component` to avoid HM2004.
//
// The package below is a trimmed copy of fpkit's express module (Component
// declares the request/app aliases; `post` names them via `::types`).

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const ROOT = '/tmp/hm-scenarios-imported-type-names';

function write(rel: string, body: string): void {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function lint(name: string, body: string): string[] {
  const rel = `src/${name}.js`;
  write(rel, body);
  let stdout = '';
  runCli([rel], { cwd: ROOT, stdout: (t) => { stdout += t; }, stderr: () => {} });
  return stdout.split('\n')
    .filter((l) => / error /.test(l))
    .map((l) => l.replace(/^\S+?:(\d+):\d+ error /, '$1 '));
}

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  write('package.json', '{ "name": "imported-type-names" }');
  write('node_modules/fnlib/package.json', '{ "name": "fnlib", "version": "1.0.0", "main": "index.js" }');
  write('node_modules/fnlib/index.js', '"use strict";\nmodule.exports = {};\n');
  write('node_modules/fnlib/express/Component.js', `"use strict";

// RequestObj :: { method :: String, path :: String, body :: Object String Any, params :: Object String String, query :: Object String String }
// ExpressApp :: { locals :: Object String Any, set :: (String, Any) -> (), listen :: (Number, Error | Undefined -> ()) -> () }
// RouteFn :: RequestObj -> Promise Error String

// Component :: { method :: String, path :: String, handler :: RouteFn }

// Route :: String -> String -> RouteFn -> Component
const Route = method => path => handler => ({ method, path, handler });

module.exports = { Route };
`);
  write('node_modules/fnlib/express/post.js', `"use strict";

// ::types ./Component

const Component = require ("./Component");

// post :: String -> RouteFn -> Component
const post = Component.Route ("post");

module.exports = post;
`);
  write('node_modules/fnlib/express/listen.js', `"use strict";

// ::types ./Component

// listen :: Number -> ExpressApp -> ()
const listen = port => app => app.listen (port, _err => {});

module.exports = listen;
`);
  write('node_modules/fnlib/Result/specialRules.js', `"use strict";

// Rule :: (String, Any, Object String Any, Boolean) -> Object String [String]

// nonNullableRule :: Rule -> Rule
const nonNullableRule = rule => {
  rule.__isnonnullable = true;
  return rule;
};

module.exports = { nonNullableRule };
`);
  // parseReq names `Errors`, declared in ./Schema, which it requires (no
  // `::types` line): the name is visible in parseReq, so it travels too.
  write('node_modules/fnlib/Result/Schema.js', `"use strict";

// Errors :: Object String [String]

// schema :: Object String Any -> Object String Any -> Errors
const schema = _spec => _obj => ({});

module.exports = schema;
`);
  write('node_modules/fnlib/Result/parseReq.js', `"use strict";

const schema = require ("./Schema");

// parseReq :: Object String Any -> Object String Any -> Errors
const parseReq = spec => req => schema (spec) (req);

module.exports = parseReq;
`);
  write('src/departmentTypes.js', `// DepartmentInput :: { name :: String, countryId :: Number | Null }

// emptyDepartment :: () -> DepartmentInput
export const emptyDepartment = () => ({ name: "", countryId: null });
`);
});

test('aliases loaded by an imported module\'s own ::types are usable', () => {
  expect(lint('routes', `import post from "fnlib/express/post";

// createDepartmentRoute :: RouteFn -> Component
export const createDepartmentRoute = handler => post ("/departments") (handler);

// departmentBody :: RequestObj -> Object String Any
export const departmentBody = req => req.body;
`)).toEqual([]);
});

test('aliases declared by the imported module itself are usable', () => {
  expect(lint('rules', `import { nonNullableRule } from "fnlib/Result/specialRules";

// required :: Rule
export const required = nonNullableRule ((key, value, _obj, _updating) =>
  value == null ? { [key]: [key + " is verplicht"] } : {});
`)).toEqual([]);
});

test('names a module gets from its own imports travel too', () => {
  expect(lint('parseDepartment', `import parseReq from "fnlib/Result/parseReq";

// departmentErrors :: Object String Any -> Errors
export const departmentErrors = parseReq ({ name: [] });
`)).toEqual([]);
});

test('project modules export their standalone aliases too', () => {
  expect(lint('departments', `import { emptyDepartment } from "./departmentTypes";

// withName :: String -> DepartmentInput -> DepartmentInput
export const withName = name => department => ({ name, countryId: department.countryId });

// fresh :: DepartmentInput
export const fresh = emptyDepartment ();
`)).toEqual([]);
});

test('imported aliases are checked, not opaque', () => {
  expect(lint('appBad', `import listen from "fnlib/express/listen";

// appPort :: ExpressApp -> String
export const appPort = app => app.locals;

listen (3000);
`)).toEqual([expect.stringMatching(/^4 HM1003 /)]);
});

test('a name the imports do not declare stays unknown', () => {
  expect(lint('unknownRule', `import post from "fnlib/express/post";

// required :: Rule
export const required = (key, value, _obj, _updating) => ({});

post;
`)).toEqual([expect.stringMatching(/^3 HM2004 .*'Rule'/)]);
});

test('a value annotation is not exported as a type name', () => {
  // \`Route\` is annotated on a declaration in Component.js: a value, not an alias.
  expect(lint('routeValue', `import post from "fnlib/express/post";

// make :: () -> Route
export const make = () => post;
`)).toEqual([expect.stringMatching(/^3 HM2004 .*'Route'/)]);
});

test('a local alias wins over an imported one', () => {
  expect(lint('localWins', `import post from "fnlib/express/post";

// RequestObj :: { departmentId :: Number }

// departmentId :: RequestObj -> Number
export const departmentId = req => req.departmentId;

post;
`)).toEqual([]);
});

describe('a type alias above an unrelated, unannotated declaration', () => {
  // `// Parser :: …`, a blank line, then `// How long …` + `const TTL = …`:
  // the alias stands alone (it is not TTL's annotation) and travels with the
  // import like any other.
  beforeAll(() => {
    write('src/parser.js', `// Parser :: { run :: String -> Number }

// How long a cached result stays valid.
const TTL = 1000;

// makeParser :: Number -> Parser
export const makeParser = n => ({ run: s => s.length + n + TTL });
`);
  });

  test('positive: the importer can name the alias', () => {
    expect(lint('usesParser', `import { makeParser } from "./parser";

// runWith :: Parser -> Number
export const runWith = parser => parser.run ("x");

export const n = runWith (makeParser (1));
`)).toEqual([]);
  });

  test('negative: the imported alias is still checked', () => {
    const errors = lint('usesParserBad', `import { makeParser } from "./parser";

// runWith :: Parser -> String
export const runWith = parser => parser.run ("x");
`);
    // As for a local alias: the binding (HM1003) and the mismatching
    // expression (HM1001).
    expect(errors).toEqual([
      "4 HM1003 Type mismatch: 'runWith' has type 'Parser -> Number' but annotation expects 'Parser -> String'",
      "4 HM1001 Type mismatch: Cannot unify 'Number' with 'String'",
    ]);
  });
});
