import {
  doComplete,
  expandAbbreviation,
  extractAbbreviation,
  getExpandOptions,
  isStyleSheet,
  VSCodeEmmetConfig,
} from '@vscode/emmet-helper';
import { CompletionList, Position, Range } from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';

/**
 * Emmet configuration forwarded from the client (the `emmet.*` VSCode settings
 * that shape completion/expansion output). Kept intentionally minimal: the full
 * VSCode Emmet surface is large, but these are the fields that affect what the
 * `@vscode/emmet-helper` produces for the HTML/CSS regions we own.
 */
export interface EmmetSettings {
  showExpandedAbbreviation?: string;
  showAbbreviationSuggestions?: boolean;
  showSuggestionsAsSnippets?: boolean;
  preferences?: Record<string, unknown>;
  syntaxProfiles?: Record<string, unknown>;
  variables?: Record<string, unknown>;
}

const defaultConfig: Required<
  Pick<
    EmmetSettings,
    'showExpandedAbbreviation' | 'showAbbreviationSuggestions' | 'showSuggestionsAsSnippets'
  >
> = {
  showExpandedAbbreviation: 'inMarkupAndStylesheetFilesOnly',
  showAbbreviationSuggestions: true,
  showSuggestionsAsSnippets: false,
};

let emmetConfig: VSCodeEmmetConfig = { ...defaultConfig };

/** Updates the Emmet config used by every subsequent completion/expansion call. */
export function configureEmmet(settings: EmmetSettings | undefined): void {
  emmetConfig = {
    showExpandedAbbreviation:
      settings?.showExpandedAbbreviation ?? defaultConfig.showExpandedAbbreviation,
    showAbbreviationSuggestions:
      settings?.showAbbreviationSuggestions ?? defaultConfig.showAbbreviationSuggestions,
    showSuggestionsAsSnippets:
      settings?.showSuggestionsAsSnippets ?? defaultConfig.showSuggestionsAsSnippets,
    preferences: settings?.preferences,
    syntaxProfiles: settings?.syntaxProfiles,
    variables: settings?.variables,
  };
}

/** Emmet abbreviations for the given position in a single-language (masked) document. */
export function getEmmetCompletion(
  document: TextDocument,
  position: Position,
  syntax: 'html' | 'css',
): CompletionList | undefined {
  return doComplete(document, position, syntax, emmetConfig);
}

export interface EmmetExpansion {
  range: Range;
  snippet: string;
}

/** Extracts and expands the abbreviation at the given position, or returns null. */
export function getEmmetExpansion(
  document: TextDocument,
  position: Position,
  syntax: 'html' | 'css',
): EmmetExpansion | null {
  const extracted = extractAbbreviation(document, position, {
    lookAhead: !isStyleSheet(syntax),
    type: isStyleSheet(syntax) ? 'stylesheet' : 'markup',
  });
  if (!extracted) return null;

  const config = getExpandOptions(syntax, emmetConfig, extracted.filter);
  const snippet = expandAbbreviation(extracted.abbreviation, config);
  if (!snippet) return null;

  return { range: extracted.abbreviationRange, snippet };
}
