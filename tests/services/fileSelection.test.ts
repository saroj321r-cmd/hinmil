import * as path from 'path';
import { addExtensions, globMatches, isSelectedFile, mergeFileSelection } from '../../src/services/fileSelection';
import { isFileChecked, planFileSelectionRefresh, rootForFile } from '../../src/services/fileSelectionRefresh';

describe('file selection', () => {
  test('defaults include all supported module extensions', () => {
    expect(mergeFileSelection([]).extensions).toEqual(['.js', '.jsx', '.mjs', '.cjs', '.hm']);
  });

  test('layers replace arrays and normalize extensions', () => {
    const selection = mergeFileSelection([
      { extensions: ['JS', '.foo'], include: ['src/**'] },
      { extensions: ['bar'], exclude: ['src/generated/**'] },
    ]);
    expect(selection.extensions).toEqual(['.bar']);
    expect(selection.include).toEqual(['src/**']);
    expect(selection.exclude).toEqual(['src/generated/**']);
  });

  test('supports globstar, star and question mark', () => {
    expect(globMatches('src/a/deep/file.js', 'src/**/file.?s')).toBe(true);
    expect(globMatches('other/file.js', 'src/**')).toBe(false);
  });

  test('CLI extensions are additive and matching is root-relative', () => {
    const root = path.resolve('/project');
    const selection = addExtensions(mergeFileSelection([{ include: ['src/**'] }]), ['vue']);
    expect(isSelectedFile(path.join(root, 'src/App.vue'), root, selection)).toBe(true);
    expect(isSelectedFile(path.join(root, 'test/App.vue'), root, selection)).toBe(false);
  });

  test('an explicitly empty include selects no files', () => {
    const root = path.resolve('/project');
    const selection = mergeFileSelection([{ include: [] }]);
    expect(selection.include).toEqual([]);
    expect(isSelectedFile(path.join(root, 'src/a.js'), root, selection)).toBe(false);
  });

  test('refresh plan separates selected and excluded open documents', () => {
    const root = path.resolve('/project');
    const docs = [{ uri: 'file:///project/src/a.js' }, { uri: 'file:///project/vendor/b.js' }];
    const plan = planFileSelectionRefresh(docs, [
      { path: root, active: true, fileSelection: mergeFileSelection([{ exclude: ['vendor/**'] }]) },
    ]);
    expect(plan.validate.map(doc => doc.uri)).toEqual([docs[0].uri]);
    expect(plan.clear.map(doc => doc.uri)).toEqual([docs[1].uri]);
  });
});

describe('workspace folders (multi-root)', () => {
  const shop = path.resolve('/work/shop');
  const billing = path.resolve('/work/billing');
  const legacy = path.resolve('/work/legacy');
  const roots = [
    { path: shop, active: true, fileSelection: mergeFileSelection([]) },
    // Its own `files`: only `lib/` is checked there.
    { path: billing, active: true, fileSelection: mergeFileSelection([{ include: ['lib/**'] }]) },
    // `"enable": false` in its configuration.
    { path: legacy, active: false, fileSelection: mergeFileSelection([]) },
  ];

  test('a file belongs to the folder that contains it', () => {
    expect(rootForFile(path.join(shop, 'src/cart.js'), roots)?.path).toBe(shop);
    expect(rootForFile(path.join(billing, 'lib/invoice.js'), roots)?.path).toBe(billing);
    expect(rootForFile(path.resolve('/elsewhere/a.js'), roots)).toBeUndefined();
    // A sibling whose name starts with a folder's name is not inside it.
    expect(rootForFile(path.resolve('/work/shop-old/a.js'), roots)).toBeUndefined();
  });

  test('nested folders: the deepest folder wins', () => {
    const nested = [...roots, { path: path.join(shop, 'admin'), active: true, fileSelection: mergeFileSelection([]) }];
    expect(rootForFile(path.join(shop, 'admin/users.js'), nested)?.path).toBe(path.join(shop, 'admin'));
    expect(rootForFile(path.join(shop, 'src/cart.js'), nested)?.path).toBe(shop);
  });

  test('every folder is checked with its own file selection', () => {
    expect(isFileChecked(path.join(shop, 'src/cart.js'), roots)).toBe(true);
    expect(isFileChecked(path.join(billing, 'lib/invoice.js'), roots)).toBe(true);
    expect(isFileChecked(path.join(billing, 'scripts/once.js'), roots)).toBe(false);
  });

  test('a switched-off folder and files outside every folder are not checked', () => {
    expect(isFileChecked(path.join(legacy, 'src/old.js'), roots)).toBe(false);
    expect(isFileChecked(path.resolve('/elsewhere/a.js'), roots)).toBe(false);
  });

  test('the refresh plan covers documents of every folder', () => {
    const uri = (file: string) => `file://${file}`;
    const docs = [
      { uri: uri(path.join(shop, 'src/cart.js')) },
      { uri: uri(path.join(billing, 'lib/invoice.js')) },
      { uri: uri(path.join(billing, 'scripts/once.js')) },
      { uri: uri(path.join(legacy, 'src/old.js')) },
    ];
    const plan = planFileSelectionRefresh(docs, roots);
    expect(plan.validate.map(doc => doc.uri)).toEqual([docs[0].uri, docs[1].uri]);
    expect(plan.clear.map(doc => doc.uri)).toEqual([docs[2].uri, docs[3].uri]);
  });
});
