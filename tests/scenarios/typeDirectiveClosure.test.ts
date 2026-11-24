// `// ::types ./module` names the same types as importing from that module.
//
// A repository module loads the domain types with `// ::types`; the domain
// module itself loads its building blocks with `// ::types` too.  Before,
// only the first level arrived: inside the repository the nested alias
// (`RatingParams`) stayed an unknown name (HM2004 in an annotation; a bare
// constructor inside `PredictionParams`), and a service that imported the
// repository met the same alias twice — once as that bare constructor, once
// as the record — with the message "Cannot unify 'RatingParams' with
// 'RatingParams'".  Now a relative `::types` target contributes its own
// `::types` closure and its imports, exactly like an import does.

import * as fs from 'fs';
import * as path from 'path';
import { runCli } from '../../src/cli';

const ROOT = '/tmp/hm-scenarios-type-directive-closure';

function write(rel: string, body: string): void {
  const file = path.join(ROOT, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, body);
}

function lint(rel: string): string[] {
  let stdout = '';
  runCli([rel], { cwd: ROOT, stdout: (t) => { stdout += t; }, stderr: () => {} });
  return stdout.split('\n')
    .filter((l) => / error /.test(l))
    .map((l) => l.replace(/^\S+?:(\d+):\d+ error /, '$1 '));
}

beforeAll(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  write('package.json', '{ "name": "type-directive-closure" }');
  write('src/domain/rating/config.js', `// RatingParams :: { teamSd0 :: Number, homeAdvantage0 :: Number }

// defaultParams :: RatingParams
export const defaultParams = { teamSd0: 120, homeAdvantage0: 60 };
`);
  write('src/domain/prediction/config.js', `// ::types ../rating/config
import { defaultParams } from "../rating/config";

// ModelParams :: { minEv :: Number, maxOdds :: Number }
// PredictionParams :: { rating :: RatingParams, model :: ModelParams }

// withMinEv :: Number -> PredictionParams
export const withMinEv = minEv => ({ rating: defaultParams, model: { minEv, maxOdds: 12 } });
`);
  write('src/db/versions.js', `// ::types ../domain/prediction/config

// VersionRow :: { id :: Number, name :: String, params :: PredictionParams }

// readVersions :: () -> Promise Error [VersionRow]
export const readVersions = () => Promise.resolve ([]);

// homeAdvantageOf :: RatingParams -> Number
export const homeAdvantageOf = params => params.homeAdvantage0;
`);
});

describe('a relative ::types target brings its own ::types closure', () => {
  test('the nested alias is known in the module with the directive', () => {
    expect(lint('src/db/versions.js')).toEqual([]);
  });

  test('a consumer of that module sees one type, not two', () => {
    write('src/services/versions.js', `import { readVersions } from "../db/versions";

// listVersions :: () -> Promise Error [VersionRow]
export const listVersions = () => readVersions ();

// sdOf :: VersionRow -> Number
export const sdOf = v => v.params.rating.teamSd0;
`);
    expect(lint('src/services/versions.js')).toEqual([]);
  });

  test('a wrong use of the nested alias is still an error', () => {
    write('src/services/wrong.js', `import { readVersions } from "../db/versions";

// nameOfRating :: VersionRow -> String
export const nameOfRating = v => v.params.rating.teamSd0;
`);
    expect(lint('src/services/wrong.js')).toEqual([
      "4 HM1003 Type mismatch: 'nameOfRating' has type 'VersionRow -> Number' but annotation expects 'VersionRow -> String'",
    ]);
  });
});
