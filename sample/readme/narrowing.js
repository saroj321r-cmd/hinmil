// ============================================
// ::narrow — Type Predicates
// ============================================

// ::narrow String
// isString :: a -> Boolean
const isString = (x) => typeof x === 'string';

function process(value) {
  if (isString(value)) {
    // value is narrowed to String here
    return value.toUpperCase();
  }
  return String(value);
}

// ============================================
// Type Narrowing — various guards
// ============================================

// ::narrow Number
// isNumber :: a -> Boolean
const isNumber = (x) => typeof x === 'number';

// narrowExample :: (Number | String) -> String
const narrowExample = (x) => {
  // typeof guards
  if (typeof x === 'string') {
    // x: String
    return x;
  }
  return String(x);
};

// nullCheck :: (Number | Null) -> Number
const nullCheck = (x) => {
  if (x != null) {
    // x: narrowed (null removed)
    return x;
  }
  return 0;
};
