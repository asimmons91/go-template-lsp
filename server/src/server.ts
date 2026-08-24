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
      }
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

documents.onDidClose((e) => languageModes.onDocumentRemoved(e.document));

connection.onDidChangeWatchedFiles((params) => {
  if (!languageModes) return;
  for (const change of params.changes) {
    if (change.uri.endsWith('.go')) {
      languageModes.invalidateFuncMap();
      return;
    }
  }
});

documents.listen(connection);
connection.listen();
