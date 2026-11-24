// Regression: property access on a union that contains UNRESOLVED (plain
// type-variable) members used to error with
//
//   Property 'path' does not exist on types 'b', 'a', … in union 'b | a | …'
//
// Unresolved members show up in real projects whenever a module could not
// be fully typed — most commonly through circular imports, where hinmil
// hands the importer a placeholder TVar for each imported binding.  A
// route-mounting pattern like
//
//   const routes = twoFA.concat (servicePage);
//   routes.map (r => { r.path = `/api${r.path}`; return r; });
//
// then performs member access on `record | tvar | tvar`.  Property access
// on a SINGLE type variable is permissive (it says nothing about the
// property either way), so union members that are still variables must be
// permissive too instead of being reported as "missing property".
import { TempProject } from '../helpers/project';

const isError = (d: { severity?: number }) =>
  d.severity === undefined || d.severity === 1;

describe('property access on unions with unresolved members', () => {
  const project = new TempProject('union-unresolved-member-access');

  beforeAll(() => {
    project.setup();
    project.write('routerLib.js', [
      'export const get = (path, handler) => ({ method: "get", path, handler });',
      'export const post = (path, handler) => ({ method: "post", path, handler });',
    ].join('\n'));
    // twoFARouter ↔ applicationRouter form an import cycle, so the
    // bindings imported across the cycle come back as placeholder TVars.
    project.write('twoFARouter.js', [
      'import servicePageFallback from "./applicationRouter.js";',
      'import { post } from "./routerLib.js";',
      '',
      'export const adminRoutes = [post ("/2fa/verify", req => req.body)];',
      '',
      'export default [post ("/2fa/enable", req => req.body)].concat (servicePageFallback);',
    ].join('\n'));
    project.write('applicationRouter.js', [
      'import { adminRoutes } from "./twoFARouter.js";',
      '',
      'export default adminRoutes;',
    ].join('\n'));
  });

  afterAll(() => project.cleanup());

  test('mapping over concatenated routes rewrites r.path without diagnostics', () => {
    project.write('appIndex.js', [
      'import twoFA from "./twoFARouter.js";',
      'import servicePage from "./applicationRouter.js";',
      '',
      'const routes = twoFA.concat (servicePage);',
      '',
      'export const components = routes.map (r => {',
      '  r.path = `/api${r.path}`;',
      '  return r;',
      '});',
    ].join('\n'));
    const r = project.inferFile('appIndex.js');
    const errors = r.diagnostics.filter(isError).map(d => d.message);
    expect(errors).toEqual([]);
  });
});
