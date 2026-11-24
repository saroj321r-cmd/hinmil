// A `.hm` file may end a declaration line with a `// remark`, as in
// JavaScript.  Before, only whole-line comments were allowed: a trailing
// remark made the line unparsable ("Unexpected trailing token: :" for
// `nested: a list`, or the remark was read as more of the type).  The
// remark is ignored; `//` inside a string-literal type is kept.

import { TempProject } from '../helpers/project';
import { wrapHmSource } from '../../src/services/files';

const project = new TempProject('hm-trailing-comments');

beforeAll(() => {
  project.setup();
  project.write('src/payments.hm', `// Types of the payment provider (it ships none).
PaymentStatus :: 'open' | 'paid' | 'failed'   // as the provider sends it
Payment :: { id :: String, amount :: Number, status :: PaymentStatus }   // one checkout

CheckoutUrl :: 'https://pay.example.test/checkout' | 'https://pay.example.test/retry'
`);
});
afterAll(() => project.cleanup());

function errors(source: string): string[] {
  return project.inferSource('src/checkout.js', source).diagnostics
    .filter(d => d.severity !== 3)
    .map(d => d.message);
}

describe('trailing comments in .hm files', () => {
  test('declarations with a trailing remark are read', () => {
    expect(errors(`// ::types ./payments

// isPaid :: Payment -> Boolean
export const isPaid = (payment) => payment.status === 'paid';
`)).toEqual([]);
  });

  test('the remark is not part of the type', () => {
    const errs = errors(`// ::types ./payments

// statusOf :: Payment -> PaymentStatus
export const statusOf = (payment) => payment.amount;
`);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join('\\n')).not.toMatch(/Unknown type constructor|type arguments/);
  });

  test('a // inside a string-literal type is kept', () => {
    expect(errors(`// ::types ./payments

// retryUrl :: CheckoutUrl
export const retryUrl = 'https://pay.example.test/retry';
`)).toEqual([]);
  });

  test('wrapping keeps every line the same length', () => {
    const source = "Status :: 'open' | 'paid'   // remark\nAmount :: Number\n";
    const wrapped = wrapHmSource(source).split('\n').map(l => l.replace(/^\/\/ /, ''));
    expect(wrapped.map(l => l.length)).toEqual(source.split('\n').map(l => l.length));
    expect(wrapped[0].trimEnd()).toBe("Status :: 'open' | 'paid'");
  });
});
