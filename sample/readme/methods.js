// ============================================
// Method Annotations — constructors, instance & static methods
// ============================================

// Box :: a -> Box a
const Box = (value) => ({
  // Box#value :: Box a ~> a
  value,

  // Box#map :: Box a ~> (a -> b) -> Box b
  map(fn) { return Box(fn(this.value)); },

  // Box#inspect :: Box a ~> () -> String
  inspect() { return `Box(${this.value})`; },
});

// Box.of :: a -> Box a
Box.of = (value) => Box(value);

// boxMap :: (a -> b, Box a) -> Box b
const boxMap = (fn, box) => box.map(fn);

// createBox :: a -> Box a
const createBox = value => {
  return {
    value: value,
    map: fn => createBox(fn(value)),
    inspect: () => `Box(${value})`
  }
}