import * as path from 'path';
import {
  commands,
  ConfigurationTarget,
  ExtensionContext,
  Position,
  SnippetString,
  TextEditor,
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
  wireEmmetContext(context);
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}

/**
 * Port of the server's `scanActions` (server/src/templateParser.ts) so the
 * client can detect `{{ }}` action spans synchronously for the Emmet context
 * key. Honors trim markers, quoted string literals, and block comments so an
 * embedded `}}` inside them doesn't end the span early.
 */
function scanActionSpans(text: string): Array<{ start: number; end: number }> {
  const spans: Array<{ start: number; end: number }> = [];
  const len = text.length;
  let i = 0;
  while (i < len) {
    const start = text.indexOf('{{', i);
    if (start === -1) break;

    let j = start + 2;
    let end = -1;
    while (j < len) {
      const ch = text[j];
      if (ch === '"' || ch === '`') {
        const quote = ch;
        j++;
        while (j < len && text[j] !== quote) {
          if (quote === '"' && text[j] === '\\') j++;
          j++;
        }
        j++;
        continue;
      }
      if (ch === '/' && text[j + 1] === '*') {
        j += 2;
        while (j < len && !(text[j] === '*' && text[j + 1] === '/')) j++;
        j += 2;
        continue;
      }
      if (ch === '}' && text[j + 1] === '}') {
        end = j + 2;
        break;
      }
      j++;
    }

    if (end === -1) {
      spans.push({ start, end: len });
      break;
    }

    spans.push({ start, end });
    i = end;
  }
  return spans;
}

function isInsideGoAction(text: string, offset: number): boolean {
  return scanActionSpans(text).some((span) => span.start <= offset && offset <= span.end);
}

function updateEmmetContext(editor: TextEditor | undefined): void {
  let inAction = false;
  if (editor && editor.document.languageId === 'gotmpl') {
    const text = editor.document.getText();
    inAction = editor.selections.some((selection) =>
      isInsideGoAction(text, editor.document.offsetAt(selection.active))
    );
  }
  void commands.executeCommand('setContext', 'gotmpl.inAction', inAction);
}

/**
 * §4.4a — scope-aware Emmet disabling. Emmet is language-mode based, so the
 * TextMate scope can't stop it inside `{{ }}`. Instead we track the cursor and
 * publish a `gotmpl.inAction` context key that a keybinding (package.json) uses
 * to fall back to a plain Tab inside actions.
 */
function wireEmmetContext(context: ExtensionContext): void {
  updateEmmetContext(window.activeTextEditor);

  context.subscriptions.push(
    window.onDidChangeTextEditorSelection(() => updateEmmetContext(window.activeTextEditor)),
    workspace.onDidChangeTextDocument(() => updateEmmetContext(window.activeTextEditor)),
    window.onDidChangeActiveTextEditor((editor) => updateEmmetContext(editor))
  );
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
