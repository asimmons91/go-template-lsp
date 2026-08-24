import {
  CompletionList,
  Diagnostic,
  Hover,
  LinkedEditingRanges,
  Location,
  Position,
  Range,
  ReferenceContext,
  SemanticTokens,
  SignatureHelp,
  WorkspaceEdit,
} from 'vscode-languageserver/node';
import { TextDocument } from 'vscode-languageserver-textdocument';
import {
  EmbeddedLanguageId,
  GoTemplateDocument,
  getDocumentRegions,
  getEmbeddedDocument,
  getLanguageAtOffset,
} from './documentRegions';
import { getHTMLMode } from './modes/htmlMode';
import { getCSSMode } from './modes/cssMode';
import { getJSMode } from './modes/jsMode';
import { getGoTemplateMode } from './modes/goTemplateMode';
import { EmmetExpansion, getEmmetExpansion } from './modes/emmet';
import { getFuncMapIndexer, FuncMapEntry } from './indexer/funcMapIndex';
import { getGoIndexRunner } from './goIndex';
import { getExecuteSiteIndex } from './inference/executeSiteIndex';
import { TemplateNameService } from './templateNameService';
import { getAutoescapeDiagnostics } from './autoescape/classifier';
import { normalizeRoots } from './workspace';

export interface LanguageMode {
  getId(): EmbeddedLanguageId;
  doComplete(
    document: TextDocument,
    position: Position,
    regions: GoTemplateDocument,
  ): CompletionList | Promise<CompletionList>;
  doDefinition?(
    document: TextDocument,
    position: Position,
    regions: GoTemplateDocument,
  ): Location[] | undefined | Promise<Location[] | undefined>;
  doHover?(
    document: TextDocument,
    position: Position,
    regions: GoTemplateDocument,
  ): Hover | undefined | Promise<Hover | undefined>;
  doSignatureHelp?(
    document: TextDocument,
    position: Position,
    regions: GoTemplateDocument,
  ): SignatureHelp | null | Promise<SignatureHelp | null>;
  doLinkedEditing?(
    document: TextDocument,
    position: Position,
    regions: GoTemplateDocument,
  ): LinkedEditingRanges | null;
  doReferences?(
    document: TextDocument,
    position: Position,
    regions: GoTemplateDocument,
    context: ReferenceContext,
  ): Location[] | undefined | Promise<Location[] | undefined>;
  doPrepareRename?(
    document: TextDocument,
    position: Position,
    regions: GoTemplateDocument,
  ): Range | null | Promise<Range | null>;
  doRename?(
    document: TextDocument,
    position: Position,
    newName: string,
    regions: GoTemplateDocument,
  ): WorkspaceEdit | null | undefined | Promise<WorkspaceEdit | null | undefined>;
  doDiagnostics?(
    document: TextDocument,
    regions: GoTemplateDocument,
  ): Diagnostic[] | Promise<Diagnostic[]>;
  doTagComplete?(
    document: TextDocument,
    position: Position,
    regions: GoTemplateDocument,
  ): string | null;
}

export interface ModeAtPosition {
  mode: LanguageMode;
  regions: GoTemplateDocument;
}

export interface LanguageModes {
  getModeAtPosition(document: TextDocument, position: Position): ModeAtPosition | undefined;
  getSemanticTokens(document: TextDocument): Promise<SemanticTokens>;
  doDiagnostics(document: TextDocument): Promise<Diagnostic[]>;
  doTagComplete(document: TextDocument, position: Position): string | null;
  doEmmetExpand(document: TextDocument, position: Position): EmmetExpansion | null;
  onDocumentRemoved(document: TextDocument): void;
  onDocumentOpened(document: TextDocument): void;
  onDocumentChanged(document: TextDocument): void;
  onDocumentClosed(document: TextDocument): void;
  onTemplateFileEvent(uri: string, type: number): void;
  invalidateFuncMap(files?: string[]): void;
  /** Re-scans the template index with new template-root patterns and replaces the extra-funcs layer. */
  reconfigure(templateRoots: string[], extraFuncs: FuncMapEntry[]): void;
  dispose(): void;
}

export function getLanguageModes(
  goplsPath: string,
  roots: string | string[] | undefined,
  templateRoots?: string[],
  extraFuncs: FuncMapEntry[] = [],
): LanguageModes {
  const rootList = normalizeRoots(roots);
  const workspaceFolders = rootList.map((uri) => ({ uri, name: uri }));
  const rootUri = rootList[0];
  const htmlMode = getHTMLMode();
  const cssMode = getCSSMode();
  const jsMode = getJSMode(rootList);
  const goIndexRunner = getGoIndexRunner(rootList);
  const funcMapIndexer = getFuncMapIndexer(goIndexRunner);
  funcMapIndexer.setExtraFuncs(extraFuncs);
  const templateNames = new TemplateNameService(rootList, templateRoots);
  const executeSiteIndex = getExecuteSiteIndex(goIndexRunner, templateNames);
  const goTemplateMode = getGoTemplateMode(
    goplsPath,
    rootUri,
    workspaceFolders,
    funcMapIndexer,
    templateNames,
    executeSiteIndex,
  );

  const modes: Partial<Record<EmbeddedLanguageId, LanguageMode>> = {
    html: htmlMode,
    css: cssMode,
    javascript: jsMode,
    gotemplate: goTemplateMode,
  };

  return {
    getModeAtPosition(document, position) {
      const regions = getDocumentRegions(document);
      const languageId = getLanguageAtOffset(regions, document.offsetAt(position));
      const mode = modes[languageId];
      if (!mode) return undefined;
      return { mode, regions };
    },
    getSemanticTokens(document) {
      return goTemplateMode.getSemanticTokens(document);
    },
    async doDiagnostics(document) {
      const regions = getDocumentRegions(document);
      const all: Diagnostic[] = [];
      for (const mode of Object.values(modes)) {
        if (!mode?.doDiagnostics) continue;
        all.push(...(await mode.doDiagnostics(document, regions)));
      }
      all.push(...getAutoescapeDiagnostics(document));
      return all;
    },
    doTagComplete(document, position) {
      const regions = getDocumentRegions(document);
      if (getLanguageAtOffset(regions, document.offsetAt(position)) === 'gotemplate') return null;
      return htmlMode.doTagComplete?.(document, position, regions) ?? null;
    },
    doEmmetExpand(document, position) {
      const regions = getDocumentRegions(document);
      const languageId = getLanguageAtOffset(regions, document.offsetAt(position));
      if (languageId === 'html') {
        return getEmmetExpansion(regions.maskedDocument, position, 'html');
      }
      if (languageId === 'css') {
        return getEmmetExpansion(getEmbeddedDocument(document, regions, 'css'), position, 'css');
      }
      return null;
    },
    onDocumentRemoved(document) {
      jsMode.onDocumentRemoved(document);
    },
    onDocumentOpened(document) {
      templateNames.indexDocument(document.uri, document.getText());
    },
    onDocumentChanged(document) {
      templateNames.indexDocument(document.uri, document.getText());
    },
    onDocumentClosed(document) {
      templateNames.onDocumentClosed(document.uri);
    },
    onTemplateFileEvent(uri, type) {
      templateNames.onFileEvent(uri, type);
    },
    invalidateFuncMap(files?: string[]) {
      goIndexRunner.invalidate(files);
    },
    reconfigure(templateRoots, extraFuncs) {
      templateNames.rescan(templateRoots);
      funcMapIndexer.setExtraFuncs(extraFuncs);
      goIndexRunner.invalidate();
    },
    dispose() {
      jsMode.dispose();
      goTemplateMode.dispose();
      goIndexRunner.dispose();
    },
  };
}
