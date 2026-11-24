// Result :: Err e | Warn w | Ok a
// Result#$value :: Result e w a ~> (e | w | a)
// Result#map :: Result e w a ~> (a -> b) -> Result e w b
// Result#chain :: Result e w a ~> (a -> Result e w b) -> Result e w b
// Result.of :: a -> Result e w a

class Result {
  constructor(x) {
    this.$value = x;
  }

  static of(x) {
    return new Ok(x);
  }
}

// Err :: e -> Result e w a
class Err extends Result {
  // ::narrow Err
  // Result#isErr :: Result e w a ~> Boolean
  get isErr() {
    return true;
  }

  // ::narrow Warn
  // Result#isWarn :: Result e w a ~> Boolean
  get isWarn() {
    return false;
  }

  // ::narrow Ok
  // Result#isOk :: Result e w a ~> Boolean
  get isOk() {
    return false;
  }

  map(_fn) {
    return new Err(this.$value);
  }

  chain(_fn) {
    return new Err(this.$value);
  }
}

// Warn :: w -> Result e w a
class Warn extends Result {
  get isErr() {
    return false;
  }

  get isWarn() {
    return true;
  }

  get isOk() {
    return false;
  }

  map(_fn) {
    return new Warn(this.$value);
  }

  chain(_fn) {
    return new Warn(this.$value);
  }
}

// Ok :: a -> Result e w a
class Ok extends Result {
  get isErr() {
    return false;
  }

  get isWarn() {
    return false;
  }

  get isOk() {
    return true;
  }

  map(fn) {
    return Result.of(fn(this.$value));
  }

  chain(fn) {
    return fn(this.$value);
  }
}

// getNonError :: Result String Number Boolean -> (Number | Boolean)
const getNonError = (r) => {
  if (r.isErr) {
    return 0;
  }
  return r.$value;
};

// getError :: Result String Number Boolean -> String
const getError = (r) => {
  if (r.isErr) {
    return r.$value;
  }
  return "default";
};

// getValue :: Result String Number Boolean -> Boolean
const getValue = (r) => {
  if (r.isErr) {
    return false;
  }
  if (r.isWarn) {
    return false
  }
  return r.$value;
};
