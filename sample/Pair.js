// Pair :: (a, b) -> Pair a b
function Pair(fst, snd) {
  // Pair#fst :: Pair a b ~> a
  this.fst = fst;

  // Pair#snd :: Pair a b ~> b
  this.snd = snd;
}

const p = new Pair(1, 2);
const cp = new p.constructor(1, 2);

export default Pair
