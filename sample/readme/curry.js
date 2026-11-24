// ============================================
// Curry — requires explicit curry() wrapping
// ============================================

// curry :: ((a, b, ...) -> z) -> a -> b -> ... -> z
const curry = fn => {
  const curried = (...args) => {
    if (args.length >= fn.length) return fn(...args);
    return (...next) => curried(...args, ...next);
  };
  return curried;
};

// discountedTotal :: (Number, Number, Number) -> Number
const discountedTotal = (quantity, unitPrice, discountPct) =>
  quantity * unitPrice * (1 - discountPct / 100);

const curriedTotal = curry(discountedTotal);
// curriedTotal :: Number -> Number -> Number -> Number

// All partial application forms are valid:
curriedTotal(2, 50, 10);     // fully applied
curriedTotal(2)(50)(10);     // fully curried
curriedTotal(2, 50)(10);     // partial + apply
curriedTotal(2)(50, 10);     // apply + partial

