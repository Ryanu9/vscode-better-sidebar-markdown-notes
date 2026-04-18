// The module 'vscode' contains the VS Code extensibility API
// Import the module and reference it with the alias vscode in your code below
import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';

import { getConfig } from './config';
import { StorageService, NotesData, LegacyNotesData } from './storageService';
import { MigrationService } from './migrationService';
import { ImportService, DiscoveredNote } from './importService';

export default class SidebarMarkdownNotesProvider implements vscode.WebviewViewProvider {
  public static readonly viewId = 'betterSidebarMarkdownNotes.webview';

  private _view?: vscode.WebviewView;
  private config = getConfig();
  private storageService: StorageService;
  private migrationService: MigrationService;
  private importService: ImportService;
  private autoSaveTimeout?: NodeJS.Timeout;

  constructor(
    private readonly _extensionUri: vscode.Uri,
    private _statusBar: vscode.StatusBarItem,
    private context: vscode.ExtensionContext
  ) {
    this.storageService = new StorageService(context);
    this.migrationService = new MigrationService(context, this.storageService);
    this.importService = new ImportService(context, this.storageService);
  }

  /**
   * Revolves a webview view.
   *
   * `resolveWebviewView` is called when a view first becomes visible. This may happen when the view is
   * first loaded or when the user hides and then shows a view again.
   *
   * @param webviewView Webview view to restore. The provider should take ownership of this view. The
   *    provider must set the webview's `.html` and hook up all webview events it is interested in.
   * @param context Additional metadata about the view being resolved.
   * @param token Cancellation token indicating that the view being provided is no longer needed.
   *
   * @return Optional thenable indicating that the view has been fully resolved.
   */
  public resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;

    webviewView.webview.options = {
      // Allow scripts in the webview
      enableScripts: true,
      localResourceRoots: [this._extensionUri]
    };

    webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);

    // Setup file watcher for external changes after webview is ready
    const config = getConfig();
    if (config.sync.enableFileWatcher) {
      this.storageService.setupFileWatcher(() => {
        this.handleExternalFileChange();
      });
    }

    webviewView.webview.onDidReceiveMessage(async (data) => {
      switch (data.type) {
        case 'log': {
          vscode.window.showInformationMessage(`${data.value}`);
          break;
        }
        case 'updateStatusBar': {
          this.updateStatusBar(data.value);
          break;
        }
        case 'exportPage': {
          vscode.workspace.openTextDocument({ language: 'markdown' }).then((a: vscode.TextDocument) => {
            vscode.window.showTextDocument(a, 1, false).then((e) => {
              e.edit((edit) => {
                edit.insert(new vscode.Position(0, 0), data.value);
              });
            });
          });
          break;
        }
        case 'saveNotes': {
          await this.handleSaveNotes(data.value, data.isAutoSave || false);
          break;
        }
        case 'loadNotes': {
          await this.handleLoadNotes();
          break;
        }
        case 'requestInitialData': {
          await this.handleInitialDataRequest();
          break;
        }
        case 'migrateLegacyData': {
          await this.handleMigrateLegacyData(data.value);
          break;
        }
        case 'openWorkspace': {
          await this.handleOpenWorkspace();
          break;
        }
        case 'selectCustomLocation': {
          await this.handleSelectCustomLocation();
          break;
        }
        case 'openSettings': {
          this.openSettings();
          break;
        }
        case 'importNotes': {
          await this.importNotes();
          break;
        }
        case 'scanForNotes': {
          await this.handleScanForNotes(data.value);
          break;
        }
        case 'importSelectedNotes': {
          await this.handleImportSelectedNotes(data.value);
          break;
        }
        case 'toggleBookmark': {
          await this.handleToggleBookmark(data.pageIndex, data.value);
          break;
        }
        case 'bulkSetBookmarks': {
          await this.handleBulkSetBookmarks(data.indices, data.value);
          break;
        }
        case 'bookmarkStateChanged': {
          vscode.commands.executeCommand(
            'setContext',
            'better-sidebar-markdown-notes.isBookmarked',
            !!data.value
          );
          break;
        }
      }
    });

    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('better-sidebar-markdown-notes')) {
        this.config = getConfig();
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
      }
    });
  }

  public resetData() {
    if (this._view) {
      this._view.webview.postMessage({ type: 'resetData' });
    }
  }

  public togglePreview() {
    if (this._view) {
      this._view.webview.postMessage({ type: 'togglePreview' });
    }
  }

  public previousPage() {
    if (this._view) {
      this._view.webview.postMessage({ type: 'previousPage' });
    }
  }

  public nextPage() {
    if (this._view) {
      this._view.webview.postMessage({ type: 'nextPage' });
    }
  }

  public exportPage() {
    if (this._view) {
      this._view.webview.postMessage({ type: 'exportPage' });
    }
  }

  public addNote() {
    if (this._view) {
      this._view.webview.postMessage({ type: 'addNote' });
    }
  }

  public browseNotes() {
    if (this._view) {
      this._view.webview.postMessage({ type: 'browseNotes' });
    }
  }

  public toggleBookmark() {
    if (this._view) {
      this._view.webview.postMessage({ type: 'toggleBookmark' });
    }
  }

  /**
   * Handle saving notes to file storage
   */
  private async handleSaveNotes(notesData: NotesData, isAutoSave: boolean = false): Promise<void> {
    try {
      // Check for SyncThing conflict files before saving
      const conflictFiles = await this.storageService.checkForSyncThingConflicts();
      
      if (conflictFiles.length > 0 && !isAutoSave) {
        // Prompt user to resolve SyncThing conflicts
        await this.handleSyncThingConflicts(conflictFiles);
        return;
      }

      await this.storageService.saveNotes(notesData);

      // Clear any existing auto-save timeout
      if (this.autoSaveTimeout) {
        clearTimeout(this.autoSaveTimeout);
      }

      // Update status bar (less intrusive for auto-saves)
      if (isAutoSave) {
        this.updateStatusBar('$(check) Auto-saved');
        setTimeout(() => this.updateStatusBar(''), 1500);
      } else {
        this.updateStatusBar('$(check) Notes saved');
        setTimeout(() => this.updateStatusBar(''), 2000);
      }

      // Send success message back to webview
      if (this._view) {
        this._view.webview.postMessage({
          type: 'saveSuccess',
          isAutoSave: isAutoSave
        });
      }
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : 'Unknown error';
      console.error('Failed to save notes:', error);

      // Handle conflicts specially
      if (errorMsg === 'CONFLICT_DETECTED' || errorMsg === 'CONFLICT_EXTERNAL_NEWER') {
        if (!isAutoSave) {
          await this.handleSaveConflict(notesData, errorMsg === 'CONFLICT_EXTERNAL_NEWER');
        } else {
          // For auto-save, just skip and notify
          this.updateStatusBar('$(warning) Conflict detected - please refresh');
        }
        return;
      }

      // Show error message only for manual saves to avoid spam
      if (!isAutoSave) {
        vscode.window.showErrorMessage(`Failed to save notes: ${errorMsg}`);
      }

      // Send error back to webview
      if (this._view) {
        this._view.webview.postMessage({
          type: 'saveError',
          error: errorMsg,
          isAutoSave: isAutoSave
        });
      }
    }
  }

  /**
   * Handle loading notes from file storage
   */
  private async handleLoadNotes(): Promise<void> {
    try {
      const notesData = await this.storageService.loadNotes();

      if (this._view && notesData) {
        this._view.webview.postMessage({
          type: 'notesLoaded',
          data: notesData
        });
      }
    } catch (error) {
      console.error('Failed to load notes:', error);
      vscode.window.showErrorMessage(`Failed to load notes: ${error}`);

      // Send error back to webview
      if (this._view) {
        this._view.webview.postMessage({
          type: 'loadError',
          error: error instanceof Error ? error.message : 'Unknown error'
        });
      }
    }
  }

  /**
   * Handle initial data request from webview
   */
  private async handleInitialDataRequest(): Promise<void> {
    try {
      // Check if no workspace is open
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];

      // If no workspace is open, check if user configured a custom storage path
      const config = getConfig();
      if (!workspaceFolder) {
        if (config.storage.location === 'custom' && config.storage.customPath) {
          // Reinitialize storage/migration/import services to respect new custom path
          this.config = config;
          this.storageService = new StorageService(this.context);
          this.migrationService = new MigrationService(this.context, this.storageService);
          this.importService = new ImportService(this.context, this.storageService);

          // Setup file watcher if enabled
          if (this.config.sync.enableFileWatcher) {
            this.storageService.setupFileWatcher(() => this.handleExternalFileChange());
          }

          // Continue to migration/loading below using the custom path
        } else {
          // No workspace and no custom path set - tell webview to show the prompt
          if (this._view) {
            this._view.webview.postMessage({ type: 'noWorkspace' });
          }
          return;
        }
      }

      // Check for SyncThing conflicts first
      // Config already retrieved earlier; use it
      if (config.sync.checkSyncThingConflicts) {
        const conflictFiles = await this.storageService.checkForSyncThingConflicts();
        if (conflictFiles.length > 0) {
          // Notify user about conflicts
          const choice = await vscode.window.showWarningMessage(
            `SyncThing conflict detected! Found ${conflictFiles.length} conflict file(s). Resolve now?`,
            'Resolve Conflicts',
            'Ignore for Now'
          );
          
          if (choice === 'Resolve Conflicts') {
            await this.handleSyncThingConflicts(conflictFiles);
          }
        }
      }

      // Check for migration and load data
  const notesData = await this.migrationService.checkAndMigrate();

      if (this._view) {
        this._view.webview.postMessage({
          type: 'initialData',
          data: notesData
        });
      }
    } catch (error) {
      console.error('Failed to get initial data:', error);

      // Check if it's a "no workspace" error from storage service
      if (error instanceof Error && error.message.includes('No workspace folder found')) {
        if (this._view) {
          this._view.webview.postMessage({ type: 'noWorkspace' });
        }
        return;
      }

      vscode.window.showErrorMessage(`Failed to initialize notes: ${error}`);
    }
  }

  /**
   * Handle migration of legacy data from webview
   */
  private async handleMigrateLegacyData(legacyData: LegacyNotesData): Promise<void> {
    try {
      // Create pre-migration backup
      await this.migrationService.createPreMigrationBackup(legacyData);

      // Perform migration
      const migratedData = await this.migrationService.forceMigration(legacyData);

      if (this._view) {
        this._view.webview.postMessage({
          type: 'migrationComplete',
          data: migratedData
        });
      }

      this.updateStatusBar('$(check) Notes migrated to file storage');
      setTimeout(() => this.updateStatusBar(''), 3000);
    } catch (error) {
      console.error('Failed to migrate legacy data:', error);
      vscode.window.showErrorMessage(`Failed to migrate notes: ${error}`);
    }
  }

  /**
   * Handle bookmark toggle request from webview
   * @param pageIndex - Index of the page to bookmark
   * @param value - Optional explicit value; if omitted, toggles current state
   */
  private async handleToggleBookmark(pageIndex: number, value?: boolean): Promise<void> {
    try {
      const updatedNotes = await this.storageService.toggleBookmark(pageIndex, value);

      if (updatedNotes && this._view) {
        // Send updated notes data back to webview
        this._view.webview.postMessage({
          type: 'bookmarkToggled',
          data: updatedNotes
        });

        const bookmarkState = updatedNotes.bookmarks?.[pageIndex] ? 'bookmarked' : 'unbookmarked';
        console.log(`[WebviewProvider] Page ${pageIndex + 1} ${bookmarkState}`);
      }
    } catch (error) {
      console.error('Failed to toggle bookmark:', error);
      vscode.window.showErrorMessage(`Failed to toggle bookmark: ${error}`);
    }
  }

  /**
   * Handle bulk set of bookmark values from the webview
   */
  private async handleBulkSetBookmarks(indices: number[], value: boolean): Promise<void> {
    try {
      const updatedNotes = await this.storageService.setBookmarks(indices, value);
      if (updatedNotes && this._view) {
        this._view.webview.postMessage({ type: 'bookmarkToggled', data: updatedNotes });
      }
    } catch (error) {
      console.error('Failed to bulk update bookmarks:', error);
      vscode.window.showErrorMessage(`Failed to update bookmarks: ${error}`);
    }
  }

  /**
   * Handle external file changes (e.g., from SyncThing)
   */
  private async handleExternalFileChange(): Promise<void> {
    console.log('[WebviewProvider] External file change detected');
    
    if (!this._view) {
      return;
    }

    const config = getConfig();
    
    if (config.sync.autoReloadOnExternalChange) {
      // Auto-reload without prompting
      console.log('[WebviewProvider] Auto-reloading notes due to external change');
      await this.handleLoadNotes();
      vscode.window.showInformationMessage('Notes reloaded from external changes');
    } else {
      // Notify user and offer to reload
      const choice = await vscode.window.showInformationMessage(
        'Notes file was modified externally. Reload to see changes?',
        'Reload',
        'Ignore'
      );

      if (choice === 'Reload') {
        console.log('[WebviewProvider] User chose to reload notes');
        await this.handleLoadNotes();
      }
    }
  }

  /**
   * Handle save conflicts
   */
  private async handleSaveConflict(localData: NotesData, externalIsNewer: boolean): Promise<void> {
    const remoteData = await this.storageService.loadNotes();
    
    if (!remoteData) {
      // No remote data, safe to save
      await this.storageService.saveNotes(localData, true);
      return;
    }

    const message = externalIsNewer 
      ? 'A newer version of notes exists. How would you like to proceed?'
      : 'Notes file was modified by another device. How would you like to proceed?';

    const choice = await vscode.window.showWarningMessage(
      message,
      'Use My Version',
      'Use Other Version',
      'Merge',
      'Cancel'
    );

    switch (choice) {
      case 'Use My Version':
        await this.storageService.saveNotes(localData, true);
        vscode.window.showInformationMessage('Your version has been saved.');
        break;
      
      case 'Use Other Version':
        if (this._view) {
          this._view.webview.postMessage({
            type: 'notesLoaded',
            data: remoteData
          });
        }
        vscode.window.showInformationMessage('Loaded the other version.');
        break;
      
      case 'Merge':
        const merged = await this.storageService.mergeNotes(localData, remoteData);
        await this.storageService.saveNotes(merged, true);
        if (this._view) {
          this._view.webview.postMessage({
            type: 'notesLoaded',
            data: merged
          });
        }
        vscode.window.showInformationMessage('Notes have been merged.');
        break;
      
      default:
        // Cancel - do nothing
        break;
    }
  }

  /**
   * Handle SyncThing conflict files
   */
  private async handleSyncThingConflicts(conflictFiles: string[]): Promise<void> {
    console.log(`[WebviewProvider] Handling ${conflictFiles.length} SyncThing conflict file(s)`);
    
    const conflictNames = conflictFiles.map((f) => f.split(/[\\/]/).pop()).join(', ');
    
    const choice = await vscode.window.showWarningMessage(
      `SyncThing conflict detected: ${conflictNames}. Resolve now?`,
      'Resolve',
      'Ignore'
    );

    if (choice !== 'Resolve') {
      console.log('[WebviewProvider] User chose to ignore SyncThing conflicts');
      return;
    }

    // For each conflict file, let user choose
    for (const conflictFile of conflictFiles) {
      const fileName = conflictFile.split(/[\\/]/).pop() || 'unknown';
      const currentFile = this.storageService.getNotesFilePathPublic();
      
      // URIs for both files
      const currentUri = vscode.Uri.file(currentFile);
      const conflictUri = vscode.Uri.file(conflictFile);
      
      // First, show the diff viewer
      try {
        await vscode.commands.executeCommand(
          'vscode.diff',
          currentUri,
          conflictUri,
          `Current ↔ Conflict: ${fileName}`,
          { preview: true }
        );
        
        vscode.window.showInformationMessage(
          'Review the differences, then choose which version to keep.',
          { modal: false }
        );
      } catch (error) {
        console.error('[WebviewProvider] Failed to open diff viewer:', error);
      }
      
      // Now ask user to choose - with ignoreFocusOut to prevent accidental dismissal
      const decision = await vscode.window.showQuickPick(
        [
          {
            label: '$(arrow-left) Keep Current Version',
            value: 'keep',
            description: 'Keep the current version and discard the conflict file'
          },
          {
            label: '$(arrow-right) Use Conflict Version',
            value: 'use',
            description: 'Replace current version with the conflict file'
          },
          {
            label: '$(git-merge) Merge Both Versions',
            value: 'merge',
            description: 'Intelligently combine unique pages from both versions'
          },
          {
            label: '$(close) Cancel',
            value: 'cancel',
            description: 'Skip this conflict for now'
          }
        ],
        {
          placeHolder: `Resolve SyncThing Conflict: ${fileName}`,
          ignoreFocusOut: true // Prevent dismissal by clicking outside
        }
      );

      if (!decision || decision.value === 'cancel') {
        console.log('[WebviewProvider] User cancelled conflict resolution');
        continue;
      }

      try {
        if (decision.value === 'merge') {
          // Load both versions and merge
          const currentData = await this.storageService.loadNotes();
          const conflictBuffer = await vscode.workspace.fs.readFile(conflictUri);
          const conflictData = JSON.parse(Buffer.from(conflictBuffer).toString('utf8'));
          
          if (currentData && conflictData) {
            const merged = await this.storageService.mergeNotes(currentData, conflictData);
            await this.storageService.saveNotes(merged, true);
            
            // Delete conflict file and backup it
            await this.storageService.resolveSyncThingConflict(conflictFile, false);
            
            vscode.window.showInformationMessage(
              `✓ Merged versions successfully (${merged.pages.length} total pages)`
            );
          }
        } else {
          await this.storageService.resolveSyncThingConflict(
            conflictFile,
            decision.value === 'use'
          );
          
          vscode.window.showInformationMessage(
            decision.value === 'use'
              ? '✓ Using conflict version'
              : '✓ Keeping current version'
          );
        }
      } catch (error) {
        console.error('[WebviewProvider] Error resolving conflict:', error);
        vscode.window.showErrorMessage(
          `Failed to resolve conflict: ${error instanceof Error ? error.message : 'Unknown error'}`
        );
      }
    }

    vscode.window.showInformationMessage('✓ All SyncThing conflicts resolved');
    
    // Reload notes
    await this.handleLoadNotes();
  }

  /**
   * Schedule auto-save with debouncing
   */
  public scheduleAutoSave(notesData: NotesData): void {
    const config = getConfig();

    if (!config.storage.autoSave) {
      return;
    }

    // Clear existing timeout
    if (this.autoSaveTimeout) {
      clearTimeout(this.autoSaveTimeout);
    }

    // Schedule new save
    this.autoSaveTimeout = setTimeout(async () => {
      await this.handleSaveNotes(notesData);
    }, config.storage.autoSaveInterval);
  }

  /**
   * Create a manual backup
   */
  public async createBackup(): Promise<void> {
    try {
      const backupPath = await this.storageService.createBackup();

      if (backupPath) {
        vscode.window
          .showInformationMessage(`Backup created successfully: ${backupPath}`, 'Open Backup Folder')
          .then((selection) => {
            if (selection === 'Open Backup Folder') {
              this.openStorageFolder();
            }
          });
      } else {
        vscode.window.showInformationMessage('No notes file found to backup.');
      }
    } catch (error) {
      console.error('Failed to create backup:', error);
      vscode.window.showErrorMessage(`Failed to create backup: ${error}`);
    }
  }

  /**
   * Restore from backup
   */
  public async restoreFromBackup(): Promise<void> {
    try {
      const backups = await this.storageService.getBackupList();

      if (backups.length === 0) {
        vscode.window.showInformationMessage('No backups found.');
        return;
      }

      // Create quick pick items
      const items = backups.map((backup) => ({
        label: backup.name,
        description: backup.date.toLocaleString(),
        detail: backup.path,
        backup
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a backup to restore',
        matchOnDescription: true,
        matchOnDetail: true
      });

      if (!selected) {
        return;
      }

      // Confirm restoration
      const confirm = await vscode.window.showWarningMessage(
        `Are you sure you want to restore from backup "${selected.label}"? This will overwrite your current notes.`,
        { modal: true },
        'Restore',
        'Cancel'
      );

      if (confirm !== 'Restore') {
        return;
      }

      // Restore the backup
      const restoredData = await this.storageService.restoreFromBackup(selected.backup.path);

      // Notify webview of the restored data
      if (this._view) {
        this._view.webview.postMessage({
          type: 'notesRestored',
          data: restoredData
        });
      }

      vscode.window.showInformationMessage('Notes restored successfully from backup.');
    } catch (error) {
      console.error('Failed to restore from backup:', error);
      vscode.window.showErrorMessage(`Failed to restore from backup: ${error}`);
    }
  }

  /**
   * Open storage folder in file explorer
   */
  public async openStorageFolder(): Promise<void> {
    try {
      const config = getConfig();
      let folderPath: string;

      if (config.storage.location === 'custom' && config.storage.customPath) {
        folderPath = config.storage.customPath;
      } else {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (!workspaceFolder) {
          vscode.window.showErrorMessage('No workspace folder found.');
          return;
        }
        folderPath = vscode.Uri.joinPath(workspaceFolder.uri, '.vscode').fsPath;
      }

      const folderUri = vscode.Uri.file(folderPath);
      await vscode.commands.executeCommand('vscode.openFolder', folderUri, { forceNewWindow: true });
    } catch (error) {
      console.error('Failed to open storage folder:', error);
      vscode.window.showErrorMessage(`Failed to open storage folder: ${error}`);
    }
  }

  /**
   * Reset migration state (for debugging)
   */
  public async resetMigration(): Promise<void> {
    try {
      const confirm = await vscode.window.showWarningMessage(
        'This will reset the migration state and force re-migration on next startup. This is intended for debugging purposes only.',
        { modal: true },
        'Reset',
        'Cancel'
      );

      if (confirm !== 'Reset') {
        return;
      }

      await this.migrationService.resetMigration();
      vscode.window.showInformationMessage('Migration state reset. Extension will re-migrate on next reload.');
    } catch (error) {
      console.error('Failed to reset migration:', error);
      vscode.window.showErrorMessage(`Failed to reset migration: ${error}`);
    }
  }

  /**
   * Open Settings UI and search for Better Sidebar Markdown Notes
   */
  public openSettings(): void {
    vscode.commands.executeCommand('workbench.action.openSettings', 'Better Sidebar Markdown Notes');
  }

  /**
   * Start the import notes process
   */
  public async importNotes(): Promise<void> {
    try {
      // First, determine what to scan BEFORE opening the modal
      // This avoids the Quick Pick and modal competing for focus
      const availablePaths = await this.importService.getAvailableScanPaths();
      let scanPath = '';
      let isOldExtension = false;

      // Always show Quick Pick to let user choose between Auto Scan and Scan Directory
      const items = availablePaths.map((p) => ({
        label: p.name,
        description: p.description || p.path,
        detail: p.description ? undefined : p.path,
        path: p.path,
        isOldExtension: p.isOldExtension || false
      }));

      items.push({
        label: 'Scan Directory...',
        description: 'Choose a directory to scan for markdown files and text notes to import',
        detail: undefined,
        path: '',
        isOldExtension: false
      });

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select import source'
      });

      if (!selected) {
        return; // User cancelled
      }

      if (selected.path === '') {
        // User wants to select custom folder
        const customPath = await this.importService.selectCustomScanPath();
        if (!customPath) {
          return; // User cancelled
        }
        scanPath = customPath;
      } else {
        scanPath = selected.path;
        // Look up if this is an old extension path
        const matchingPath = availablePaths.find((p) => p.path === scanPath);
        isOldExtension = matchingPath?.isOldExtension || false;
      }

      // Now open the modal and start scanning
      if (this._view) {
        this._view.webview.postMessage({
          type: 'openImportModal'
        });
      }

      // Start scanning with the determined path
      await this.startNoteScan(scanPath, isOldExtension);
    } catch (error) {
      console.error('Error opening import modal:', error);
      vscode.window.showErrorMessage(
        `Failed to open import dialog: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Start scanning for notes in the specified path
   */
  private async startNoteScan(scanPath: string, isOldExtensionPath: boolean = false): Promise<void> {
    try {
      vscode.window.showInformationMessage('Scanning for markdown notes...');

      let discoveredNotes;

      // If this is an old extension storage path, recover directly from storage
      if (isOldExtensionPath) {
        console.log('[DEBUG] Recovering from old extension storage...');
        discoveredNotes = await this.importService.recoverOldExtensionNotes();
      } else {
        // Otherwise, scan the directory for markdown files
        discoveredNotes = await this.importService.scanForMarkdownFiles(scanPath);
      }

      if (discoveredNotes.length === 0) {
        vscode.window.showInformationMessage('No markdown notes found to import.');
        return;
      }

      // Send discovered notes to webview for user selection
      if (this._view) {
        this._view.webview.postMessage({
          type: 'notesDiscovered',
          data: {
            notes: discoveredNotes,
            scanPath: scanPath
          }
        });
      }

      vscode.window.showInformationMessage(
        `Found ${discoveredNotes.length} markdown notes. Select which ones to import.`
      );
    } catch (error) {
      console.error('Failed to scan for notes:', error);
      vscode.window.showErrorMessage(
        `Failed to scan for notes: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  /**
   * Handle scan for notes request from webview
   */
  private async handleScanForNotes(scanPath: string): Promise<void> {
    try {
      console.log('[DEBUG handleScanForNotes] Received scanPath:', scanPath);
      // If no specific path provided, determine the best path to scan
      if (!scanPath) {
        // Get available scan paths
        const availablePaths = await this.importService.getAvailableScanPaths();
        console.log('[DEBUG handleScanForNotes] Available paths:', availablePaths);

        if (availablePaths.length === 0) {
          // No workspace folders, ask user to select a custom path
          const customPath = await this.importService.selectCustomScanPath();
          if (!customPath) {
            // User cancelled - close the import modal
            if (this._view) {
              this._view.webview.postMessage({
                type: 'closeImportModal'
              });
            }
            return;
          }
          scanPath = customPath;
        } else if (availablePaths.length === 1) {
          // Only one workspace folder, scan it directly
          scanPath = availablePaths[0].path;
          // Check if this is an old extension path
          if (availablePaths[0].isOldExtension) {
            await this.startNoteScan(scanPath, true);
            return;
          }
        } else {
          // Multiple workspace folders, let user choose
          const items = availablePaths.map((p) => ({
            label: p.name,
            description: p.path,
            path: p.path,
            isOldExtension: p.isOldExtension || false
          }));

          items.push({
            label: 'Select Custom Folder...',
            description: 'Choose a different folder to scan',
            path: '',
            isOldExtension: false
          });

          const selected = await vscode.window.showQuickPick(items, {
            placeHolder: 'Select folder to scan for markdown notes'
          });

          console.log('[DEBUG handleScanForNotes] Selected item:', selected);

          if (!selected) {
            // User cancelled - close the import modal
            console.log('[DEBUG handleScanForNotes] User cancelled Quick Pick, closing modal');
            if (this._view) {
              this._view.webview.postMessage({
                type: 'closeImportModal'
              });
            }
            vscode.window.showInformationMessage('Import cancelled');
            return;
          }

          if (selected.path === '') {
            // User wants to select custom folder
            const customPath = await this.importService.selectCustomScanPath();
            if (customPath) {
              scanPath = customPath;
            } else {
              // User cancelled custom folder selection - close the import modal
              if (this._view) {
                this._view.webview.postMessage({
                  type: 'closeImportModal'
                });
              }
              return;
            }
          } else {
            scanPath = selected.path;
            console.log(
              '[DEBUG handleScanForNotes] Selected path:',
              scanPath,
              'isOldExtension:',
              selected.isOldExtension
            );
            // Check if this path is an old extension path by looking it up in availablePaths
            const matchingPath = availablePaths.find((p) => p.path === scanPath);
            const isOldExtension = matchingPath?.isOldExtension || false;
            console.log('[DEBUG handleScanForNotes] Looked up path, isOldExtension:', isOldExtension);

            // If this is an old extension path, use the special recovery method
            if (isOldExtension) {
              console.log('[DEBUG handleScanForNotes] Calling startNoteScan with isOldExtension=true');
              await this.startNoteScan(scanPath, true);
              return;
            }
          }
        }
      }

      console.log('[DEBUG handleScanForNotes] Calling startNoteScan with isOldExtension=false for path:', scanPath);
      // Now scan the determined path
      await this.startNoteScan(scanPath, false);
    } catch (error) {
      console.error('Error during scan for notes:', error);
      vscode.window.showErrorMessage(`Scan failed: ${error instanceof Error ? error.message : 'Unknown error'}`);

      // Close the import modal on error
      if (this._view) {
        this._view.webview.postMessage({
          type: 'closeImportModal'
        });
      }
    }
  }

  /**
   * Handle import selected notes request from webview
   */
  private async handleImportSelectedNotes(data: {
    selectedNotes: DiscoveredNote[];
    conflictResolutions?:
      | Map<string, 'skip' | 'replace' | 'merge' | 'rename'>
      | Record<string, 'skip' | 'replace' | 'merge' | 'rename'>;
  }): Promise<void> {
    try {
      // Convert conflictResolutions from plain object to Map if needed
      // (postMessage serializes Maps to plain objects)
      let conflictResolutionsMap: Map<string, 'skip' | 'replace' | 'merge' | 'rename'> | undefined;
      if (data.conflictResolutions) {
        if (data.conflictResolutions instanceof Map) {
          conflictResolutionsMap = data.conflictResolutions;
        } else {
          // Convert plain object to Map
          conflictResolutionsMap = new Map(Object.entries(data.conflictResolutions));
        }
      }

      const result = await this.importService.importNotes(data.selectedNotes, conflictResolutionsMap);

      // Send result back to webview
      if (this._view) {
        this._view.webview.postMessage({
          type: 'importResult',
          data: result
        });
      }

      // Show summary message
      let message = `Import completed: ${result.imported} imported`;
      if (result.skippedBlank > 0) {
        message += `, ${result.skippedBlank} blank note${result.skippedBlank > 1 ? 's' : ''} skipped`;
      }
      if (result.skipped > 0) {
        message += `, ${result.skipped} duplicate${result.skipped > 1 ? 's' : ''} skipped`;
      }
      if (result.errors.length > 0) {
        message += `, ${result.errors.length} error${result.errors.length > 1 ? 's' : ''}`;
      }

      if (result.errors.length > 0) {
        vscode.window.showWarningMessage(message);
        console.error('Import errors:', result.errors);
      } else {
        vscode.window.showInformationMessage(message);
      }

      // Reload notes in webview if any were imported
      if (result.imported > 0) {
        await this.handleLoadNotes();
      }
    } catch (error) {
      console.error('Failed to import notes:', error);
      vscode.window.showErrorMessage(
        `Failed to import notes: ${error instanceof Error ? error.message : 'Unknown error'}`
      );
    }
  }

  public updateStatusBar(content?: string) {
    if (this._statusBar) {
      if (content) {
        this._statusBar.text = `${content}`;
        this._statusBar.show();
      } else {
        this._statusBar.hide();
      }
    }
  }

  private _getHtmlForWebview(webview: vscode.Webview) {
    // Add cache-busting timestamp to force webview to reload scripts/styles during development
    const cacheBuster = Date.now();
    
    const purifyUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'lib', 'purify.min.js'));

    const markedUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'lib', 'marked.min.js'));

    const lodashUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'lib', 'lodash.min.js'));

    // Get the local path to main script run in the webview, then convert it to a uri we can use in the webview.
    const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.js')) + `?v=${cacheBuster}`;

    // Do the same for the stylesheet.
    const styleResetUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'reset.css'));
    const markdownCss = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'markdown.css'));
    const styleVSCodeUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'vscode.css'));
    const styleMainUri = webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, 'media', 'main.css')) + `?v=${cacheBuster}`;

    // Use a nonce to only allow a specific script to be run.
    const nonce = this._getNonce();

    const config = JSON.stringify({
      leftMargin: this.config.leftMargin
    });

    return `<!DOCTYPE html>
			<html lang="en">
			<head>
				<meta charset="UTF-8">

				<!--
					Use a content security policy to only allow loading images from https or from our extension directory,
					and only allow scripts that have a specific nonce.
				-->
				<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${
          webview.cspSource
        }; script-src 'nonce-${nonce}';">

        <meta name="viewport" content="width=device-width, initial-scale=1.0">

        <link href="${styleResetUri}" rel="stylesheet">
        <link href="${styleVSCodeUri}" rel="stylesheet">
        <link href="${markdownCss}" rel="stylesheet">
				<link href="${styleMainUri}" rel="stylesheet">

				<title>Workspace Sidebar Notes</title>
			</head>
      <body>
        <div id="save-status" class="save-status"></div>

        <!-- Note Browser Modal -->
        <div id="note-browser-modal" class="modal hidden">
          <div class="modal-content">
            <div class="modal-header">
              <h3>Browse Notes</h3>
              <div class="modal-header-actions">
                <button id="add-new-note-modal" class="icon-only-button" aria-label="Add new note" title="Add new note">
                  <svg class="toolbar-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                    <line x1="12" y1="5" x2="12" y2="19"/>
                    <line x1="5" y1="12" x2="19" y2="12"/>
                  </svg>
                </button>
                <button id="close-browser" class="close-button" aria-label="Close note browser" title="Close note browser">
                  <span class="codicon codicon-close"></span>
                </button>
              </div>
            </div>
            <div class="modal-body">
              <div class="notes-navigation">
                <div class="notes-nav-top">
                  <button id="prev-note-nav" class="nav-button" title="Previous note">
                    <svg class="toolbar-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <polyline points="15 18 9 12 15 6"/>
                    </svg>
                  </button>
                  <span id="note-counter">1 of 1</span>
                  <button id="next-note-nav" class="nav-button" title="Next note">
                    <svg class="toolbar-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                      <polyline points="9 18 15 12 9 6"/>
                    </svg>
                  </button>
                  <div class="bookmark-filter">
                    <label for="bookmark-filter-select">Show:</label>
                    <select id="bookmark-filter-select" class="filter-select">
                      <option value="all">All Notes</option>
                      <option value="bookmarked">Bookmarked</option>
                    </select>
                  </div>
                </div>
              </div>
              <div id="notes-list" class="notes-list">
                <!-- Notes will be populated here -->
              </div>
            </div>
            <div class="modal-footer">
              <div class="modal-footer-left">
                <span id="browser-selection-count" class="selection-count">0 selected</span>
                <button id="browser-select-all" class="secondary-button" aria-label="Select all visible notes" title="Select all visible notes">
                  <span class="codicon codicon-check-all"></span>
                </button>
                <button id="browser-deselect-all" class="secondary-button" aria-label="Deselect all notes" title="Deselect all notes">
                  <span class="codicon codicon-close-all"></span>
                </button>
                <button id="browser-bookmark-selected" class="secondary-button" aria-label="Bookmark selected notes" title="Bookmark selected notes">
                  <span class="codicon codicon-star-full"></span>
                </button>
                <button id="browser-unbookmark-selected" class="secondary-button" aria-label="Remove bookmark from selected notes" title="Remove bookmark from selected notes">
                  <span class="codicon codicon-star-empty"></span>
                </button>
              </div>
              <div class="modal-footer-right">
                <button id="delete-selected-notes-footer" class="primary-button danger hidden" aria-label="Delete selected notes" title="Delete selected notes">
                  <span class="codicon codicon-trash"></span>
                </button>
              </div>
            </div>
          </div>
        </div>        <!-- Import Notes Modal -->
        <div id="import-notes-modal" class="modal hidden">
          <div class="modal-content import-modal-content">
            <div class="modal-header">
              <h3>Import Markdown Notes</h3>
              <button id="close-import" class="close-button" title="Close import dialog">
                <span class="codicon codicon-close"></span>
              </button>
            </div>
            <div class="modal-body">
              <div id="import-scanning" class="import-section hidden">
                <div class="scanning-indicator">
                  <span class="codicon codicon-loading codicon-modifier-spin"></span>
                  <span>Scanning for markdown notes...</span>
                </div>
              </div>

              <div id="import-selection" class="import-section hidden">
                <div class="import-header">
                  <div class="import-stats">
                    <span id="notes-found-count">0 notes found</span>
                    <span id="notes-selected-count">0 selected</span>
                  </div>
                  <div class="import-actions">
                    <button id="select-all-notes" class="secondary-button">Select All</button>
                    <button id="deselect-all-notes" class="secondary-button">Deselect All</button>
                  </div>
                </div>

                <div class="import-filter">
                  <label for="note-filter">Filter:</label>
                  <select id="note-filter" class="filter-select">
                    <option value="all">All</option>
                    <option value="old-extension">Old Extension</option>
                    <option value="workspace">Workspace Files</option>
                  </select>
                </div>

                <div id="discovered-notes-list" class="discovered-notes-list">
                  <!-- Discovered notes will be populated here -->
                </div>
              </div>

              <div id="import-conflicts" class="import-section hidden">
                <h4>Resolve Conflicts</h4>
                <p>Some notes may conflict with existing content. Choose how to handle each conflict:</p>
                <div id="conflicts-list" class="conflicts-list">
                  <!-- Conflicts will be populated here -->
                </div>
              </div>

              <div id="import-results" class="import-section hidden">
                <div class="import-summary">
                  <h4>Import Complete</h4>
                  <div id="import-summary-stats">
                    <!-- Import results will be shown here -->
                  </div>
                </div>
              </div>
            </div>
            <div class="modal-footer">
              <button id="import-selected-notes" class="primary-button hidden">
                <span class="codicon codicon-cloud-download"></span>
                Import Selected Notes
              </button>
              <button id="resolve-conflicts-btn" class="primary-button hidden">
                <span class="codicon codicon-check"></span>
                Resolve Conflicts
              </button>
              <button id="finish-import-btn" class="primary-button hidden">
                <span class="codicon codicon-check"></span>
                Finish
              </button>
              <button id="cancel-import" class="secondary-button">Cancel</button>
            </div>
          </div>
        </div>

        <!-- Confirmation Modal (used for delete confirmations) -->
        <div id="confirm-modal" class="modal hidden">
          <div class="modal-content confirm-modal-content">
            <div class="modal-header">
              <h3 id="confirm-title">Confirm</h3>
            </div>
            <div class="modal-body">
              <p id="confirm-message">Are you sure?</p>
            </div>
            <div class="modal-footer">
              <button id="confirm-no" class="primary-button">Cancel</button>
              <button id="confirm-yes" class="primary-button danger">Delete</button>
            </div>
          </div>
        </div>

        <!-- Toast container for transient messages (Undo) -->
        <div id="toast-container" class="toast-container"></div>
        
        <div id="no-workspace-message" class="no-workspace-container hidden">
          <div class="no-workspace-content">
            <div class="no-workspace-icon">
              <span class="codicon codicon-folder-opened"></span>              code --install-extension better-sidebar-markdown-notes-1.2.0.vsix
            </div>
            <h2>NO NOTES - OPEN A WORKSPACE FIRST</h2>
            <p class="no-workspace-description">
              Workspace Sidebar Notes works best with an open workspace folder.
              Your notes will be stored in the workspace's <code>.vscode</code> folder
              and automatically sync across devices via cloud storage.
            </p>

            <div class="no-workspace-actions">
              <button id="open-workspace-btn" class="primary-button">
                <span class="codicon codicon-folder-opened"></span>
                Open Workspace
              </button>

              <button id="select-location-btn" class="secondary-button">
                <span class="codicon codicon-folder"></span>
                Select Custom Location
              </button>
            </div>

            <div class="storage-info">
              <div class="info-section">
                <h4><span class="codicon codicon-cloud"></span> Workspace Storage (Recommended)</h4>
                <p>Notes stored in <code>.vscode/workspace-notes.json</code></p>
                <ul>
                  <li>✅ Automatic cloud sync (OneDrive, Google Drive, etc.)</li>
                  <li>✅ Project-specific notes</li>
                  <li>✅ Version control friendly</li>
                </ul>
              </div>

              <div class="info-section">
                <h4><span class="codicon codicon-folder"></span> Custom Location</h4>
                <p>Notes stored in your chosen directory</p>
                <ul>
                  <li>⚠️ Manual cloud sync setup required</li>
                  <li>✅ Global notes across all projects</li>
                  <li>✅ Full control over location</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        <!-- In-page search bar (Ctrl+F) -->
        <div id="search-bar" class="search-bar hidden" role="search">
          <input type="text" id="search-input" placeholder="Find" autocomplete="off" spellcheck="false" />
          <span id="search-count" class="search-count">0/0</span>
          <button id="search-prev" class="search-btn" title="Previous (Shift+Enter)">
            <span class="codicon codicon-arrow-left"></span>
          </button>
          <button id="search-next" class="search-btn" title="Next (Enter)">
            <span class="codicon codicon-arrow-right"></span>
          </button>
          <button id="search-case" class="search-btn" title="Match case">Aa</button>
          <button id="search-close" class="search-btn" title="Close (Esc)">
            <span class="codicon codicon-close"></span>
          </button>
        </div>

        <div id="render"></div>
        <div id="content">
          <div id="search-highlights" class="search-highlights" aria-hidden="true"></div>
          <textarea id="text-input" name="text-input" placeholder="Start by typing your markdown notes..."></textarea>
        </div>

        <!-- Bottom toolbar with all action buttons -->
        <div id="bottom-toolbar">
          <button id="toolbar-add-note" class="bottom-button icon-only" title="Add new note">
            <svg class="toolbar-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/>
              <polyline points="14 2 14 8 20 8"/>
              <line x1="12" y1="12" x2="12" y2="18"/>
              <line x1="9" y1="15" x2="15" y2="15"/>
            </svg>
          </button>
          <button id="toolbar-prev" class="bottom-button icon-only" title="Previous page">
            <svg class="toolbar-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <button id="toolbar-next" class="bottom-button icon-only" title="Next page">
            <svg class="toolbar-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <polyline points="9 18 15 12 9 6"/>
            </svg>
          </button>
          <button id="toolbar-browse" class="bottom-button icon-only" title="Browse notes">
            <span class="codicon codicon-list-unordered"></span>
          </button>
          <button id="toolbar-bookmark" class="bottom-button icon-only" title="Toggle bookmark">
            <span class="codicon codicon-star-empty"></span>
          </button>
          <button id="toolbar-preview" class="bottom-button icon-only" title="Toggle preview">
            <span class="codicon codicon-open-preview"></span>
          </button>
          <button id="toolbar-export" class="bottom-button icon-only" title="Export page">
            <svg class="toolbar-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="17 8 12 3 7 8"/>
              <line x1="12" y1="3" x2="12" y2="15"/>
            </svg>
          </button>
          <button id="toolbar-import" class="bottom-button icon-only" title="Import notes">
            <svg class="toolbar-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>
              <polyline points="7 10 12 15 17 10"/>
              <line x1="12" y1="15" x2="12" y2="3"/>
            </svg>
          </button>
          <span class="toolbar-spacer"></span>
          <button id="save-button" class="bottom-button icon-only" title="Save notes manually">
            <span class="codicon codicon-save"></span>
          </button>
          <button id="options-button" class="bottom-button icon-only" title="Open extension settings">
            <span class="codicon codicon-settings-gear"></span>
          </button>
        </div>

        <script nonce="${nonce}">
          (function () {
            const renderElement = document.getElementById('render');
            const editorElement = document.getElementById('content');

            renderElement.style.paddingLeft = ${this.config.leftMargin === true ? '"20px"' : '"0px"'};
            editorElement.style.paddingLeft = ${this.config.leftMargin === true ? '"20px"' : '"0px"'};
          })();
        </script>
        <script nonce="${nonce}" src="${lodashUri}"></script>
        <script nonce="${nonce}" src="${purifyUri}"></script>
        <script nonce="${nonce}" src="${markedUri}"></script>
        <script nonce="${nonce}">var config = ${config};</script>
				<script nonce="${nonce}" src="${scriptUri}"></script>
			</body>
			</html>`;
  }

  /**
   * Handle opening a workspace folder
   */
  private async handleOpenWorkspace(): Promise<void> {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Open Workspace Folder'
    });

    if (result && result[0]) {
      await vscode.commands.executeCommand('vscode.openFolder', result[0]);
      // The extension will be reloaded when the workspace opens
    }
  }

  /**
   * Handle selecting a custom storage location
   */
  private async handleSelectCustomLocation(): Promise<void> {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select Notes Storage Location'
    });

    if (result && result[0]) {
      let customPath = result[0].fsPath;

      // If user selected a project root, prefer its .vscode folder if it exists
      try {
        const possibleVscode = path.join(customPath, '.vscode');
        const notesFileInVscode = path.join(possibleVscode, 'sidebar-notes.json');

        // If .vscode exists or contains an existing notes file, ask user whether to use it
        const hasNotesFile = fs.existsSync(notesFileInVscode);
        const hasVscodeFolder = fs.existsSync(possibleVscode);

        if (hasNotesFile || hasVscodeFolder) {
          const choice = await vscode.window.showWarningMessage(
            hasNotesFile
              ? `A .vscode folder with existing notes was detected at:\n${possibleVscode}\nUse this .vscode folder for storing notes?`
              : `A .vscode folder was detected at:\n${possibleVscode}\nUse this .vscode folder to store notes?`,
            { modal: true },
            'Use .vscode',
            'Use selected folder',
            'Cancel'
          );

          if (choice === 'Use .vscode') {
            customPath = possibleVscode;
          } else if (choice === 'Use selected folder') {
            // keep the selected folder
          } else {
            // Cancel - do nothing
            return;
          }
        }
      } catch (err) {
        console.warn('[WebviewProvider] Error checking for .vscode folder:', err);
      }

      // Update configuration to use custom location
      const config = vscode.workspace.getConfiguration('better-sidebar-markdown-notes');
  await config.update('storage.location', 'custom', vscode.ConfigurationTarget.Global);
  await config.update('storage.customPath', customPath, vscode.ConfigurationTarget.Global);

      // Show success message
      vscode.window.showInformationMessage(`Notes will now be stored in: ${customPath}`, 'OK');

      // Reload the extension with new configuration
      this.config = getConfig();
      this.storageService = new StorageService(this.context);

      // Notify webview that custom location was selected
      if (this._view) {
        this._view.webview.postMessage({ type: 'customLocationSelected' });
      }

      // Load data from new location
      await this.handleInitialDataRequest();
    }
  }

  private _getNonce() {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }
}
