// `// ::types ./types` loads `types.hm` when there is no JS module of that
// name: a shared file of opaque types for libraries without typings is
// usually a `.hm` file, and the extensionless form looked like it worked but
// reported HM3002 while every type stayed unknown.  A JS module of the same
// name still wins, and a path that matches nothing still reports HM3002.

import { TempProject } from '../helpers/project';

const project = new TempProject('type-directive-hm-resolution');

const STREAM_TYPES = `// Opaque stream types (the library has no typings).
Observable :: (Subscriber a -> (() -> ())) -> Observable a
Subscriber :: a -> Subscriber a
`;

beforeAll(() => {
  project.setup();
  project.write('src/types.hm', STREAM_TYPES);
  project.write('src/rows.js', `// Row :: { id :: Number, name :: String }\n\nexport const PAGE_SIZE = 50;\n`);
  project.write('src/rows.hm', `Row :: { id :: String }\n`);
});
afterAll(() => project.cleanup());

function errors(source: string): string[] {
  return project.inferSource('src/screen.js', source).diagnostics
    .filter(d => d.severity !== 3)
    .map(d => d.message);
}

describe('::types resolves an extensionless path to a .hm file', () => {
  test('./types finds types.hm', () => {
    expect(errors(`// ::types ./types

// keepLatest :: Observable String -> Observable String
export const keepLatest = stream => stream;
`)).toEqual([]);
  });

  test('./types.hm keeps working', () => {
    expect(errors(`// ::types ./types.hm

// keepLatest :: Observable String -> Observable String
export const keepLatest = stream => stream;
`)).toEqual([]);
  });

  test('the loaded types are checked', () => {
    const errs = errors(`// ::types ./types

// toCount :: Observable String -> Observable Number
export const toCount = stream => stream;
`);
    expect(errs.length).toBeGreaterThan(0);
  });

  test('a JS module of the same name wins over the .hm file', () => {
    expect(errors(`// ::types ./rows

// rowName :: Row -> String
export const rowName = row => row.name + String(row.id + 1);
`)).toEqual([]);
  });

  test('a path that matches nothing still reports HM3002', () => {
    expect(errors(`// ::types ./stream-types

const page = 1;
`)).toEqual(["Cannot resolve ::types path './stream-types': file not found"]);
  });
});
