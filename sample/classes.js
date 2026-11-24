// Animal :: String -> Animal
function Animal (name) {
  // Animal#name :: String
  this.name = name;
}

// Animal.create :: String -> Animal
Animal.create = function (name) {
  return new Animal(name);
}

// Animal#speak :: (b) -> String
Animal.prototype.speak = function (b) {
  return this.name
}

// dog :: Animal
var dog = Animal.create('dog')

// Building :: (String, Number) -> Building
class Building {
  constructor (name, floors) { 
    // Building#name :: String
    this.name = name;

    // Building#floors :: Number
    this.floors = floors;
  }

  // Building#info :: () -> String
  info () {
    return this.name + ' has ' + this.floors + ' floors.'
  }

  // ::private
  // Building#unknown :: () -> Void
  unknown() {
    console.log("unknown");
  }

  // Building.create :: (String, Number) -> Building
  static create (name, floors) {
    return new Building(name, floors);
  }
}

const building = Building.create('Empire State', 102);
const buildingInfo = building.info()

// createBuilding :: (String, Number) -> Building
const createBuilding = (name, floors) => {
  return new Building(name, floors);
}

// makeBuildingFromBuilding :: Building -> Building
const makeBuildingFromBuilding = (building) => {
  return building.constructor.create(building.name, building.floors);
}
