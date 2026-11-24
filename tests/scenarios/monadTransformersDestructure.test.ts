// (Own file: needs fresh module state — an earlier lint in the same
// process can warm caches that type this case through another path.)
// Monad transformers and Free on REAL fpkit code (fixture:
// tests/fixtures/scenarios/fp-library).
// fpkit's transformers were re-annotated in the
// form hinmil supports:
//
//   _T :: Monad m => TypeRep m -> TypeRep (StateT m s)     (factory)
//   StateT#map :: Monad m => StateT m s a ~> (a -> b) -> StateT m s b
//   StateEither :: TypeRep (StateT (Either e) s)            (instance)
//   Free a, liftF :: Functor f => f a -> Free a, go :: … (forall x. m x -> u x) -> u a
//
// Each consumer module below is modeled on the real fpkit specs and is linted
// through the CLI inside a copy of the fixture project.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const FIXTURE = path.join(__dirname, '..', 'fixtures', 'scenarios', 'fp-library');
const ROOT = '/tmp/hm-scenarios-fpkit-destructure';

function copyTree(from: string, to: string): void {
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    if (e.isDirectory()) copyTree(path.join(from, e.name), path.join(to, e.name));
    else fs.copyFileSync(path.join(from, e.name), path.join(to, e.name));
  }
}

/** Lint `src/scenario/<name>.js`; return `CODE message` per error. */
function lint(name: string, source: string): string[] {
  const rel = `src/scenario/${name}.js`;
  fs.mkdirSync(path.join(ROOT, 'src/scenario'), { recursive: true });
  fs.writeFileSync(path.join(ROOT, rel), source);
  let stdout = '';
  runCli([rel, '--project', '.'], { cwd: ROOT, stdout: (t) => { stdout += t; }, stderr: () => {} });
  return stdout.split('\n').filter((l) => / error /.test(l)).map((l) => l.replace(/^\S+ error /, ''));
}

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  copyTree(FIXTURE, ROOT);
});

describe('fpkit transformer instance', () => {
  test('destructured statics (`const { lift } = IdMaybe`, as in IdMaybe.spec) are typed', () => {
    expect(lint('destructure', `"use strict";
const IdMaybe = require ("../Id/IdMaybe");
const Maybe = require ("../Maybe");

const { Just } = Maybe;
const { lift } = IdMaybe;

// wrongLift :: IdT (Maybe) String
const wrongLift = lift (Just (1));

module.exports = wrongLift;
`)).toEqual(["HM1001 Type mismatch: Cannot unify 'Number' with 'String'"]);
  });
});
