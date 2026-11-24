// ============================================================================
// Project-file configuration tests
//
// 1. loadProjectConfig — file-based discovery: package.json "hinmil" key,
//    hinmil.config.js / hinmil.config.json fallbacks, malformed input.
// 2. Schema sync — the `contributes.configuration` block in package.json
//    must stay 1-on-1 in sync with `defaultSettings` (keys, defaults and
//    enum values), so the manifest can never drift from the code again.
// ============================================================================

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

import { loadProjectConfig } from '../../src/services/globalsLoader';
import {
  defaultSettings,
  hasProjectConfig,
  DIAGNOSTIC_LEVELS,
  HinMilSettings,
} from '../../src/config';
import {
  DEFAULT_FILE_EXCLUDE,
  DEFAULT_FILE_EXTENSIONS,
  DEFAULT_FILE_INCLUDE,
} from '../../src/services/fileSelection';

// ---------------------------------------------------------------------------
// loadProjectConfig — file-based discovery
// ---------------------------------------------------------------------------

describe('loadProjectConfig', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-project-config-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('empty directory → {}', () => {
    expect(loadProjectConfig(root)).toEqual({});
  });

  test('reads the "hinmil" key from package.json', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'x',
      'hinmil': { globals: ['./globals.hm'], typesDir: 'types' },
    }));
    expect(loadProjectConfig(root)).toEqual({ globals: ['./globals.hm'], typesDir: 'types' });
  });

  test('package.json without "hinmil" key falls through to hinmil.config.json', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'x' }));
    fs.writeFileSync(path.join(root, 'hinmil.config.json'), JSON.stringify({
      overrides: { sqlkit: './hm-types/sqlkit.hm' },
    }));
    expect(loadProjectConfig(root)).toEqual({ overrides: { sqlkit: './hm-types/sqlkit.hm' } });
  });

  test('hinmil.config.js (module.exports object) is parsed', () => {
    fs.writeFileSync(path.join(root, 'hinmil.config.js'),
      `module.exports = {"globals": ["./g.hm"]}\n`);
    expect(loadProjectConfig(root)).toEqual({ globals: ['./g.hm'] });
  });

  test('hinmil.config.js wins over hinmil.config.json (search order)', () => {
    fs.writeFileSync(path.join(root, 'hinmil.config.js'),
      `module.exports = {"typesDir": "from-js"}\n`);
    fs.writeFileSync(path.join(root, 'hinmil.config.json'),
      JSON.stringify({ typesDir: 'from-json' }));
    expect(loadProjectConfig(root)).toEqual({ typesDir: 'from-js' });
  });

  test('package.json "hinmil" key wins over standalone config files', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      'hinmil': { typesDir: 'from-pkg' },
    }));
    fs.writeFileSync(path.join(root, 'hinmil.config.json'),
      JSON.stringify({ typesDir: 'from-json' }));
    expect(loadProjectConfig(root)).toEqual({ typesDir: 'from-pkg' });
  });

  test('malformed JSON config → {}', () => {
    fs.writeFileSync(path.join(root, 'hinmil.config.json'), '{ not: valid json');
    expect(loadProjectConfig(root)).toEqual({});
  });

  test('malformed package.json falls through to standalone config', () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{ broken');
    fs.writeFileSync(path.join(root, 'hinmil.config.json'), JSON.stringify({ typesDir: 't' }));
    expect(loadProjectConfig(root)).toEqual({ typesDir: 't' });
  });

  test('exposes the "settings" key for editor-settings overrides', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      'hinmil': {
        globals: ['./g.hm'],
        settings: { diagnostics: { typeErrors: 'warning', missingSignatures: 'off' } },
      },
    }));
    const config = loadProjectConfig(root);
    expect(config.settings).toEqual({
      diagnostics: { typeErrors: 'warning', missingSignatures: 'off' },
    });
  });
});

// ---------------------------------------------------------------------------
// hasProjectConfig — used by the extension client for `hinmil.requiresConfig`
// ---------------------------------------------------------------------------

describe('hasProjectConfig', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'hm-has-config-'));
  });
  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  test('empty directory → false', () => {
    expect(hasProjectConfig(root)).toBe(false);
  });

  test('package.json without "hinmil" key → false', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'server' }));
    expect(hasProjectConfig(root)).toBe(false);
  });

  test('package.json with "hinmil" object key → true', () => {
    fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({
      name: 'server',
      'hinmil': { globals: ['./globals.hm'] },
    }));
    expect(hasProjectConfig(root)).toBe(true);
  });

  test('standalone hinmil.config.json → true', () => {
    fs.writeFileSync(path.join(root, 'hinmil.config.json'), JSON.stringify({
      globals: ['./server/globals.hm'],
      typesDir: 'server/hm-types',
    }));
    expect(hasProjectConfig(root)).toBe(true);
  });

  test('standalone hinmil.config.js → true', () => {
    fs.writeFileSync(path.join(root, 'hinmil.config.js'),
      `module.exports = {"globals": ["./globals.hm"]}\n`);
    expect(hasProjectConfig(root)).toBe(true);
  });

  test('malformed package.json without standalone config → false', () => {
    fs.writeFileSync(path.join(root, 'package.json'), '{ broken');
    expect(hasProjectConfig(root)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Schema sync — package.json contributes.configuration ↔ defaultSettings
// ---------------------------------------------------------------------------

interface ManifestProperty {
  type: string;
  default: unknown;
  enum?: string[];
}

describe('package.json configuration schema sync', () => {
  const pkg = JSON.parse(fs.readFileSync(
    path.resolve(__dirname, '..', '..', 'package.json'), 'utf-8',
  ));
  const properties: Record<string, ManifestProperty> =
    pkg.contributes.configuration.properties;

  /** Settings handled by the client only — not part of the server's
   *  HinMilSettings object. */
  const CLIENT_ONLY = new Set([
    'hinmil.enable',
    'hinmil.requiresConfig',
    'hinmil.syntaxHighlighting.enabled',
    'hinmil.trace.server',
  ]);
  const FILE_DEFAULTS = new Map<string, unknown>([
    ['hinmil.files.extensions', [...DEFAULT_FILE_EXTENSIONS]],
    ['hinmil.files.include', [...DEFAULT_FILE_INCLUDE]],
    ['hinmil.files.exclude', [...DEFAULT_FILE_EXCLUDE]],
  ]);

  /** Flatten defaultSettings to "hinmil.<group>.<field>" → default value. */
  function flattenDefaults(): Map<string, unknown> {
    const out = new Map<string, unknown>();
    for (const [group, fields] of Object.entries(defaultSettings)) {
      for (const [field, value] of Object.entries(fields as Record<string, unknown>)) {
        out.set(`hinmil.${group}.${field}`, value);
      }
    }
    return out;
  }

  test('every server setting is declared in the manifest', () => {
    for (const key of flattenDefaults().keys()) {
      expect(Object.keys(properties)).toContain(key);
    }
  });

  test('every manifest property maps to a server setting, file selection, or is client-only', () => {
    const supported = new Set([...flattenDefaults().keys(), ...FILE_DEFAULTS.keys()]);
    for (const key of Object.keys(properties)) {
      if (CLIENT_ONLY.has(key)) continue;
      expect(supported).toContain(key);
    }
  });

  test('manifest defaults match runtime defaults', () => {
    const defaults = new Map([...flattenDefaults(), ...FILE_DEFAULTS]);
    for (const [key, prop] of Object.entries(properties)) {
      if (CLIENT_ONLY.has(key)) continue;
      expect({ key, default: prop.default }).toEqual({ key, default: defaults.get(key) });
    }
  });

  test('severity-or-off enums list exactly the DiagnosticLevel values', () => {
    const levelKeys: Array<keyof HinMilSettings['diagnostics']> = [
      'typeErrors', 'unknownPropertyAccess', 'missingRecordFields',
      'annotationNarrowing', 'missingSignatures', 'missingVariableSignatures',
    ];
    for (const field of levelKeys) {
      const prop = properties[`hinmil.diagnostics.${field}`];
      expect(prop).toBeDefined();
      expect(prop.enum).toEqual(['off', 'hint', 'information', 'warning', 'error']);
      expect(prop.enum!.slice().sort()).toEqual([...DIAGNOSTIC_LEVELS].sort());
    }
  });

  test('trustAnnotations enum matches the TrustAnnotationsLevel values', () => {
    const prop = properties['hinmil.diagnostics.trustAnnotations'];
    expect(prop.enum).toEqual(['off', 'signatures', 'annotated-bodies', 'all-bodies']);
  });

  test('display.typeVariables enum matches the code', () => {
    const prop = properties['hinmil.display.typeVariables'];
    expect(prop.enum).toEqual(['pretty', 'raw']);
  });
});

// ---------------------------------------------------------------------------
// Schema sync — schemas/hinmil.config.schema.json ↔ defaultSettings
// ---------------------------------------------------------------------------

interface SchemaProperty {
  type?: string;
  default?: unknown;
  enum?: string[];
  $ref?: string;
  properties?: Record<string, SchemaProperty>;
}

describe('config JSON schema sync', () => {
  const schemaPath = path.resolve(__dirname, '..', '..', 'schemas', 'hinmil.config.schema.json');
  const schema = JSON.parse(fs.readFileSync(schemaPath, 'utf-8'));
  const settingsDef: SchemaProperty = schema.definitions.settings;
  const diagnosticLevelDef: SchemaProperty = schema.definitions.diagnosticLevel;

  test('jsonValidation contributions point at existing schema files', () => {
    const pkg = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'package.json'), 'utf-8',
    ));
    const validations: Array<{ fileMatch: string; url: string }> =
      pkg.contributes.jsonValidation;
    expect(validations.map(v => v.fileMatch).sort()).toEqual(
      ['hinmil.config.json', 'package.json'],
    );
    for (const v of validations) {
      const file = path.resolve(__dirname, '..', '..', v.url);
      expect(fs.existsSync(file)).toBe(true);
    }
  });

  test('schema root declares every project-config key', () => {
    expect(Object.keys(schema.properties).sort()).toEqual(
      ['enable', 'files', 'globals', 'overrides', 'settings', 'typesDir'],
    );
  });

  test('settings definition covers exactly the defaultSettings groups and fields', () => {
    const groups = settingsDef.properties!;
    expect(Object.keys(groups).sort()).toEqual(Object.keys(defaultSettings).sort());
    for (const [group, fields] of Object.entries(defaultSettings)) {
      const groupProps = groups[group].properties!;
      expect(Object.keys(groupProps).sort())
        .toEqual(Object.keys(fields as Record<string, unknown>).sort());
    }
  });

  test('schema defaults match defaultSettings', () => {
    const groups = settingsDef.properties!;
    for (const [group, fields] of Object.entries(defaultSettings)) {
      for (const [field, value] of Object.entries(fields as Record<string, unknown>)) {
        const prop = groups[group].properties![field];
        expect({ key: `${group}.${field}`, default: prop.default })
          .toEqual({ key: `${group}.${field}`, default: value });
      }
    }
  });

  test('diagnosticLevel enum matches DiagnosticLevel values', () => {
    expect(diagnosticLevelDef.enum).toEqual(['off', 'hint', 'information', 'warning', 'error']);
    expect(diagnosticLevelDef.enum!.slice().sort()).toEqual([...DIAGNOSTIC_LEVELS].sort());
  });

  test('severity-or-off fields reference the diagnosticLevel definition', () => {
    const levelKeys: Array<keyof HinMilSettings['diagnostics']> = [
      'typeErrors', 'unknownPropertyAccess', 'missingRecordFields',
      'annotationNarrowing', 'missingSignatures', 'missingVariableSignatures',
    ];
    const diag = settingsDef.properties!.diagnostics.properties!;
    for (const field of levelKeys) {
      expect(diag[field].$ref).toBe('#/definitions/diagnosticLevel');
    }
  });

  test('trustAnnotations enum matches the TrustAnnotationsLevel values', () => {
    const diag = settingsDef.properties!.diagnostics.properties!;
    expect(diag.trustAnnotations.enum).toEqual(['off', 'signatures', 'annotated-bodies', 'all-bodies']);
  });

  test('package.json schema settings key references the config schema', () => {
    const pkgSchema = JSON.parse(fs.readFileSync(
      path.resolve(__dirname, '..', '..', 'schemas', 'package-hinmil.schema.json'), 'utf-8',
    ));
    const hinMil = pkgSchema.properties['hinmil'];
    expect(Object.keys(hinMil.properties).sort()).toEqual(
      ['enable', 'files', 'globals', 'overrides', 'settings', 'sidecars', 'typesDir'],
    );
    expect(hinMil.properties.settings.$ref)
      .toBe('./hinmil.config.schema.json#/definitions/settings');
    expect(hinMil.properties.files.$ref)
      .toBe('./hinmil.config.schema.json#/definitions/fileSelection');
  });
});
