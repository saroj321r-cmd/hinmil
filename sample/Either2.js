// Either2 :: Left e | Right a

// Left :: e -> Either2 e a
export function Left(value) {
  return leftOrRight(value, false)
}

// Right :: a -> Either2 e a
export function Right(value) {
  return leftOrRight(value, true)
}


// leftOrRight :: ((e | a), Boolean) -> Either2 e a
function leftOrRight(value, isRight) {

  // Either2#map :: Either2 e a ~> (a -> b) -> Either2 e b
  const map = fn => 
    isRight ? Right(fn(value)) : Left(value)

  // Either2#chain :: Either2 e a ~> (a -> Either2 e b) -> Either2 e b
  const chain = fn =>
    isRight ? fn(value) : Left(value)
  
  return {
    // Either2#value :: Either2 e a ~> a
    value,
    map,
    chain,
    // ::narrow Right
    // Either2#isRight :: Either2 e a ~> Boolean
    isRight
  }
}


// either :: (a -> c, b -> d, Either2 a b) -> c | d
const either = (f, g, e) => {
  return e.isRight ? g(e.value) : f(e.value)
}

const test1 = either(
  e => "error: " + e,
  x => "x: " + x,
  Right(42)
  )
