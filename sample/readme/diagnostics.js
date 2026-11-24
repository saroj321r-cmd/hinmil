// ============================================
// Diagnostics — type error example
// ============================================

// applyVat :: (Number, Number) -> Number
const applyVat = (amount, rate) => amount * (1 + rate);

applyVat("21%", 0.21); // Cannot unify String with Number
