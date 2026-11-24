// Scenario: an untyped JS library typed externally via a `.hm` sidecar.
//
// src/validators.js is a plain validation library written WITHOUT any
// annotation comments — the kind of legacy/vendored code a user cannot (or
// does not want to) touch.  The types are supplied out-of-band in
// src/validators.js.hm (per-file sidecar; see tests/modules/sidecars.test.ts
// for the resolution rules).
//
// src/signup.js consumes the library.  We assert the sidecar types flow
// through the import (exports of the consumer show the sidecar-declared
// signatures) and that a misuse in the consumer is flagged.

import { TempProject } from '../helpers/project';
import { prettyTypeToString, Scheme } from '../../src/hm/types';

const project = new TempProject('scenario-sidecar-library');

// Deliberately annotation-free: bodies alone would infer overly generic
// (or plain wrong) types — e.g. `minLength` would accept any `n`.
const VALIDATORS_JS = `const isEmail = (input) => /@/.test(String(input));

const minLength = (n) => (s) => s.length >= n;

const required = (s) => s != null && s !== '';

const validate = (rules) => (value) => rules.every((rule) => rule(value));

export { isEmail, minLength, required, validate };
`;

const VALIDATORS_HM = `isEmail :: String -> Boolean
minLength :: Number -> String -> Boolean
required :: String -> Boolean
validate :: [(String -> Boolean)] -> String -> Boolean
`;

const SIGNUP_JS = `import { isEmail, minLength, required, validate } from './validators.js';

const emailOk = isEmail('user@example.com');

// Partially applying the sidecar-typed curried validator.
const passwordLongEnough = minLength(8);

// Building a composite validator from the library pieces.
const checkPassword = validate([required, minLength(8)]);

const strong = checkPassword('correct horse battery staple');

export { emailOk, passwordLongEnough, checkPassword, strong };
`;

function exportType(res: { exports: Map<string, Scheme> }, name: string): string {
  const scheme = res.exports.get(name);
  expect(scheme).toBeDefined();
  return prettyTypeToString(scheme!.type);
}

beforeAll(() => {
  project.setup();
  project.write('src/validators.js', VALIDATORS_JS);
  project.write('src/validators.js.hm', VALIDATORS_HM);
  project.write('src/signup.js', SIGNUP_JS);
});

afterAll(() => project.cleanup());

describe('signup.js — consumer of the sidecar-typed library', () => {
  it('produces zero diagnostics for correct usage', () => {
    const res = project.inferFile('src/signup.js');
    expect(res.diagnostics.map(d => d.message)).toEqual([]);
  });

  it('sidecar types flow through the import', () => {
    const res = project.inferFile('src/signup.js');
    expect(exportType(res, 'emailOk')).toBe('Boolean');
    expect(exportType(res, 'passwordLongEnough')).toBe('String -> Boolean');
    expect(exportType(res, 'checkPassword')).toBe('String -> Boolean');
    expect(exportType(res, 'strong')).toBe('Boolean');
  });
});

describe('misuse in the consumer is flagged', () => {
  // NOTE: a bare wrong-argument call to an imported function (e.g.
  // `isEmail(42)`) is deliberately lenient — the engine auto-unions argument
  // mismatches unless the callee is annotated in the current file.  The
  // cases below reflect how sidecar types actually catch bugs: through the
  // consumer's own annotations and non-unionable shapes.

  it('passing the Boolean result where a local annotated fn expects the email String', () => {
    const res = project.inferSource('src/bad1.js', `import { isEmail } from './validators.js';

// notify :: String -> String
const notify = (email) => 'sent to ' + email;

// Bug: passing the validation RESULT instead of the email itself.
const oops = notify(isEmail('a@b.c'));
export { oops };
`);
    const msgs = res.diagnostics.map(d => d.message);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.some(m => m.includes('Boolean') && m.includes('String'))).toBe(true);
  });

  it('a consumer annotation that contradicts the sidecar signature is reported', () => {
    const res = project.inferSource('src/bad2.js', `import { minLength } from './validators.js';

// Bug: user misremembers the API — minLength(8) is String -> Boolean.
// atLeast8 :: Number -> Boolean
const atLeast8 = minLength(8);
export { atLeast8 };
`);
    const msgs = res.diagnostics.map(d => d.message);
    expect(msgs.length).toBeGreaterThan(0);
    expect(msgs.some(m =>
      m.includes("'atLeast8' has type 'String -> Boolean' but annotation expects 'Number -> Boolean'"),
    )).toBe(true);
  });

  it('a rules array with a non-validator entry is reported', () => {
    const res = project.inferSource('src/bad3.js', `import { validate, required } from './validators.js';
const oops = validate([required, 'not a rule']);
export { oops };
`);
    const msgs = res.diagnostics.map(d => d.message);
    expect(msgs.length).toBeGreaterThan(0);
  });
});
