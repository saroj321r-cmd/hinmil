// ============================================
// Type System — Functions
// ============================================

// Single argument
// formatAmount :: Number -> String
const formatAmount = (n) => `€ ${n.toFixed(2)}`;

// Multiple arguments
// applyVat :: (Number, Number) -> Number
const applyVat = (amount, rate) => amount * (1 + rate);

// Higher-order
// map :: ((a -> b), [a]) -> [b]
const map = (fn, xs) => xs.map(fn);

// ============================================
// Type System — Arrays & Tuples
// ============================================

// Arrays — homogeneous
// invoiceTotal :: [Number] -> Number
const invoiceTotal = (amounts) => amounts.reduce((a, b) => a + b, 0);

// Tuples — fixed-length, heterogeneous
// formatLine :: (String, Number) -> String
const formatLine = (line) => `${line[0]}: ${line[1]}`;

// ============================================
// Type System — Records
// ============================================

// Record types with named fields
// customerLabel :: { name :: String, vatNumber :: String } -> String
const customerLabel = (customer) => `${customer.name} (${customer.vatNumber})`;

// ============================================
// Type System — Union Types
// ============================================

// Explicit union
// show :: (Number | String) -> String
const show = (x) => String(x);

// Automatically inferred from conditionals
const reference = Math.random() > 0.5 ? 2026001 : "draft";
// reference: Number | String

// Singleton string-literal types
// statusLabel :: 'draft' | 'sent' | 'paid' -> String
const statusLabel = (s) => `status: ${s}`;

// ============================================
// Type System — Generics
// ============================================

// identity :: a -> a
const identity = (x) => x;

// constant :: (a, b) -> a
const constant = (x, y) => x;
