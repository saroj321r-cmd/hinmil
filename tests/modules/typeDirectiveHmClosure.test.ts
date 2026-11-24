// A `// ::types` target passes its own `// ::types` on, also when that nested
// target is a `.hm` file found through the extensionless form.  A shared JS
// module of domain types (`src/types/invoice.js`) builds on a `.hm` file of
// small value types (`src/types/money.hm`); a screen that loads only the
// invoice types may name the money types too, exactly as it may when the
// nested target is a JS module.  Before, the nested `.hm` file was skipped
// (HM2004 "Unknown type constructor 'Currency'").

import { TempProject } from '../helpers/project';

const project = new TempProject('type-directive-hm-closure');

beforeAll(() => {
  project.setup();
  project.write('src/types/money.hm', `Currency :: 'EUR' | 'USD' | 'GBP'
Money :: { cents :: Number, currency :: Currency }
`);
  project.write('src/types/invoice.js', `// ::types ./money

// LineItem :: { description :: String, price :: Money }
`);
  project.write('src/types/tax.js', `// TaxRate :: { country :: String, rate :: Number }
`);
  project.write('src/types/billing.js', `// ::types ./tax
// Invoice :: { number :: String, tax :: TaxRate }
`);
});
afterAll(() => project.cleanup());

function errors(source: string): string[] {
  return project.inferSource('src/screens/invoiceRow.js', source).diagnostics
    .filter(d => d.severity !== 3)
    .map(d => d.message);
}

describe('::types passes on a nested .hm target', () => {
  test('types of the nested .hm file can be named by the consumer', () => {
    expect(errors(`// ::types ../types/invoice

// currencyOf :: LineItem -> Currency
export const currencyOf = item => item.price.currency;

// formatMoney :: Money -> String
export const formatMoney = money => String (money.cents / 100) + " " + money.currency;
`)).toEqual([]);
  });

  test('the nested types are checked, not just accepted', () => {
    const errs = errors(`// ::types ../types/invoice

// centsOf :: LineItem -> Currency
export const centsOf = item => item.price.cents;
`);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join('\n')).not.toMatch(/Unknown type constructor/);
  });

  test('a literal outside the nested union is rejected', () => {
    const errs = errors(`// ::types ../types/invoice

// defaultCurrency :: Currency
export const defaultCurrency = "YEN";
`);
    expect(errs.length).toBeGreaterThan(0);
    expect(errs.join('\n')).not.toMatch(/Unknown type constructor/);
  });

  test('a nested JS target keeps working the same way', () => {
    expect(errors(`// ::types ../types/billing

// rateOf :: Invoice -> TaxRate
export const rateOf = invoice => invoice.tax;
`)).toEqual([]);
  });
});
