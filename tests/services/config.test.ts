import {
  HinMilSettings,
  defaultSettings,
  normalizeTrustAnnotations,
  mergeSettings,
  DIAGNOSTIC_LEVELS,
} from '../../src/config';

describe('config', () => {
  it('defaultSettings has expected shape', () => {
    expect(defaultSettings.diagnostics.enabled).toBe(true);
    expect(defaultSettings.diagnostics.debounceMs).toBe(500);
    expect(defaultSettings.diagnostics.trustAnnotations).toBe('off');
    expect(defaultSettings.diagnostics.typeErrors).toBe('error');
    expect(defaultSettings.diagnostics.unknownPropertyAccess).toBe('error');
    expect(defaultSettings.diagnostics.missingRecordFields).toBe('error');
    expect(defaultSettings.diagnostics.annotationNarrowing).toBe('error');
    expect(defaultSettings.diagnostics.missingSignatures).toBe('information');
    expect(defaultSettings.diagnostics.missingVariableSignatures).toBe('off');
    expect(defaultSettings.hover.enabled).toBe(true);
    expect(defaultSettings.completion.enabled).toBe(true);
    expect(defaultSettings.completion.autoImports).toBe(true);
    expect(defaultSettings.signatureHelp.enabled).toBe(true);
    expect(defaultSettings.display.typeVariables).toBe('pretty');
  });

  it('defaultSettings is not frozen — can be spread', () => {
    const copy: HinMilSettings = { ...defaultSettings };
    expect(copy.diagnostics.enabled).toBe(true);
  });

  it('DIAGNOSTIC_LEVELS contains exactly the severity-or-off values', () => {
    expect([...DIAGNOSTIC_LEVELS].sort()).toEqual(
      ['error', 'hint', 'information', 'off', 'warning'],
    );
  });
});

describe('normalizeTrustAnnotations', () => {
  it('passes through valid level strings', () => {
    for (const lvl of ['off', 'signatures', 'annotated-bodies', 'all-bodies'] as const) {
      expect(normalizeTrustAnnotations(lvl)).toBe(lvl);
    }
  });
  it('falls back to "off" for booleans (legacy values no longer accepted) and warns', () => {
    const warnings: string[] = [];
    expect(normalizeTrustAnnotations(true, (m) => warnings.push(m))).toBe('off');
    expect(normalizeTrustAnnotations(false, (m) => warnings.push(m))).toBe('off');
    expect(warnings).toHaveLength(2);
  });
  it('falls back to "off" for unknown strings and warns', () => {
    const warnings: string[] = [];
    expect(normalizeTrustAnnotations('bogus', (m) => warnings.push(m))).toBe('off');
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('bogus');
  });
  it('returns "off" for undefined without warning', () => {
    const warnings: string[] = [];
    expect(normalizeTrustAnnotations(undefined, (m) => warnings.push(m))).toBe('off');
    expect(warnings).toHaveLength(0);
  });
});

describe('mergeSettings', () => {
  it('no layers → defaults (fresh object, not the defaults instance)', () => {
    const s = mergeSettings([]);
    expect(s).toEqual(defaultSettings);
    expect(s).not.toBe(defaultSettings);
    expect(s.diagnostics).not.toBe(defaultSettings.diagnostics);
  });

  it('empty / null / undefined layers → defaults, no warnings', () => {
    const warnings: string[] = [];
    const s = mergeSettings([{}, null, undefined], (m) => warnings.push(m));
    expect(s).toEqual(defaultSettings);
    expect(warnings).toHaveLength(0);
  });

  it('partial layer overrides only the specified fields', () => {
    const s = mergeSettings([{ diagnostics: { typeErrors: 'warning' } }]);
    expect(s.diagnostics.typeErrors).toBe('warning');
    expect(s.diagnostics.unknownPropertyAccess).toBe('error');
    expect(s.diagnostics.missingSignatures).toBe('information');
    expect(s.completion.autoImports).toBe(true);
  });

  it('later layers win over earlier ones (project file over editor)', () => {
    const editor = { diagnostics: { typeErrors: 'off', missingSignatures: 'warning' } };
    const project = { diagnostics: { typeErrors: 'hint' } };
    const s = mergeSettings([editor, project]);
    expect(s.diagnostics.typeErrors).toBe('hint');            // project wins
    expect(s.diagnostics.missingSignatures).toBe('warning');  // editor kept
  });

  it('merges every settings group', () => {
    const s = mergeSettings([{
      diagnostics: { enabled: false, debounceMs: 100, trustAnnotations: 'signatures' },
      hover: { enabled: false },
      completion: { enabled: false, autoImports: false },
      signatureHelp: { enabled: false },
      display: { typeVariables: 'raw' },
    }]);
    expect(s.diagnostics.enabled).toBe(false);
    expect(s.diagnostics.debounceMs).toBe(100);
    expect(s.diagnostics.trustAnnotations).toBe('signatures');
    expect(s.hover.enabled).toBe(false);
    expect(s.completion.enabled).toBe(false);
    expect(s.completion.autoImports).toBe(false);
    expect(s.signatureHelp.enabled).toBe(false);
    expect(s.display.typeVariables).toBe('raw');
  });

  it('invalid enum value → warning, previous value kept', () => {
    const warnings: string[] = [];
    const s = mergeSettings(
      [{ diagnostics: { typeErrors: 'Error' } }], // old capitalized style
      (m) => warnings.push(m),
    );
    expect(s.diagnostics.typeErrors).toBe('error'); // default kept
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('diagnostics.typeErrors');
  });

  it('invalid boolean / number values → warning, previous value kept', () => {
    const warnings: string[] = [];
    const s = mergeSettings(
      [{ diagnostics: { enabled: 'yes', debounceMs: -5 }, hover: { enabled: 1 } }],
      (m) => warnings.push(m),
    );
    expect(s.diagnostics.enabled).toBe(true);
    expect(s.diagnostics.debounceMs).toBe(500);
    expect(s.hover.enabled).toBe(true);
    expect(warnings).toHaveLength(3);
  });

  it('unknown keys → warning, ignored', () => {
    const warnings: string[] = [];
    const s = mergeSettings(
      [{ diagnostics: { ignoreUnifyProblems: true }, inferredTypeStyle: 'raw' }],
      (m) => warnings.push(m),
    );
    expect(s).toEqual(defaultSettings);
    expect(warnings).toHaveLength(2);
    expect(warnings.join('\n')).toContain('ignoreUnifyProblems');
    expect(warnings.join('\n')).toContain('inferredTypeStyle');
  });

  it('client-only groups (syntaxHighlighting, trace) are silently ignored', () => {
    const warnings: string[] = [];
    const s = mergeSettings(
      [{ syntaxHighlighting: { enabled: false }, trace: { server: 'verbose' } }],
      (m) => warnings.push(m),
    );
    expect(s).toEqual(defaultSettings);
    expect(warnings).toHaveLength(0);
  });

  it('non-object layer → warning, skipped', () => {
    const warnings: string[] = [];
    const s = mergeSettings(['nope', 42, []], (m) => warnings.push(m));
    expect(s).toEqual(defaultSettings);
    expect(warnings).toHaveLength(3);
  });

  it('null field values are treated as "not specified"', () => {
    const s = mergeSettings([{ diagnostics: { typeErrors: null, enabled: null } }]);
    expect(s.diagnostics.typeErrors).toBe('error');
    expect(s.diagnostics.enabled).toBe(true);
  });
});
