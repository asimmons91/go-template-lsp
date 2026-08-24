import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  CompletionList
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getLanguageModes } from './languageModes';
import { isTemplateFileUri } from './templateNameService';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let languageModes: ReturnType<typeof getLanguageModes>;

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const goplsPath = (params.initializationOptions as { goplsPath?: string } | undefined)?.goplsPath ?? 'gopls';
  const rootUri = params.rootUri ?? params.workspaceFolders?.[0]?.uri ?? undefined;
  languageModes = getLanguageModes(goplsPath, rootUri);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ['<', '"', "'", '=', '/', '.', ':', '-', '@']
      },
      definitionProvider: true,
      referencesProvider: true
    }
  };
});

connection.onCompletion(async (params): Promise<CompletionList | null> => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const result = languageModes.getModeAtPosition(document, params.position);
  if (!result) return null;

  return result.mode.doComplete(document, params.position, result.regions);
});

connection.onDefinition(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const result = languageModes.getModeAtPosition(document, params.position);
  if (!result?.mode.doDefinition) return null;

  return (await result.mode.doDefinition(document, params.position, result.regions)) ?? null;
});

connection.onReferences(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const result = languageModes.getModeAtPosition(document, params.position);
  if (!result?.mode.doReferences) return null;

  return (await result.mode.doReferences(document, params.position, result.regions, params.context)) ?? null;
});

documents.onDidOpen((e) => languageModes?.onDocumentOpened(e.document));
documents.onDidChangeContent((e) => languageModes?.onDocumentChanged(e.document));
documents.onDidClose((e) => {
  languageModes?.onDocumentClosed(e.document);
  languageModes?.onDocumentRemoved(e.document);
});

connection.onDidChangeWatchedFiles((params) => {
  if (!languageModes) return;
  for (const change of params.changes) {
    if (change.uri.endsWith('.go')) {
      languageModes.invalidateFuncMap();
    } else if (isTemplateFileUri(change.uri) && !documents.get(change.uri)) {
      languageModes.onTemplateFileEvent(change.uri, change.type);
    }
  }
});

documents.listen(connection);
connection.listen();
