import * as path from 'path';
import { ExtensionContext, workspace } from 'vscode';
import {
  LanguageClient,
  LanguageClientOptions,
  ServerOptions,
  TransportKind
} from 'vscode-languageclient/node';

let client: LanguageClient;

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
}

export function deactivate(): Thenable<void> | undefined {
  return client?.stop();
}
