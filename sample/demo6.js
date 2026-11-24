// ============================================================================
// demo6.js — Ramda-style lenses
//
// Hover any binding to see the inferred type.  This file showcases:
//   1. lensProp(key) — label-polymorphic property lens
//   2. lensIndex(i)  — array-element lens
//   3. view, set, over — the three lens operations
//   4. composeL      — chaining lenses through nested structure
//   5. Hand-rolled lenses via lens(getter, setter) (e.g. derived /
//      computed lenses)
//
// Implementation lives in ./lens.js.  Lenses are immutable updates:
// `set` and `over` always return a new value, never mutate.
// ============================================================================

import { lens, view, set, over, composeL, lensProp, lensIndex } from './lens.js';

// -----------------------------------------------------------------------
// 1. Property lenses via lensProp
// -----------------------------------------------------------------------

// nameLens and ageLens are label-polymorphic — they work on any record
// containing a `name` (resp. `age`) field.  Hover them to see the
// inferred row-poly type.
const nameLens = lensProp("name");
const ageLens  = lensProp("age");

const alice = { name: "Alice", age: 30, email: "alice@example.com" };

// view returns the value at the focus
const aliceName = view(nameLens, alice);
const aliceAge  = view(ageLens, alice);

// set returns the full record with the focused field replaced
const renamed = set(nameLens, "Alicia", alice);
const aged    = set(ageLens, 31, alice);

// over applies a function at the focus, preserving the surrounding shape
const upperName = over(nameLens, s => s.toUpperCase(), alice);
const nextYear  = over(ageLens, n => n + 1, alice);


// -----------------------------------------------------------------------
// 2. Composing lenses to focus through nested records
// -----------------------------------------------------------------------

// composeL chains two lenses through an intermediate part `b`:
// composeL(outer, inner) reaches from the outer whole into the inner
// part inside it.  Setting through the composition rebuilds the entire
// chain immutably.
const addrLens   = lensProp("addr");
const streetLens = lensProp("street");
const addrStreet = composeL(addrLens, streetLens);

const company = {
  name: "Acme",
  addr: { street: "Main 1", city: "Brussels", zip: 1000 },
};

company.sector = "manufacturing";

// Read deep into the structure
const street = view(addrStreet, company);

// Set deep, preserving the rest of the structure
const moved = set(addrStreet, "Rue de la Loi 16", company);

// Update deep with a function
const shouted = over(addrStreet, s => s.toUpperCase(), company);


// -----------------------------------------------------------------------
// 3. Array-element lenses via lensIndex
// -----------------------------------------------------------------------

const headLens   = lensIndex(0);
const secondLens = lensIndex(1);

const xs   = [10, 20, 30];
const head = view(headLens, xs);
const xs2  = set(headLens, 99, xs);
const xs3  = over(secondLens, n => n * 10, xs);


// -----------------------------------------------------------------------
// 4. Mixed composition — property lens + array-index lens
// -----------------------------------------------------------------------

const itemsLens = lensProp("items");
const firstItem = composeL(itemsLens, headLens);

const inventory = {
  owner: "warehouse-A",
  items: [{ sku: "x1", qty: 5 }, { sku: "x2", qty: 9 }],
};

const top = view(firstItem, inventory);
const inv2 = set(firstItem, { sku: "x9", qty: 1 }, inventory);


// -----------------------------------------------------------------------
// 5. Hand-rolled lens — focus on a derived view of a record
// -----------------------------------------------------------------------

// fullNameLens is a derived lens: its getter joins firstName + lastName
// into a single String, and its setter splits a String back into the
// two underlying fields.  Building it via the bare lens(getter, setter)
// constructor lets you encode arbitrary projections.
const fullNameLens = lens(
  (p) => p.firstName + " " + p.lastName,
  (full, p) => {
    const parts = full.split(" ");
    return ({ ...p, firstName: parts[0], lastName: parts[1] });
  },
);

const grace = { firstName: "Grace", lastName: "Hopper", born: 1906 };
const greeting = view(fullNameLens, grace);
const renamedG = set(fullNameLens, "Ada Lovelace", grace);


// -----------------------------------------------------------------------
// 6. Re-using a single property lens across different record shapes
// -----------------------------------------------------------------------

// nameLens is fully polymorphic in the record shape (only requires a
// `name` field) — calling view(nameLens, ...) against two different
// records works without re-creating the lens.
const team    = { name: "platform", size: 7 };
const product = { name: "hinmil", version: "0.1.0" };

const teamName    = view(nameLens, team);
const productName = view(nameLens, product);
