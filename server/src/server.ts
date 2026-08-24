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
const languageModes = getLanguageModes();

connection.onInitialize((_params: InitializeParams): InitializeResult => {
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

connection.onCompletion((params): CompletionList | null => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const result = languageModes.getModeAtPosition(document, params.position);
  if (!result) return null;

  return result.mode.doComplete(document, params.position, result.regions);
});

documents.onDidClose((e) => languageModes.onDocumentRemoved(e.document));

documents.listen(connection);
connection.listen();
