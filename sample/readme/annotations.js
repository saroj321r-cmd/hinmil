// ============================================
// Type Annotations — basic signatures
// ============================================

// applyVat :: (Number, Number) -> Number
const applyVat = (amount, rate) => amount * (1 + rate);

// identity :: a -> a
const identity = (x) => x;

// invoiceTotal :: [Number] -> Number
const invoiceTotal = (amounts) => amounts.reduce((a, b) => a + b, 0);

// ============================================
// Multi-line annotation
// ============================================

/* applyVat2 :: (Number, Number) -> Number */
const applyVat2 = (amount, rate) => amount * (1 + rate);
