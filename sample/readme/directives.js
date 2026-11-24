// ============================================
// Directive examples from the README, verified
// against the inference engine.
// ============================================

// --- ::constraint — discharged on the argument's actual type ---

// ::constraint Semigroup s { s :: { concat :: s ~> s -> s } }

// joinAll :: Semigroup s => (s, [s]) -> s
const joinAll = (init, xs) => xs.reduce((acc, x) => acc.concat(x), init);

const ref = joinAll('INV-', ['2026', '-001']); // String has concat — fine
const rows = joinAll([1], [[2], [3]]);         // Array has concat — fine
// joinAll(5, [6]) would report:
// Type 'Number' does not satisfy constraint 'Semigroup': missing method 'concat'

// --- ::narrow — both branches narrow ---

// ::narrow Number
// isCount :: a -> Boolean
const isCount = (x) => Number.isInteger(x) && x >= 0;

// quantityLabel :: (Number | String) -> String
const quantityLabel = (q) => isCount(q) ? q.toFixed(0) : q.trim();

// --- ::extend — widen a union alias, string literals included ---

// PaymentMethod :: 'cash' | 'card'

// ::extend PaymentMethod 'voucher'

// pmLabel :: PaymentMethod -> String
const pmLabel = (m) => m;
const ok = pmLabel('voucher');

// --- ::rep — let Array satisfy Monoid via a local signature ---

// ::constraint Monoid m { m :: { empty :: () -> m } }

// ::rep Monoid Array.empty
// Array.empty :: () -> Array a

// orEmpty :: Monoid m => m -> m
const orEmpty = (x) => x;

const r = orEmpty([1, 2]);
