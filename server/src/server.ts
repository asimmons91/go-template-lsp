import {
  createConnection,
  TextDocuments,
  ProposedFeatures,
  InitializeParams,
  InitializeResult,
  TextDocumentSyncKind,
  CompletionList,
  Position,
  Range,
  RenameParams,
  LinkedEditingRangeRequest,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import { getLanguageModes } from './languageModes';
import { isTemplateFileUri } from './templateNameService';

const connection = createConnection(ProposedFeatures.all);
const documents = new TextDocuments(TextDocument);
let languageModes: ReturnType<typeof getLanguageModes>;
const pendingValidations = new Map<string, ReturnType<typeof setTimeout>>();

/**
 * Debounced diagnostics pass: gathers diagnostics from every language delegate
 * (Go template syntax, HTML tag balance, CSS, JS/TS) and publishes them merged
 * into a single list for the file.
 */
function validateTextDocument(textDocument: TextDocument): void {
  if (!languageModes) return;
  const uri = textDocument.uri;
  const existing = pendingValidations.get(uri);
  if (existing) clearTimeout(existing);

  pendingValidations.set(
    uri,
    setTimeout(() => {
      pendingValidations.delete(uri);
      void languageModes
        .doDiagnostics(textDocument)
        .then((diagnostics) => connection.sendDiagnostics({ uri, diagnostics }))
        .catch(() => connection.sendDiagnostics({ uri, diagnostics: [] }));
    }, 150),
  );
}

connection.onInitialize((params: InitializeParams): InitializeResult => {
  const goplsPath =
    (params.initializationOptions as { goplsPath?: string } | undefined)?.goplsPath ?? 'gopls';
  const rootUri = params.rootUri ?? params.workspaceFolders?.[0]?.uri ?? undefined;
  languageModes = getLanguageModes(goplsPath, rootUri);

  return {
    capabilities: {
      textDocumentSync: TextDocumentSyncKind.Incremental,
      completionProvider: {
        resolveProvider: false,
        triggerCharacters: ['<', '"', "'", '=', '/', '.', ':', '-', '@'],
      },
      definitionProvider: true,
      referencesProvider: true,
      hoverProvider: true,
      renameProvider: { prepareProvider: true },
      signatureHelpProvider: { triggerCharacters: [' '] },
      linkedEditingRangeProvider: true,
    },
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

  return (
    (await result.mode.doReferences(document, params.position, result.regions, params.context)) ??
    null
  );
});

connection.onHover(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const result = languageModes.getModeAtPosition(document, params.position);
  if (!result?.mode.doHover) return null;

  return (await result.mode.doHover(document, params.position, result.regions)) ?? null;
});

connection.onSignatureHelp(async (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const result = languageModes.getModeAtPosition(document, params.position);
  if (!result?.mode.doSignatureHelp) return null;

  return (await result.mode.doSignatureHelp(document, params.position, result.regions)) ?? null;
});

connection.onRequest(LinkedEditingRangeRequest.type, (params) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const result = languageModes.getModeAtPosition(document, params.position);
  if (!result?.mode.doLinkedEditing) return null;

  return result.mode.doLinkedEditing(document, params.position, result.regions);
});

connection.onPrepareRename(async (params): Promise<Range | null> => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const result = languageModes.getModeAtPosition(document, params.position);
  if (!result?.mode.doPrepareRename) return null;

  return (await result.mode.doPrepareRename(document, params.position, result.regions)) ?? null;
});

connection.onRenameRequest(async (params: RenameParams) => {
  const document = documents.get(params.textDocument.uri);
  if (!document) return null;

  const result = languageModes.getModeAtPosition(document, params.position);
  if (!result?.mode.doRename) return null;

  return (
    (await result.mode.doRename(document, params.position, params.newName, result.regions)) ?? null
  );
});

connection.onRequest(
  'html/tag',
  (params: { textDocument: { uri: string }; position: Position }) => {
    const document = documents.get(params.textDocument.uri);
    if (!document || !languageModes) return null;
    return languageModes.doTagComplete(document, params.position);
  },
);

documents.onDidOpen((e) => {
  languageModes?.onDocumentOpened(e.document);
  validateTextDocument(e.document);
});
documents.onDidChangeContent((e) => {
  languageModes?.onDocumentChanged(e.document);
  validateTextDocument(e.document);
});
documents.onDidClose((e) => {
  const pending = pendingValidations.get(e.document.uri);
  if (pending) clearTimeout(pending);
  pendingValidations.delete(e.document.uri);
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
