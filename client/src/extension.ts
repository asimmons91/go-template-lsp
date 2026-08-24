import * as path from 'path';
import {
  commands,
  ExtensionContext,
  Position,
  Range,
  SnippetString,
  TextEditor,
  window,
  workspace,
} from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind,
} from 'vscode-languageclient/node';

let client: LanguageClient;

interface EmmetSettings {
  showExpandedAbbreviation?: string;
  showAbbreviationSuggestions?: boolean;
  showSuggestionsAsSnippets?: boolean;
  preferences?: Record<string, unknown>;
  syntaxProfiles?: Record<string, unknown>;
  variables?: Record<string, unknown>;
}

/** Reads the `emmet.*` settings the server needs to shape completion/expansion. */
function getEmmetSettings(): EmmetSettings {
  const emmet = workspace.getConfiguration('emmet');
  return {
    showExpandedAbbreviation: emmet.get<string>(
      'showExpandedAbbreviation',
      'inMarkupAndStylesheetFilesOnly',
    ),
    showAbbreviationSuggestions: emmet.get<boolean>('showAbbreviationSuggestions', true),
    showSuggestionsAsSnippets: emmet.get<boolean>('showSuggestionsAsSnippets', false),
    preferences: emmet.get<Record<string, unknown>>('preferences', {}),
    syntaxProfiles: emmet.get<Record<string, unknown>>('syntaxProfiles', {}),
    variables: emmet.get<Record<string, unknown>>('variables', {}),
  };
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
      options: { execArgv: ['--nolazy', '--inspect=6009'] },
    },
  };

  const clientOptions: LanguageClientOptions = {
    documentSelector: [{ scheme: 'file', language: 'gotmpl' }],
    synchronize: {
      // Re-run Go-side analysis when .go files change, not just template files,
      // since FuncMap/gotype context lives in the surrounding Go source.
      fileEvents: workspace.createFileSystemWatcher('**/*.{go,gotmpl,gtpl,tmpl,gohtml}'),
    },
    initializationOptions: {
      goplsPath: workspace.getConfiguration('goTemplate').get<string>('goplsPath', 'gopls'),
      templateRoots: workspace.getConfiguration('goTemplate').get<string[]>('templateRoots', []),
      extraFuncs: workspace
        .getConfiguration('goTemplate')
        .get<Record<string, unknown>>('extraFuncs', {}),
      emmet: getEmmetSettings(),
    },
  };

  client = new LanguageClient(
    'goTemplateLanguageServer',
    'Go Template Language Server',
    serverOptions,
    clientOptions,
  );

  void client.start();

  wireEmmetExpand(context);
  wireTagComplete(context);
  wireEmmetContext(context);
  wireConfigurationSync(context);
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
      isInsideGoAction(text, editor.document.offsetAt(selection.active)),
    );
  }
  void commands.executeCommand('setContext', 'gotmpl.inAction', inAction);
}

/**
 * §2.9 — forwards `goTemplate.templateRoots`/`goTemplate.extraFuncs` and `emmet.*`
 * changes to the server so the indexes and Emmet config re-apply live instead of
 * waiting for a reload.
 */
function wireConfigurationSync(context: ExtensionContext): void {
  context.subscriptions.push(
    workspace.onDidChangeConfiguration((e) => {
      if (
        !e.affectsConfiguration('goTemplate.templateRoots') &&
        !e.affectsConfiguration('goTemplate.extraFuncs') &&
        !e.affectsConfiguration('emmet')
      ) {
        return;
      }
      void client.sendNotification('workspace/didChangeConfiguration', {
        settings: {
          goTemplate: {
            templateRoots: workspace
              .getConfiguration('goTemplate')
              .get<string[]>('templateRoots', []),
            extraFuncs: workspace
              .getConfiguration('goTemplate')
              .get<Record<string, unknown>>('extraFuncs', {}),
          },
          emmet: getEmmetSettings(),
        },
      });
    }),
  );
}

/**
 * §4.4a — scope-aware Emmet. Tracks the cursor and publishes a `gotmpl.inAction`
 * context key, which the contributed `tab` keybindings (package.json) use to
 * route Tab to `gotmpl.expandEmmet` outside actions and a plain tab inside them.
 */
function wireEmmetContext(context: ExtensionContext): void {
  updateEmmetContext(window.activeTextEditor);

  context.subscriptions.push(
    window.onDidChangeTextEditorSelection(() => updateEmmetContext(window.activeTextEditor)),
    workspace.onDidChangeTextDocument(() => updateEmmetContext(window.activeTextEditor)),
    window.onDidChangeActiveTextEditor((editor) => updateEmmetContext(editor)),
  );
}

/**
 * §4.4a — scope-aware Emmet expansion. The `gotmpl.inAction` context key gates a
 * `tab` → `gotmpl.expandEmmet` keybinding (package.json) so that Tab inside a
 * `{{ }}` action falls through to a plain tab, while outside an action it asks
 * the server to expand the abbreviation at the cursor.
 */
function wireEmmetExpand(context: ExtensionContext): void {
  context.subscriptions.push(
    commands.registerCommand('gotmpl.expandEmmet', async () => {
      const editor = window.activeTextEditor;
      if (!editor || editor.document.languageId !== 'gotmpl') {
        return commands.executeCommand('tab');
      }

      const doc = editor.document;
      const position = editor.selection.active;
      const result = await client.sendRequest<{
        range: {
          start: { line: number; character: number };
          end: { line: number; character: number };
        };
        snippet: string;
      } | null>('emmet/expandAbbreviation', {
        textDocument: { uri: doc.uri.toString() },
        position,
      });

      if (!result) return commands.executeCommand('tab');

      const range = new Range(
        result.range.start.line,
        result.range.start.character,
        result.range.end.line,
        result.range.end.character,
      );
      return editor.insertSnippet(new SnippetString(result.snippet), range);
    }),
  );
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
          position,
        })
        .then(
          (result) => {
            if (!result) return;
            const editor = window.activeTextEditor;
            if (!editor || editor.document.uri.toString() !== doc.uri.toString()) return;
            void editor.insertSnippet(new SnippetString(result), position);
          },
          () => undefined,
        );
    }),
  );
}
