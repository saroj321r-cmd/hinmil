import * as path from 'path';
import { fileURLToPath } from 'url';
import { FileSelection, isSelectedFile } from './fileSelection';

export interface OpenDocumentLike { uri: string }
export interface FileSelectionRefresh<T extends OpenDocumentLike> {
  validate: T[];
  clear: T[];
}

/** A workspace folder as the server sees it: its own file selection, and
 *  whether it is checked at all (its configuration can switch it off). */
export interface SelectionRoot {
  path: string;
  active: boolean;
  fileSelection: FileSelection;
}

/** The workspace folder a file belongs to: the deepest folder that contains
 *  it (folders of a multi-root workspace may be nested), or `undefined`. */
export function rootForFile<R extends { path: string }>(filePath: string, roots: readonly R[]): R | undefined {
  const absolute = path.resolve(filePath);
  let best: R | undefined;
  for (const root of roots) {
    const relative = path.relative(path.resolve(root.path), absolute);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) continue;
    if (!best || root.path.length > best.path.length) best = root;
  }
  return best;
}

/** Is this file checked: inside an active workspace folder and selected by
 *  that folder's `files` configuration? */
export function isFileChecked(filePath: string, roots: readonly SelectionRoot[]): boolean {
  const root = rootForFile(filePath, roots);
  return root !== undefined && root.active && isSelectedFile(filePath, root.path, root.fileSelection);
}

/** Pure LSP refresh plan: selected docs revalidate, newly excluded docs clear. */
export function planFileSelectionRefresh<T extends OpenDocumentLike>(
  documents: readonly T[], roots: readonly SelectionRoot[],
): FileSelectionRefresh<T> {
  const result: FileSelectionRefresh<T> = { validate: [], clear: [] };
  for (const document of documents) {
    let selected = false;
    try {
      selected = document.uri.startsWith('file:') && isFileChecked(fileURLToPath(document.uri), roots);
    } catch { selected = false; }
    (selected ? result.validate : result.clear).push(document);
  }
  return result;
}
