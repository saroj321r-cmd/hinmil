
// curry :: ((a, b, ...) -> z) -> a -> b -> ... -> z
export const curry = fn => {
  const curried = (...args) => {
    if (args.length >= fn.length) {
      return fn(...args);
    }
    return (...next) => curried(...args, ...next);
  }
  return curried;
}
