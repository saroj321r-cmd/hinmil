
// String#equals :: String ~> String -> Boolean
String.prototype["equals"] = function(other) {
  return this.valueOf() === other.valueOf();
}