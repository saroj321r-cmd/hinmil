// A parameter of an HTTP route: taken from the URL path or from the query
// string, with the checks it must pass and a fallback value.  A sum type
// written with prototype objects and `Object.create`, with factories that
// are reachable under several names (chained annotations), two of them
// hidden from completion.
// Param :: Path a b c | Query a b c
export const Param = {}

const ParamAlias = {}

const ParamAlias2 = {}

const PARAM_TYPE = "http/Param";

const Path$prototype = {
  constructor: Param,
  caseOf: Path$prototype$caseOf,
  "@@type": PARAM_TYPE
};

const Query$prototype = {
  constructor: Param,
  caseOf: Query$prototype$caseOf,
  "@@type": PARAM_TYPE
};

// A path parameter without checks.
// Param.of :: () -> Param a b c
Param.of = function() {
  return Path("id", [], undefined);
}


// ::hidden ParamAlias.Path
// ::hidden ParamAlias2.Path
// Path :: Param.Path :: ParamAlias.Path :: ParamAlias2.Path :: (a, [b], c) -> Param a b c
export const Path = Param.Path = ParamAlias.Path = ParamAlias2.Path = (name, checks = [], fallback = undefined) => {
  const param = Object.create (Path$prototype);
  // Param#name :: Param a b c ~> a
  param.name = name;

  // Param#checks :: Param a b c ~> [b]
  param.checks = checks;

  // Param#fallback :: Param a b c ~> c
  param.fallback = fallback;
  return param;
};

// Query :: Param.Query :: (String | Number) b => (a, [b], c) -> Param a b c
export const Query = Param.Query = (name, checks = [], fallback) => {
  const param = Object.create (Query$prototype);
  param.name = name;
  param.checks = checks;
  param.fallback = fallback;
  return param;
};

// Param#caseOf :: Param a b c ~> { Path :: (a, [b], c) -> r, Query :: (a, [b], c) -> r}

// ::ignore
function Path$prototype$caseOf(cases) {
  return cases.Path (this.name, this.checks, this.fallback);
}

// ::ignore
function Query$prototype$caseOf(cases) {
  return cases.Query (this.name, this.checks, this.fallback);
}

const checks = [1, "2"]

const path = Path("invoiceId", checks)

const path2 = Param.Path("customerId", [1, "3"], undefined)

const query = Query("page", checks, undefined)

const query2 = Param.Query("pageSize", checks, undefined)
