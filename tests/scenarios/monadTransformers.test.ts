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
const ROOT = '/tmp/hm-scenarios-fpkit-transformers';

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

/** Lint fixture files as they are. */
function lintFixture(...rels: string[]): string[] {
  let stdout = '';
  runCli([...rels, '--project', '.'], { cwd: ROOT, stdout: (t) => { stdout += t; }, stderr: () => {} });
  return stdout.split('\n').filter((l) => / error /.test(l));
}

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  copyTree(FIXTURE, ROOT);
});

describe('the fpkit modules themselves', () => {
  test('StateT, IdT, ReaderT, FutureT (+ instances), Free and the law helpers lint clean', () => {
    expect(lintFixture(
      'src/State', 'src/Id/IdT.js', 'src/Id/IdMaybe.js', 'src/Reader', 'src/Future/FutureT.js',
      'src/Future/FutureEither.js', 'src/Free', 'src/test/laws',
    )).toEqual([]);
  });
});

describe('a transformer instance as type representative (StateEither = StateT (Either))', () => {
  test('statics are specialised to the instance monad; partial `Either String` in annotations', () => {
    expect(lint('statics', `"use strict";
const Either = require ("../Either");
const StateEither = require ("../State/StateEither");

// counter :: StateT (Either String) Number Number
const counter = StateEither.of (1);
// lifted :: StateT (Either String) Number Number
const lifted = StateEither.lift (Either.Right (1));
// label :: StateT (Either String) Number String
const label = counter.map (n => String (n));

module.exports = { counter, lifted, label };
`)).toEqual([]);
  });

  test('the wrong monad or element type is reported', () => {
    const lines = lint('staticsBad', `"use strict";
const StateEither = require ("../State/StateEither");

// wrongMonad :: StateT (Array) Number Number
const wrongMonad = StateEither.of (1);
// wrongElem :: StateT (Either String) Number String
const wrongElem = StateEither.of (1);

module.exports = { wrongMonad, wrongElem };
`);
    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(/^HM1001 Type mismatch: Cannot unify 'Either \w' with 'Array'$/);
    expect(lines[1]).toBe("HM1001 Type mismatch: Cannot unify 'Number' with 'String'");
  });


});

describe('calling a type representative (FutureEither (rej => res => …))', () => {
  test('the call uses the constructor signature with the monad fixed', () => {
    expect(lint('callRep', `"use strict";
const Either = require ("../Either");
const FutureEither = require ("../Future/FutureEither");

// ready :: FutureT (Either String) Error Number
const ready = FutureEither (_rej => res => res (Either.Right (1)));

module.exports = ready;
`)).toEqual([]);
  });

  test('resolving with something that is not the instance monad is reported', () => {
    const lines = lint('callRepBad', `"use strict";
const FutureEither = require ("../Future/FutureEither");

// bad :: FutureT (Either String) Error Number
const bad = FutureEither (_rej => res => res ([1]));

module.exports = bad;
`);
    expect(lines.join('\n')).toMatch(/Cannot unify/);
  });
});

describe('Free a (fpkit Free/index.spec.js)', () => {
  test('lifted instructions yield their element; plain values yield themselves', () => {
    expect(lint('free', `"use strict";
const Free = require ("../Free");
const Id = require ("../Id");
const Maybe = require ("../Maybe");

const { liftF } = Free;

// fromId :: Free String
const fromId = liftF (Id.of ("a"));
// fromMaybe :: Free Number
const fromMaybe = liftF (Maybe.Just (1));
// plain :: Free String
const plain = liftF ("a");
// program :: Free Number
const program = fromId.chain (s => liftF (Maybe.Just (s.length)));

module.exports = { fromId, fromMaybe, plain, program };
`)).toEqual([]);
  });

  test('a wrong result type through the program is reported', () => {
    expect(lint('freeBad', `"use strict";
const Free = require ("../Free");
const Id = require ("../Id");

// wrong :: Free Number
const wrong = Free.liftF (Id.of ("a")).map (s => s.toUpperCase ());

module.exports = wrong;
`).join('\n')).toMatch(/Cannot unify 'String' with 'Number'/);
  });
});
