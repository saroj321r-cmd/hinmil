// ============================================
// Pipe — left-to-right function composition
// ============================================

// pipe :: ((a -> b), (b -> c), ..., (y -> z)) -> a -> z
const pipe = (...fns) => fns.reduce((acc, fn) => x => fn(acc(x)));

const invoiceLabel = pipe(
  x => x * 1.21,           // Number -> Number   (apply VAT)
  x => x.toFixed(2),       // Number -> String   (format)
  x => `€ ${x}`,           // String -> String   (prefix)
);
// invoiceLabel :: Number -> String

// ============================================
// Compose — right-to-left function composition
// ============================================

// compose :: ((y -> z), ..., (b -> c), (a -> b)) -> a -> z
const compose = (...fns) => fns.reduceRight((acc, fn) => x => fn(acc(x)));

const invoiceLabel2 = compose(
  x => `€ ${x}`,           // String -> String   (prefix)
  x => x.toFixed(2),       // Number -> String   (format)
  x => x * 1.21,           // Number -> Number   (apply VAT)
);
// invoiceLabel2 :: Number -> String

// ============================================
// Type error — chain mismatch
// ============================================

// This would report: Cannot unify String with Number
// pipe(
//   x => x.toFixed(2),       // Number -> String
//   x => x * 1.21,           // Number -> Number  ← mismatch
// );
