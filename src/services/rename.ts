// ============================================================================
// References / Rename — LSP handlers for finding & renaming identifier usages
//
// Plain language: the thin entry points for "Find All References" and
// "Rename Symbol".  The heavy lifting (mapping every identifier to its
// declaration, scope-aware) lives in references.ts; this file wraps those
// results in the shapes the editor expects.
// ============================================================================

import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  Location,
  Range,
  TextEdit,
  WorkspaceEdit,
  ReferenceParams,
  RenameParams,
  PrepareRenameParams,
} from 'vscode-languageserver/node';
import { InferenceResult } from '../infer';
import { findReferencesAtOffset } from './references';

/**
 * Find all references to the symbol at `params.position`.
 * Returns the list of LSP `Location`s for that document.
 */
export function provideReferences(
  doc: TextDocument,
  params: ReferenceParams,
  cachedResult: InferenceResult | undefined,
): Location[] {
  const source = doc.getText();
  const offset = doc.offsetAt(params.position);

  const group = findReferencesAtOffset(source, offset, cachedResult);
  if (!group) return [];

  const locations: Location[] = [];
  for (const loc of group.locations) {
    // When includeDeclaration is false, skip the definition site
    if (!params.context.includeDeclaration && loc.isDefinition) continue;
    locations.push({
      uri: params.textDocument.uri,
      range: {
        start: doc.positionAt(loc.start),
        end: doc.positionAt(loc.end),
      },
    });
  }

  return locations;
}

/**
 * Validate that the cursor is on a renameable symbol and return the
 * rename range + placeholder name.
 */
export function providePrepareRename(
  doc: TextDocument,
  params: PrepareRenameParams,
  cachedResult: InferenceResult | undefined,
): { range: Range; placeholder: string } | null {
  const source = doc.getText();
  const offset = doc.offsetAt(params.position);

  const group = findReferencesAtOffset(source, offset, cachedResult);
  if (!group) return null;

  // Find the specific occurrence the cursor is on
  for (const loc of group.locations) {
    if (offset >= loc.start && offset <= loc.end) {
      return {
        range: {
          start: doc.positionAt(loc.start),
          end: doc.positionAt(loc.end),
        },
        placeholder: group.name,
      };
    }
  }

  return null;
}

/**
 * Build a `WorkspaceEdit` renaming the symbol at `params.position` to
 * `params.newName` across every reference + the HM annotation comment.
 */
export function provideRename(
  doc: TextDocument,
  params: RenameParams,
  cachedResult: InferenceResult | undefined,
): WorkspaceEdit | null {
  const source = doc.getText();
  const offset = doc.offsetAt(params.position);

  const group = findReferencesAtOffset(source, offset, cachedResult);
  if (!group) return null;

  const edits: TextEdit[] = [];

  // Rename all identifier occurrences
  for (const loc of group.locations) {
    edits.push({
      range: {
        start: doc.positionAt(loc.start),
        end: doc.positionAt(loc.end),
      },
      newText: params.newName,
    });
  }

  // Also rename the name in the HM annotation comment (// name :: Type)
  if (group.annotationNameStart !== undefined && group.annotationNameEnd !== undefined) {
    edits.push({
      range: {
        start: doc.positionAt(group.annotationNameStart),
        end: doc.positionAt(group.annotationNameEnd),
      },
      newText: params.newName,
    });
  }

  return {
    changes: {
      [params.textDocument.uri]: edits,
    },
  };
}
