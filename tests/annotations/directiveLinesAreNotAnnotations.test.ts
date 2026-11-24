// A directive line directly above a declaration belongs to the file, not to
// that declaration.  `// ::prefer Prop from sqlkit` right above `const`
// was read as the declaration's (nameless) annotation `prefer Prop from
// sqlkit`: HM2001 "Type variable 'prefer' is applied to 'Prop'" plus HM2007.
// Every directive keyword is skipped by the annotation parser; a real
// annotation below it still applies.

import { diags } from '../helpers/infer';

describe('directive lines are not annotations', () => {
  test.each([
    ['::prefer', '// ::prefer Prop from sqlkit'],
    ['::prefer with several names', '// ::prefer Prop, Table from sqlkit'],
    ['::builtin', '// ::builtin ReactElement'],
  ])('%s above a declaration', (_label, directive) => {
    expect(diags(`${directive}
const pageSize = 50;
`)).toEqual([]);
  });

  test('the annotation under a directive still applies', () => {
    expect(diags(`// ::prefer Prop from sqlkit
// pageSize :: Number
const pageSize = "fifty";
`)).toEqual([expect.stringMatching(/String|Number/)]);
  });
});
