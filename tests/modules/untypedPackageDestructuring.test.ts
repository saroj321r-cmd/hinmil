// Destructuring the result of a hook from a package without types
// (`const [params, setParams] = useSearchParams ()` from a router library
// with plain JavaScript and no `.hm` sidecar).  Every element is `Any` on its
// own: a shared fresh variable tied them together, so using `params` as a Map
// made `setParams` "not callable".

import { TempProject } from '../helpers/project';

const project = new TempProject('untyped-package-destructuring');

beforeAll(() => {
  project.setup();
  project.write('node_modules/url-router/package.json', JSON.stringify({ name: 'url-router', main: 'index.js' }));
  project.write('node_modules/url-router/index.js', `
exports.useSearchParams = function useSearchParams() {
  const params = new URLSearchParams(window.location.search);
  return [params, next => window.history.pushState(null, "", "?" + next.toString())];
};
`);
});
afterAll(() => project.cleanup());

function errors(source: string): string[] {
  return project.inferSource('screen.js', source).diagnostics
    .filter(d => d.severity !== 3)
    .map(d => d.message);
}

describe('destructuring a hook result from an untyped package', () => {
  test('the elements are independent: a getter and a setter', () => {
    expect(errors(`
import { useSearchParams } from "url-router";

// useUrlFilter :: String -> String
export const useUrlFilter = name => {
  const [params, setParams] = useSearchParams();
  const next = new URLSearchParams(params);
  next.set(name, "1");
  setParams(next);
  return params.get(name) || "";
};
`)).toEqual([]);
  });

  test('a typed use of an element is still checked', () => {
    const errs = errors(`
import { useSearchParams } from "url-router";

// filterCount :: String -> Number
export const filterCount = name => {
  const [params] = useSearchParams();
  return params.get(name) + "";
};
`);
    expect(errs.length).toBeGreaterThan(0);
  });
});
