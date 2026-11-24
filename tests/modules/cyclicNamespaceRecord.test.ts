// Regression: the tagged-constructor pattern used by http-component style
// libraries creates a genuine object-reference CYCLE in the type graph:
//
//   const Component = {};
//   const Engine$prototype = { constructor: Component, ... };
//   export const Engine = Component.Engine = (ext, handler) =>
//     Object.create (Engine$prototype);
//
// Storing the constructor function onto the `Component` namespace record
// makes `Component.Engine → (… -> engine record) → constructor → Component`
// loop back on itself.  Every recursive type walker (substitution, free-var
// collection, printing) then recursed forever, the file died with
// "Internal inference error: Maximum call stack size exceeded", its exports
// were never registered, and importers saw bogus follow-up errors such as
// "'Setting' is not exported from './lib/http'" even though the export
// clearly exists.
//
// The fix is two-fold: `expr-assignment` breaks back-references before
// storing an extended record field, and `Substitution.apply` guards record
// re-entry by object identity as a safety net.
import { TempProject } from '../helpers/project';

const isError = (d: { severity?: number }) =>
  d.severity === undefined || d.severity === 1;

describe('namespace record with cyclic constructor back-reference', () => {
  const project = new TempProject('cyclic-namespace-record');

  beforeAll(() => {
    project.setup();
    project.write('lib/http/Component.js', [
      'const Component = {};',
      '',
      'const componentType = "app/Component";',
      '',
      'const Engine$prototype = {',
      '  constructor: Component,',
      '  caseOf: Engine$prototype$caseOf,',
      '  "@@type": componentType,',
      '  isRoute: false',
      '};',
      '',
      'const Setting$prototype = {',
      '  constructor: Component,',
      '  caseOf: Setting$prototype$caseOf,',
      '  "@@type": componentType,',
      '  isRoute: false',
      '};',
      '',
      'export const Engine = Component.Engine = (ext, handler) => {',
      '  let engine = Object.create (Engine$prototype);',
      '  engine.ext = ext;',
      '  engine.handler = handler;',
      '  return engine;',
      '};',
      '',
      'export const Setting = Component.Setting = (name, value) => {',
      '  let setting = Object.create (Setting$prototype);',
      '  setting.name = name;',
      '  setting.value = value;',
      '  return setting;',
      '};',
      '',
      'function Engine$prototype$caseOf(structureMap) {',
      '  return structureMap.Engine (this.ext, this.handler);',
      '}',
      '',
      'function Setting$prototype$caseOf(structureMap) {',
      '  return structureMap.Setting (this.name, this.value);',
      '}',
      '',
      'export default Component;',
    ].join('\n'));
    // Barrel re-export, mirroring a typical `lib/http/index.js`.
    project.write('lib/http/index.js', [
      'import Component, { Engine, Setting } from "./Component.js";',
      '',
      'export {',
      '  Component,',
      '  Engine,',
      '  Setting',
      '};',
    ].join('\n'));
  });

  afterAll(() => project.cleanup());

  test('the defining module infers without blowing the stack', () => {
    const r = project.inferFile('lib/http/Component.js');
    const errors = r.diagnostics.filter(isError).map(d => d.message);
    expect(errors).toEqual([]);
  });

  test('re-exports through the barrel resolve (no false "not exported")', () => {
    project.write('server.js', [
      'import { Engine, Setting } from "./lib/http/index.js";',
      '',
      'export const components = [',
      '  Engine ("pug", (filePath, options) => options),',
      '  Setting ("x-powered-by", false)',
      '];',
    ].join('\n'));
    const r = project.inferFile('server.js');
    const errors = r.diagnostics.filter(isError).map(d => d.message);
    expect(errors).toEqual([]);
  });
});
