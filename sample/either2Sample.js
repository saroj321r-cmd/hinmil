// ::types ./Either2

// either :: (a -> c, b -> d, Either2 a b) -> c | d
const either = (f, g, e) => {
  return e.isRight ? g(e.value) : f(e.value)
}