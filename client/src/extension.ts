import * as path from 'path';
import {
  ConfigurationTarget,
  ExtensionContext,
  Position,
  SnippetString,
  window,
  workspace
} from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

/**
 * Merges `{ gotmpl: "html" }` into an existing `emmet.includeLanguages` map,
 * preserving any other languages the user has already mapped. Extracted so the
 * merge logic is unit-testable without a VSCode runtime.
 */
export function mergeIncludeLanguages(
  current: Record<string, string> | undefined,
  add: Record<string, string>
): Record<string, string> {
  return { ...(current ?? {}), ...add };
}

export function activate(context: ExtensionContext): void {
  // The server is a separate Node process, communicated with over IPC.
  // This is the one process boundary on the "editor side" of the system —
  // everything else (HTML/CSS/JS delegation) happens inside that one server process.
  const serverModule = context.asAbsolutePath(path.join('server', 'out', 'server.js'));

  const serverOptions: ServerOptions = {
    run: { module: serverModule, transport: TransportKind.ipc },
    debug: {
      module: serverModule,
      transport: TransportKind.ipc,
      options: { execArgv: ['--nolazy', '--inspect=6009'] }
    }
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'gotmpl' }],
    synchronize: {
      // Re-run Go-side analysis when .go files change, not just template files,
      // since FuncMap/gotype context lives in the surrounding Go source.
      fileEvents: workspace.createFileSystemWatcher('**/*.{go,gotmpl,gtpl,tmpl,gohtml}')
    },
    initializationOptions: {
      goplsPath: workspace.getConfiguration('goTemplate').get<string>('goplsPath', 'gopls')
    }
  };

  client = new LanguageClient(
    'goTemplateLanguageServer',
    'Go Template Language Server',
    serverOptions,
    clientOptions
  );

  client.start();

  promptForEmmet(context);
  wireTagComplete(context);
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}

/**
 * §4.4a — Emmet activation. The `configurationDefaults` in package.json covers
 * users who have never touched `emmet.includeLanguages`; this one-time prompt
 * covers the rest (a user who already has their own mapping) by merging
 * `gotmpl` into it explicitly.
 */
function promptForEmmet(context: ExtensionContext): void {
  const stateKey = 'goTemplate.emmetPrompted';
  if (context.globalState.get<boolean>(stateKey, false)) return;

  const emmetConfig = workspace.getConfiguration('emmet');
  const include = emmetConfig.get<Record<string, string>>('includeLanguages');
  if (include && include.gotmpl) return;

  void context.globalState.update(stateKey, true);

  void window
    .showInformationMessage('Enable Emmet for Go Template files?', 'Enable', 'Not now')
    .then((choice) => {
      if (choice !== 'Enable') return;
      void emmetConfig.update(
        'includeLanguages',
        mergeIncludeLanguages(include, { gotmpl: 'html' }),
        ConfigurationTarget.Global
      );
    });
}

/**
 * §4.4b — HTML tag auto-closing. When the last-typed character is `>` or `/`
 * (outside a `{{ }}` action, which the server checks), ask the server for the
 * matching closing-tag snippet and insert it. Uses a custom `html/tag` request,
 * the same name VSCode's own html-language-features extension uses.
 */
function wireTagComplete(context: ExtensionContext): void {
  context.subscriptions.push(
    workspace.onDidChangeTextDocument((e) => {
      const doc = e.document;
      if (doc.languageId !== 'gotmpl') return;
      if (e.contentChanges.length !== 1) return;

      const change = e.contentChanges[0];
      if (change.text !== '>' && change.text !== '/') return;

      const position: Position = change.range.end;
      client
        .sendRequest<string | null>('html/tag', {
          textDocument: { uri: doc.uri.toString() },
          position
        })
        .then(
          (result) => {
            if (!result) return;
            const editor = window.activeTextEditor;
            if (!editor || editor.document.uri.toString() !== doc.uri.toString()) return;
            void editor.insertSnippet(new SnippetString(result), position);
          },
          () => undefined
        );
    })
  );
}
