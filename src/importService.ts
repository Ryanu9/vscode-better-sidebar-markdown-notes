import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import * as zlib from 'zlib';
import { StorageService, NotesData } from './storageService';

export interface DiscoveredNote {
  filePath: string;
  fileName: string;
  content: string;
  size: number;
  lastModified: Date;
  relativePath: string;
  isMarkdown: boolean;
  wordCount: number;
  preview: string;
  isOldExtensionNote?: boolean; // Flag to indicate this came from old extension
  source?: string; // Label indicating where this note came from (e.g., "Old Extension", "Workspace Files")
}

export interface ImportResult {
  imported: number;
  skipped: number;
  skippedBlank: number; // Blank/template notes that were intentionally skipped
  errors: string[];
  conflicts: ConflictInfo[];
}

export interface ConflictInfo {
  fileName: string;
  existingContent: string;
  newContent: string;
  resolution: 'skip' | 'replace' | 'merge' | 'rename';
}

export class ImportService {
  private readonly markdownExtensions = ['.md', '.markdown', '.mdown', '.mkd', '.mkdn'];
  private readonly maxPreviewLength = 200;
  // Old extension ID (lowercase - as registered in VS Code)
  private readonly oldExtensionId = 'assisrmatheus.sidebar-markdown-notes';
  // Old extension storage directory names (can have different casing than the ID)
  private readonly oldExtensionStorageDirs = [
    'AssisrMatheus.sidebar-markdown-notes', // Actual storage dir name on disk
    'assisrmatheus.sidebar-markdown-notes', // Fallback
    'assisrMatheus.sidebar-markdown-notes' // Another possible variation
  ];
  private readonly excludedPatterns = [
    'node_modules',
    '.git',
    '.vscode',
    'dist',
    'build',
    'out',
    '.next',
    '.nuxt',
    'coverage',
    '.nyc_output'
  ];

  constructor(private context: vscode.ExtensionContext, private storageService: StorageService) {}

  /**
   * Check if the old sidebar-markdown-notes extension is installed
   */
  public isOldExtensionInstalled(): boolean {
    return vscode.extensions.getExtension(this.oldExtensionId) !== undefined;
  }

  /**
   * Try to recover notes from the old extension's storage
   * This now does comprehensive scanning of all possible locations
   */
  public async recoverOldExtensionNotes(): Promise<DiscoveredNote[]> {
    const discoveredNotes: DiscoveredNote[] = [];

    try {
      console.log('=== Starting comprehensive note scan ===');

      // Priority 1: Try to recover from workspace storage (where webview state is stored)
      console.log('[SCAN] Checking workspace storage for old extension notes...');
      let recoveredData = await this.tryRecoverFromWorkspaceStorage();
      let sourceLabel = 'Old Extension';

      if (recoveredData && recoveredData.pages && Array.isArray(recoveredData.pages)) {
        console.log(`[SCAN] ✓ Found ${recoveredData.pages.length} pages in workspace storage`);
        sourceLabel = 'Old Extension (Workspace)';
      } else {
        console.log('[SCAN] ✗ No notes found in workspace storage');
      }

      // Priority 2: Check global storage for old extension
      if (!recoveredData) {
        console.log('[SCAN] Checking global storage...');
        recoveredData = await this.tryRecoverFromVSCodeStorage();

        if (recoveredData && recoveredData.pages) {
          console.log(`[SCAN] ✓ Found ${recoveredData.pages.length} pages in global storage`);
          sourceLabel = 'Old Extension (Global)';
        } else {
          console.log('[SCAN] ✗ No notes found in global storage');
        }
      }

      // Priority 3: Try webview state recovery
      if (!recoveredData) {
        console.log('[SCAN] Trying webview state recovery...');
        recoveredData = await this.tryRecoverWebviewState();

        if (recoveredData && recoveredData.pages) {
          console.log(`[SCAN] ✓ Found ${recoveredData.pages.length} pages in webview state`);
          sourceLabel = 'Old Extension (Webview State)';
        } else {
          console.log('[SCAN] ✗ No notes found in webview state');
        }
      }

      // Convert recovered old extension data to DiscoveredNote format
      if (recoveredData && recoveredData.pages && Array.isArray(recoveredData.pages)) {
        let skippedBlankCount = 0;
        recoveredData.pages.forEach((pageContent: string, index: number) => {
          if (typeof pageContent === 'string' && pageContent.trim()) {
            // Skip default welcome/filler text pages
            if (this.isDefaultWelcomeText(pageContent)) {
              console.log(`[SCAN] Skipping blank/template note at page ${index + 1}`);
              console.log(`[SCAN] First 100 chars: ${pageContent.substring(0, 100)}...`);
              skippedBlankCount++;
              return;
            }

            const fileName = `old-extension-page-${index + 1}.md`;

            discoveredNotes.push({
              filePath: 'vscode://old-extension-storage',
              fileName: fileName,
              content: pageContent,
              size: Buffer.byteLength(pageContent, 'utf8'),
              lastModified: new Date(),
              relativePath: fileName,
              isMarkdown: true,
              wordCount: this.countWords(pageContent),
              preview: this.generatePreview(pageContent),
              isOldExtensionNote: true,
              source: sourceLabel
            });
          }
        });
        
        if (skippedBlankCount > 0) {
          console.log(`[SCAN] ✓ Skipped ${skippedBlankCount} blank/template note${skippedBlankCount > 1 ? 's' : ''} (welcome pages with no content)`);
        }

        console.log(`[SCAN] Recovered ${discoveredNotes.length} notes from old extension`);

        // Check if the old extension is running - if so, we might not have all the notes
        const oldExtension = vscode.extensions.getExtension(this.oldExtensionId);
        if (oldExtension && oldExtension.isActive) {
          console.log('[SCAN] ⚠ Old extension is currently running');
          console.log('[SCAN] Notes may be held in memory and not accessible from storage');

          // Only show warning if we recovered a small number of notes (suggests incomplete recovery)
          if (discoveredNotes.filter((n) => n.isOldExtensionNote).length < 10) {
            await vscode.window
              .showWarningMessage(
                `Found ${discoveredNotes.filter((n) => n.isOldExtensionNote).length} notes from the old extension, ` +
                  `but the extension is currently running. If you have more notes:\n\n` +
                  `1. Open the old "Sidebar Markdown Notes" extension\n` +
                  `2. Use the Export button (📄) for each page to save as .md files\n` +
                  `3. Or disable the old extension, reload VS Code, then try importing again\n\n` +
                  `Notes stored in the old extension's memory cannot be accessed while it's running.`,
                'Open Old Extension',
                'Show Export Instructions'
              )
              .then(async (choice) => {
                if (choice === 'Open Old Extension') {
                  await vscode.commands.executeCommand('workbench.view.explorer');
                  await vscode.commands.executeCommand('sidebarMarkdownNotes.webview.focus');
                } else if (choice === 'Show Export Instructions') {
                  await this.showOldExtensionExportInstructions();
                }
              });
          }
        }
      }

      // Priority 4: Scan workspace folders for markdown files (limit to reasonable size)
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (workspaceFolders && workspaceFolders.length > 0) {
        console.log(`[SCAN] Scanning ${workspaceFolders.length} workspace folder(s) for markdown files...`);

        for (const folder of workspaceFolders) {
          try {
            // Only scan top-level and one level deep to avoid hanging on large projects
            const folderNotes = await this.scanForMarkdownFiles(folder.uri.fsPath, 1);
            console.log(`[SCAN] Found ${folderNotes.length} markdown files in ${folder.name}`);
            discoveredNotes.push(...folderNotes);
          } catch (scanError) {
            console.warn(`[SCAN] Failed to scan workspace folder ${folder.name}:`, scanError);
            // Continue with other folders
          }
        }
      }

      console.log(`[SCAN] Total notes found: ${discoveredNotes.length}`);

      // Show message if nothing found
      if (discoveredNotes.length === 0) {
        vscode.window.showInformationMessage('No notes found. Try selecting a custom folder to scan.');
      }
    } catch (error) {
      console.warn('[SCAN] Error during comprehensive scan:', error);
      vscode.window.showErrorMessage(`Scan failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return discoveredNotes;
  }

  /**
   * Show instructions for exporting from the old extension
   */
  private async showOldExtensionExportInstructions(): Promise<void> {
    const message =
      'Found the old sidebar-markdown-notes extension! To import your notes:\n\n' +
      '1. Open the old extension in the Explorer sidebar\n' +
      '2. For each page, click the Export button (📄) in the toolbar\n' +
      '3. Save each page as a .md file\n' +
      '4. Return here and import those .md files\n\n' +
      'Alternative: Copy and paste your notes directly into the new extension.';

    const action = await vscode.window.showInformationMessage(
      message,
      'Show Old Extension',
      'Run Export Command',
      'OK'
    );

    if (action === 'Show Old Extension') {
      // Focus the Explorer view where the old extension lives
      await vscode.commands.executeCommand('workbench.view.explorer');
    } else if (action === 'Run Export Command') {
      // Try to run the export command directly
      try {
        await vscode.commands.executeCommand('sidebar-markdown-notes.exportPage');
      } catch (error) {
        vscode.window.showWarningMessage(
          'Could not run export command. Please use the Export button in the old extension.'
        );
      }
    }
  }

  /**
   * Try to recover data from VSCode's storage mechanisms
   */
  private async tryRecoverFromVSCodeStorage(): Promise<any> {
    // Try multiple approaches to recover the old extension's data

    // Method -1: Try to get data from the running old extension directly
    try {
      console.log('[DEBUG] Attempting to access running old extension API...');
      const oldExtension = vscode.extensions.getExtension(this.oldExtensionId);
      if (oldExtension) {
        console.log('[DEBUG] Old extension found, isActive:', oldExtension.isActive);

        // Check if we can export via the extension's API
        if (oldExtension.isActive && oldExtension.exports) {
          console.log('[DEBUG] Old extension has exports:', Object.keys(oldExtension.exports || {}));

          // Some extensions expose a getState or getData method
          if (typeof oldExtension.exports.getState === 'function') {
            try {
              const state = await oldExtension.exports.getState();
              if (state && (state.pages || state.data)) {
                console.log('[DEBUG] ✓ Got state from old extension API!');
                return state;
              }
            } catch (apiError) {
              console.warn('[DEBUG] Failed to call getState():', apiError);
            }
          }

          // Try getData
          if (typeof oldExtension.exports.getData === 'function') {
            try {
              const data = await oldExtension.exports.getData();
              if (data && (data.pages || data.data)) {
                console.log('[DEBUG] ✓ Got data from old extension API!');
                return data;
              }
            } catch (apiError) {
              console.warn('[DEBUG] Failed to call getData():', apiError);
            }
          }

          // Try to access context.globalState or context.workspaceState if exposed
          if (oldExtension.exports.context) {
            console.log('[DEBUG] Old extension exposes context');
            try {
              const globalData = oldExtension.exports.context.globalState?.get('notes');
              if (globalData && (globalData.pages || globalData.data)) {
                console.log('[DEBUG] ✓ Got data from old extension global state!');
                return globalData;
              }

              const workspaceData = oldExtension.exports.context.workspaceState?.get('notes');
              if (workspaceData && (workspaceData.pages || workspaceData.data)) {
                console.log('[DEBUG] ✓ Got data from old extension workspace state!');
                return workspaceData;
              }
            } catch (ctxError) {
              console.warn('[DEBUG] Failed to access context state:', ctxError);
            }
          }
        }
      }
    } catch (error) {
      console.warn('[DEBUG] Could not access running old extension:', error);
    }

    // Method 0: Check workspace storage (where webview state is stored per-workspace)
    try {
      console.log('[DEBUG] Checking workspace storage for old extension data...');
      const workspaceData = await this.tryRecoverFromWorkspaceStorage();
      if (workspaceData) {
        console.log('[DEBUG] ✓ Found data in workspace storage!');
        return workspaceData;
      }
    } catch (error) {
      console.warn('[DEBUG] Could not check workspace storage:', error);
    }

    // Method 0b: Scan all workspace storage folders (including other workspaces)
    try {
      console.log('[DEBUG] Scanning all workspace storage folders for old extension data...');
      const allWorkspacesData = await this.scanAllWorkspaceStorageFolders();
      if (allWorkspacesData && allWorkspacesData.length > 0) {
        console.log(`[DEBUG] ✓ Found data in ${allWorkspacesData.length} workspace(s)`);
        // Return the combined/consolidated data
        if (allWorkspacesData.length === 1) {
          return allWorkspacesData[0];
        }
        // Merge all workspace data
        const mergedPages: string[] = [];
        const mergedState = allWorkspacesData[0].state || 'render';
        for (const workspace of allWorkspacesData) {
          if (workspace.pages && Array.isArray(workspace.pages)) {
            mergedPages.push(...workspace.pages);
          }
        }
        if (mergedPages.length > 0) {
          return {
            pages: mergedPages,
            state: mergedState,
            currentPage: 0,
            version: 2
          };
        }
      }
    } catch (error) {
      console.warn('[DEBUG] Could not scan all workspace storage folders:', error);
    }

    // Method 1: Check if we can access the old extension's context
    try {
      const oldExtension = vscode.extensions.getExtension(this.oldExtensionId);
      if (oldExtension && oldExtension.isActive) {
        // Extension is active, but we can't directly access its state
        console.log('Old extension is active but state is not directly accessible');
      }
    } catch (error) {
      console.warn('Could not check old extension status:', error);
    }

    // Method 2: Look for workspace-specific storage files that might contain the data
    try {
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (workspaceFolder) {
        const possiblePaths = [
          path.join(workspaceFolder.uri.fsPath, '.vscode', 'sidebar-markdown-notes.json'),
          path.join(workspaceFolder.uri.fsPath, '.vscode', 'notes.json'),
          path.join(workspaceFolder.uri.fsPath, '.vscode', 'webview-state.json')
        ];

        for (const filePath of possiblePaths) {
          try {
            if (await this.fileExists(filePath)) {
              const content = await fs.promises.readFile(filePath, 'utf8');
              const data = JSON.parse(content);
              if (data.pages || data.state) {
                return data;
              }
            }
          } catch (error) {
            // Continue to next path
          }
        }
      }
    } catch (error) {
      console.warn('Could not check workspace storage:', error);
    }

    // Method 3: Try to access VSCode's global storage for the old extension
    try {
      const globalStorageRoots = this.getVSCodeGlobalStoragePaths();
      console.log('[DEBUG] Global storage roots to check:', globalStorageRoots);

      for (const storageRoot of globalStorageRoots) {
        console.log(`[DEBUG] Checking storage root: ${storageRoot}`);
        for (const storageDirName of this.oldExtensionStorageDirs) {
          const oldExtensionStoragePath = path.join(storageRoot, storageDirName);
          console.log(`[DEBUG] Checking path: ${oldExtensionStoragePath}`);
          try {
            if (await this.fileExists(oldExtensionStoragePath)) {
              console.log(`[DEBUG] ✓ Path exists: ${oldExtensionStoragePath}`);
              const files = await fs.promises.readdir(oldExtensionStoragePath);
              console.log(`[DEBUG] Files found:`, files);
              for (const file of files) {
                const filePath = path.join(oldExtensionStoragePath, file);
                try {
                  if (file.endsWith('.json')) {
                    console.log(`[DEBUG] Reading JSON file: ${filePath}`);
                    const content = await fs.promises.readFile(filePath, 'utf8');
                    const data = JSON.parse(content);
                    console.log(`[DEBUG] Parsed data:`, {
                      hasPages: !!data.pages,
                      hasState: !!data.state,
                      hasData: !!data.data
                    });
                    if (data.pages || data.state || data.data) {
                      console.log(`[DEBUG] ✓ Found old extension data in: ${filePath}`);
                      return data;
                    }
                  } else if (file.toLowerCase().includes('state') || file.endsWith('.vscdb')) {
                    console.log(`[DEBUG] Attempting to parse vscdb file: ${filePath}`);
                    const parsed = await this.parseVscdbForOldNotes(filePath);
                    if (parsed && (parsed.pages || parsed.state || parsed.data)) {
                      console.log(`[DEBUG] ✓ Recovered old extension data from vscdb: ${filePath}`);
                      return parsed;
                    }
                  }
                } catch (fileError) {
                  console.warn(`[DEBUG] Error reading file ${filePath}:`, fileError);
                  // Continue to next file
                }
              }
            } else {
              console.log(`[DEBUG] ✗ Path does not exist: ${oldExtensionStoragePath}`);
            }
          } catch (pathError) {
            console.warn(`[DEBUG] Error checking path ${oldExtensionStoragePath}:`, pathError);
            // Continue to next id/root
          }
        }
      }
    } catch (error) {
      console.warn('Could not check global storage:', error);
    }

    return null;
  }

  /**
   * Try to recover data from VSCode's workspace storage
   * This is where webview state is stored per-workspace using vscode.getState()/setState()
   * We check BOTH the current workspace's storage AND the old extension's storage folder
   */
  private async tryRecoverFromWorkspaceStorage(): Promise<any> {
    try {
      // Get the current workspace's storage path
      // This points to the specific workspace storage directory for the current workspace
      const workspaceStoragePath = this.context.storageUri?.fsPath;

      if (!workspaceStoragePath) {
        console.log('[DEBUG] No workspace storage path available (no workspace open?)');
        return null;
      }

      console.log(`[DEBUG] Checking current workspace storage: ${workspaceStoragePath}`);

      // The workspace storage path looks like: .../workspaceStorage/<hash>/therealgorgan.better-sidebar-markdown-notes
      // We need to go up to the workspace hash directory where state.vscdb lives
      // state.vscdb is at: .../workspaceStorage/<hash>/state.vscdb
      const workspaceHashDir = path.dirname(workspaceStoragePath);
      const workspaceHash = path.basename(workspaceHashDir);

      console.log(`[DEBUG] Workspace hash: ${workspaceHash}`);
      console.log(`[DEBUG] Workspace hash directory: ${workspaceHashDir}`);

      // First, check if the old extension's storage folder exists in this workspace
      // Try both possible extension IDs
      const oldExtensionIds = ['assisrmatheus.sidebar-markdown-notes', 'AssisrMatheus.sidebar-markdown-notes'];

      for (const oldId of oldExtensionIds) {
        const oldExtensionDir = path.join(workspaceHashDir, oldId);
        console.log(`[DEBUG] Checking for old extension folder: ${oldExtensionDir}`);

        if (await this.fileExists(oldExtensionDir)) {
          console.log(`[DEBUG] ✓ Found old extension workspace folder: ${oldExtensionDir}`);

          // Check for state.vscdb in the old extension's folder
          const oldExtStateDb = path.join(oldExtensionDir, 'state.vscdb');
          if (await this.fileExists(oldExtStateDb)) {
            console.log(`[DEBUG] ✓ Found old extension's state.vscdb: ${oldExtStateDb}`);
            const result = await this.extractWebviewStateFromVscdb(oldExtStateDb);
            if (result) {
              return result;
            }
          }

          // Also scan any JSON files the old extension might have written in its workspace folder
          try {
            const files = await fs.promises.readdir(oldExtensionDir);
            for (const file of files) {
              if (file.toLowerCase().endsWith('.json')) {
                const jsonPath = path.join(oldExtensionDir, file);
                try {
                  const content = await fs.promises.readFile(jsonPath, 'utf8');
                  const data = JSON.parse(content);
                  if (data && (Array.isArray(data.pages) || data.state || data.currentPage)) {
                    console.log(`[DEBUG] ✓ Found JSON with pages/state in old extension folder: ${jsonPath}`);
                    return data;
                  }
                } catch (jsonErr) {
                  console.warn(`[DEBUG] Failed to parse JSON in old extension folder: ${jsonPath}`, jsonErr);
                }
              }
            }
          } catch (dirErr) {
            console.warn('[DEBUG] Failed scanning old extension workspace folder for JSON:', dirErr);
          }
        }
      }

      // Also check the workspace-level state.vscdb (parent of our extension's folder)
      const stateDbPath = path.join(workspaceHashDir, 'state.vscdb');

      if (!(await this.fileExists(stateDbPath))) {
        console.log(`[DEBUG] No state.vscdb found in current workspace storage`);
        return null;
      }

      console.log(`[DEBUG] ✓ Found workspace state.vscdb at: ${stateDbPath}`);
      return await this.extractWebviewStateFromVscdb(stateDbPath);
    } catch (error) {
      console.warn('Error recovering from workspace storage:', error);
      return null;
    }
  }

  /**
   * Scan all workspace storage folders on the system for old extension notes
   * This allows importing notes from other workspaces on the same machine
   */
  private async scanAllWorkspaceStorageFolders(): Promise<any[]> {
    const results: any[] = [];

    try {
      const workspaceStorageRoots = this.getWorkspaceStoragePaths();
      console.log('[DEBUG] Scanning workspace storage roots:', workspaceStorageRoots);

      // Build a set of active workspace folder paths to filter matches
      const activeWorkspacePaths = new Set<string>();
      const wsFolders = vscode.workspace.workspaceFolders || [];
      for (const f of wsFolders) {
        activeWorkspacePaths.add(this.normalizePath(f.uri.fsPath));
      }

      for (const storageRoot of workspaceStorageRoots) {
        if (!(await this.fileExists(storageRoot))) {
          console.log(`[DEBUG] Workspace storage root does not exist: ${storageRoot}`);
          continue;
        }

        console.log(`[DEBUG] Scanning workspace storage root: ${storageRoot}`);
        const workspaceDirs = await fs.promises.readdir(storageRoot);

        for (const workspaceHash of workspaceDirs) {
          const workspaceHashDir = path.join(storageRoot, workspaceHash);
          const stats = await fs.promises.stat(workspaceHashDir);

          if (!stats.isDirectory()) {
            continue;
          }

          console.log(`[DEBUG] Checking workspace hash directory: ${workspaceHashDir}`);

          // Only consider this workspace hash if its workspace.json points to one of the active folders
          const isCurrent = await this.isWorkspaceHashForCurrentWorkspace(workspaceHashDir, activeWorkspacePaths);
          if (!isCurrent) {
            // Skip other workspaces to avoid cross-import confusion
            continue;
          }

          // Look for old extension's storage folder or state.vscdb with old extension data
          const oldExtensionIds = ['assisrmatheus.sidebar-markdown-notes', 'AssisrMatheus.sidebar-markdown-notes'];

          for (const oldId of oldExtensionIds) {
            const oldExtensionDir = path.join(workspaceHashDir, oldId);

            if (await this.fileExists(oldExtensionDir)) {
              console.log(`[DEBUG] Found old extension folder: ${oldExtensionDir}`);

              const oldExtStateDb = path.join(oldExtensionDir, 'state.vscdb');
              if (await this.fileExists(oldExtStateDb)) {
                console.log(`[DEBUG] Extracting from: ${oldExtStateDb}`);
                const data = await this.extractWebviewStateFromVscdb(oldExtStateDb);
                if (data && data.pages && Array.isArray(data.pages)) {
                  console.log(`[DEBUG] ✓ Found ${data.pages.length} pages in workspace ${workspaceHash}`);
                  results.push(data);
                }
              }
            }
          }

          // Also check workspace-level state.vscdb
          const stateDbPath = path.join(workspaceHashDir, 'state.vscdb');
          if (await this.fileExists(stateDbPath)) {
            console.log(`[DEBUG] Checking workspace-level state.vscdb: ${stateDbPath}`);
            const data = await this.extractWebviewStateFromVscdb(stateDbPath);
            if (data && data.pages && Array.isArray(data.pages)) {
              console.log(`[DEBUG] ✓ Found ${data.pages.length} pages in workspace state.vscdb`);
              results.push(data);
            }
          }
        }
      }
    } catch (error) {
      console.warn('[DEBUG] Error scanning workspace storage folders:', error);
    }

    return results;
  }

  // Determine whether a workspaceStorage hash directory corresponds to the currently open workspace(s)
  private async isWorkspaceHashForCurrentWorkspace(
    workspaceHashDir: string,
    activeWorkspacePaths: Set<string>
  ): Promise<boolean> {
    try {
      const wsJsonPath = path.join(workspaceHashDir, 'workspace.json');
      if (!(await this.fileExists(wsJsonPath))) {
        return false;
      }
      const raw = await fs.promises.readFile(wsJsonPath, 'utf8');
      const data = JSON.parse(raw);

      const candidates: string[] = [];
      if (typeof data.folder === 'string') {
        candidates.push(data.folder);
      }
      if (Array.isArray(data.folders)) {
        for (const entry of data.folders) {
          if (typeof entry === 'string') {
            candidates.push(entry);
          } else if (entry && typeof entry.uri === 'string') {
            candidates.push(entry.uri);
          } else if (entry && typeof entry.path === 'string') {
            candidates.push(entry.path);
          }
        }
      }

      for (const uriOrPath of candidates) {
        try {
          let fsPath: string;
          if (uriOrPath.startsWith('file://')) {
            fsPath = vscode.Uri.parse(uriOrPath).fsPath;
          } else {
            fsPath = uriOrPath;
          }
          if (activeWorkspacePaths.has(this.normalizePath(fsPath))) {
            return true;
          }
        } catch {
          // ignore bad entries
        }
      }
    } catch {
      // ignore
    }
    return false;
  }

  private normalizePath(p: string): string {
    return path.normalize(p).replace(/\\/g, '/').toLowerCase();
  }

  /**
   * Get all workspace storage root paths on the system
   */
  private getWorkspaceStoragePaths(): string[] {
    const paths: string[] = [];

    // Windows paths
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA;
      if (appData) {
        paths.push(path.join(appData, 'Code', 'User', 'workspaceStorage'));
        paths.push(path.join(appData, 'Code - Insiders', 'User', 'workspaceStorage'));
      }
    }
    // macOS paths
    else if (process.platform === 'darwin') {
      const home = process.env.HOME;
      if (home) {
        paths.push(path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'));
        paths.push(path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'workspaceStorage'));
      }
    }
    // Linux paths
    else {
      const home = process.env.HOME;
      const xdgConfig = process.env.XDG_CONFIG_HOME;

      if (xdgConfig) {
        paths.push(path.join(xdgConfig, 'Code', 'User', 'workspaceStorage'));
        paths.push(path.join(xdgConfig, 'Code - Insiders', 'User', 'workspaceStorage'));
      } else if (home) {
        paths.push(path.join(home, '.config', 'Code', 'User', 'workspaceStorage'));
        paths.push(path.join(home, '.config', 'Code - Insiders', 'User', 'workspaceStorage'));
      }
    }

    return paths;
  }

  /**
   * Extract webview state from a state.vscdb file
   */
  private async extractWebviewStateFromVscdb(stateDbPath: string): Promise<any> {
    try {
      // STRATEGY 1: Try native SQLite first (most reliable, requires Node 22.5.0+)
      try {
        console.log('[DEBUG] Attempting to read state.vscdb using native SQLite...');
        // @ts-ignore - Node.js experimental SQLite module
        // eslint-disable-next-line @typescript-eslint/naming-convention
        const { DatabaseSync } = await import('node:sqlite');
        const db = new DatabaseSync(stateDbPath, { readOnly: true });

        try {
          const query = db.prepare(
            "SELECT value FROM ItemTable WHERE key = 'memento/webviewView.sidebarMarkdownNotes.webview'"
          );
          const row = query.get();

          if (row && row.value) {
            console.log('[DEBUG] ✓ Found webview state in SQLite database');
            console.log('[DEBUG] Raw value type:', typeof row.value);
            console.log('[DEBUG] Raw value length:', row.value.length);

            let parsed;
            const valueStr = typeof row.value === 'string' ? row.value : row.value.toString('utf8');

            try {
              parsed = JSON.parse(valueStr);
              console.log('[DEBUG] ✓ Parsed value, keys:', Object.keys(parsed || {}));
            } catch (parseErr) {
              console.log('[DEBUG] Failed to parse value as JSON:', parseErr);
            }

            // VS Code often wraps webview state in {"webviewState": "..."} structure
            // where the value is a double-encoded JSON string
            if (parsed && parsed.webviewState) {
              console.log('[DEBUG] Found webviewState wrapper, unwrapping...');
              try {
                let unwrapped;
                if (typeof parsed.webviewState === 'string') {
                  unwrapped = JSON.parse(parsed.webviewState);
                  console.log('[DEBUG] ✓ Parsed double-encoded webviewState');
                } else {
                  unwrapped = parsed.webviewState;
                }

                if (unwrapped && unwrapped.pages && Array.isArray(unwrapped.pages)) {
                  console.log(
                    `[DEBUG] ✓✓✓ Successfully extracted ${unwrapped.pages.length} pages from SQLite database`
                  );
                  db.close();
                  return unwrapped;
                }
              } catch (unwrapErr) {
                console.log('[DEBUG] Failed to unwrap webviewState:', unwrapErr);
              }
            }

            // Direct pages array (no wrapper)
            if (parsed && parsed.pages && Array.isArray(parsed.pages)) {
              console.log(`[DEBUG] ✓ Successfully extracted ${parsed.pages.length} pages from SQLite (direct)`);
              db.close();
              return parsed;
            }

            console.log('[DEBUG] SQLite value does not contain recognizable notes structure');
          } else {
            console.log('[DEBUG] No row found for old extension webview state key');
          }

          db.close();
        } catch (queryError) {
          console.log('[DEBUG] Error querying SQLite database:', queryError);
          try {
            db.close();
          } catch {
            // ignore close errors
          }
        }
      } catch (sqliteError) {
        console.log('[DEBUG] Native SQLite not available or failed:', sqliteError);
        console.log('[DEBUG] Falling back to manual binary parsing...');
      }

      // STRATEGY 2: Fall back to binary parsing if SQLite unavailable
      const buffer = await fs.promises.readFile(stateDbPath);
      const content = buffer.toString('utf8');

      // Look for the old extension's webview state key
      const keyIndex = content.indexOf('memento/webviewView.sidebarMarkdownNotes.webview');

      if (keyIndex === -1) {
        console.log('[DEBUG] Old extension webview state key not found in state.vscdb');
        return null;
      }

      console.log('[DEBUG] ✓ Found old extension webview state key at position', keyIndex);

      const keyString = 'memento/webviewView.sidebarMarkdownNotes.webview';
      const keyBuffer = Buffer.from(keyString, 'utf8');
      const keyOffset = buffer.indexOf(keyBuffer);

      if (keyOffset === -1) {
        console.log('[DEBUG] Unable to locate key bytes within buffer');
        return null;
      }

      // Extract a chunk of data around the key to find the actual JSON value
      // SQLite stores key-value pairs, so the value should be near the key
      const chunkStart = Math.max(0, keyOffset - 2000);
      const chunkEnd = Math.min(buffer.length, keyOffset + 120000); // look further ahead (120 KB)
      const chunkBuffer = buffer.slice(chunkStart, chunkEnd);
      const chunk = chunkBuffer.toString('utf8');
      const sanitizedChunk = chunk.replace(/\u0000/g, '');
      const relativeKeyIndex = keyOffset - chunkStart;

      console.log(`[DEBUG] Examining ${chunk.length} bytes around key position`);
      console.log(
        '[DEBUG] Snippet near key:',
        sanitizedChunk.substring(relativeKeyIndex, Math.min(sanitizedChunk.length, relativeKeyIndex + 200))
      );
      console.log(
        '[DEBUG] Hex near key:',
        chunkBuffer.slice(relativeKeyIndex, Math.min(chunkBuffer.length, relativeKeyIndex + 64)).toString('hex')
      );

      // Pattern 1: Look for {"webviewState":"..."} near the key
      const webviewStatePattern1 = /\{"webviewState":"((?:[^"\\]|\\.)*)"\}/g;
      let matchesFound = false;
      let match: RegExpExecArray | null;

      while ((match = webviewStatePattern1.exec(sanitizedChunk)) !== null) {
        matchesFound = true;
        const escapedJson = match[1];
        console.log('[DEBUG] Found webviewState pattern near key (length:', escapedJson.length, ')');
        console.log('[DEBUG] webviewState snippet:', escapedJson.substring(0, 200));
        try {
          const unescapedJson = escapedJson.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
          const webviewState = JSON.parse(unescapedJson);

          if (webviewState.pages && Array.isArray(webviewState.pages)) {
            console.log(
              `[DEBUG] ✓ Successfully extracted ${webviewState.pages.length} pages from webviewState pattern`
            );
            return webviewState;
          }

          // Some variants might nest the data under a value/data key
          if (webviewState.value) {
            const decoded = this.tryDecodePotentialPayload(webviewState.value);
            if (decoded?.pages && Array.isArray(decoded.pages)) {
              console.log(`[DEBUG] ✓ Extracted ${decoded.pages.length} pages from webviewState.value payload`);
              return decoded;
            }
          }

          if (webviewState.data) {
            const decoded = this.tryDecodePotentialPayload(webviewState.data);
            if (decoded?.pages && Array.isArray(decoded.pages)) {
              console.log(`[DEBUG] ✓ Extracted ${decoded.pages.length} pages from webviewState.data payload`);
              return decoded;
            }
          }
        } catch (e) {
          console.log('[DEBUG] Failed to parse webviewState pattern:', e);
        }
      }

      if (!matchesFound) {
        console.log('[DEBUG] No webviewState patterns found near key');
      }

      // Pattern 2: Look for direct JSON with pages array {"pages":[...],"state":"..."}
      const directJsonPattern = /\{[^\{\}]{0,2000}?"pages"\s*:\s*\[[\s\S]{0,120000}?\}\}/g;
      while ((match = directJsonPattern.exec(sanitizedChunk)) !== null) {
        const jsonStr = match[0];
        console.log('[DEBUG] Found direct JSON pattern near key (length:', jsonStr.length, ')');
        console.log('[DEBUG] direct JSON snippet:', jsonStr.substring(0, 200));
        try {
          const parsedData = JSON.parse(jsonStr);

          if (parsedData.pages && Array.isArray(parsedData.pages)) {
            console.log(`[DEBUG] ✓ Successfully extracted ${parsedData.pages.length} pages from direct JSON pattern`);
            return parsedData;
          }
        } catch (e) {
          console.log('[DEBUG] Failed to parse direct JSON pattern:', e);
        }
      }

      // Pattern 3: Attempt UTF-16 decode and search for JSON
      const chunkUtf16 = chunkBuffer.toString('utf16le');
      const sanitizedUtf16 = chunkUtf16.replace(/\u0000/g, '');

      const pagesUtf16Index = sanitizedUtf16.indexOf('"pages"');
      if (pagesUtf16Index !== -1) {
        console.log(
          '[DEBUG] Found "pages" in UTF-16 chunk snippet:',
          sanitizedUtf16.substring(
            Math.max(0, pagesUtf16Index - 50),
            Math.min(sanitizedUtf16.length, pagesUtf16Index + 200)
          )
        );
      }

      const utf16JsonPattern = /\{[^\{\}]{0,2000}?"pages"\s*:\s*\[[\s\S]{0,120000}?\}\}/g;
      while ((match = utf16JsonPattern.exec(sanitizedUtf16)) !== null) {
        const utf16Json = match[0];
        console.log('[DEBUG] Found UTF-16 JSON candidate (length:', utf16Json.length, ')');
        console.log('[DEBUG] UTF-16 JSON snippet:', utf16Json.substring(0, 200));
        try {
          const parsedData = JSON.parse(utf16Json);
          if (parsedData.pages && Array.isArray(parsedData.pages)) {
            console.log(`[DEBUG] ✓ Successfully extracted ${parsedData.pages.length} pages from UTF-16 JSON`);
            return parsedData;
          }
        } catch (utf16Err) {
          console.log('[DEBUG] Failed to parse UTF-16 JSON candidate:', utf16Err);
        }
      }

      // Pattern 4: Look for just the pages array and try to reconstruct using bracket matching
      const reconstructed = this.tryExtractJsonViaBraces(sanitizedChunk, relativeKeyIndex);
      if (reconstructed && reconstructed.pages && Array.isArray(reconstructed.pages)) {
        console.log(`[DEBUG] ✓ Successfully extracted ${reconstructed.pages.length} pages using brace reconstruction`);
        return reconstructed;
      }

      // Pattern 5: Try the parseVscdbForOldNotes helper as last resort
      console.log('[DEBUG] Trying parseVscdbForOldNotes helper');
      const parsedData = await this.parseVscdbForOldNotes(stateDbPath);
      if (parsedData && parsedData.pages && Array.isArray(parsedData.pages)) {
        console.log(`[DEBUG] ✓ Successfully extracted ${parsedData.pages.length} pages using parseVscdbForOldNotes`);
        return parsedData;
      }

      // Check the binary value after the key to determine if a full-file scan is worth running
      // If the value is just a few bytes of binary (varint/empty marker), skip the expensive scan
      const valueStartOffset = keyOffset + keyBuffer.length;
      const valuePreview = buffer.slice(valueStartOffset, Math.min(buffer.length, valueStartOffset + 20));
      const valuePreviewHex = valuePreview.toString('hex');
      console.log('[DEBUG] Value preview after key (hex):', valuePreviewHex);

      // Pattern: short binary values like "01 40 92 33 03 67 03" indicate no JSON stored
      // Only run full-file scan if we see hints of actual JSON (curly braces, quotes, etc.)
      const hasJsonHints =
        valuePreview.includes('{') ||
        valuePreview.includes('"') ||
        valuePreview.includes('[') ||
        valuePreviewHex.includes('7b') || // {
        valuePreviewHex.includes('22') || // "
        valuePreviewHex.includes('5b'); // [

      if (!hasJsonHints) {
        console.log(
          '[DEBUG] Value after key is binary/empty (no JSON hints). Skipping expensive full-file scan for this workspace.'
        );
        console.log('[DEBUG] This workspace likely never had notes stored by the old extension.');
        console.log('[DEBUG] No valid data found near key position');
        return null;
      }

      // If we detected JSON hints, run a limited full-file scan (but cap the search)
      try {
        console.log('[DEBUG] Running limited full-file scan (detected JSON hints in value)...');
        const fullContent = buffer.toString('utf8');
        const fullSanitized = fullContent.replace(/\u0000/g, '');

        // Only search for the most likely patterns to avoid hanging
        // Pattern 1: escaped pages JSON
        const escapedPagesPattern = /\\"pages\\"\s*:\s*\\\[/g;
        let escMatch: RegExpExecArray | null;
        let scanned = 0;
        const maxScans = 10; // limit matches to prevent freeze

        while ((escMatch = escapedPagesPattern.exec(fullSanitized)) !== null && scanned < maxScans) {
          scanned++;
          const startQuote = fullSanitized.lastIndexOf('"', escMatch.index);
          if (startQuote === -1) {
            continue;
          }
          const extractedEscaped = this.extractEscapedString(fullSanitized, startQuote);
          if (!extractedEscaped) {
            continue;
          }
          try {
            const unescaped = extractedEscaped.replace(/\\"/g, '"').replace(/\\\\/g, '\\');
            const parsed = JSON.parse(unescaped);
            if (parsed?.pages && Array.isArray(parsed.pages)) {
              console.log('[DEBUG] ✓ Full-file scan: found ' + parsed.pages.length + ' pages (escaped JSON)');
              return parsed;
            }
          } catch {
            // continue
          }
        }

        // Pattern 2: direct pages JSON
        const directPagesPattern = /"pages"\s*:\s*\[/g;
        scanned = 0;
        while ((escMatch = directPagesPattern.exec(fullSanitized)) !== null && scanned < maxScans) {
          scanned++;
          const start = Math.max(0, escMatch.index - 200);
          const end = Math.min(fullSanitized.length, escMatch.index + 50000);
          const candidate = fullSanitized.substring(start, end);
          const braceStart = candidate.lastIndexOf('{', escMatch.index - start);
          if (braceStart === -1) {
            continue;
          }
          const captured = captureBalancedJson(candidate, braceStart);
          if (!captured) {
            continue;
          }
          try {
            const parsed = JSON.parse(captured);
            if (parsed?.pages && Array.isArray(parsed.pages)) {
              console.log('[DEBUG] ✓ Full-file scan: found ' + parsed.pages.length + ' pages (direct JSON)');
              return parsed;
            }
          } catch {
            // continue
          }
        }

        console.log('[DEBUG] Limited full-file scan did not find pages');
      } catch (ffErr) {
        console.warn('[DEBUG] Full-file scan error:', ffErr);
      }

      console.log('[DEBUG] No valid data found near key position');
      return null;
    } catch (error) {
      console.error('[DEBUG] Error parsing workspace storage:', error);
      return null;
    }
  }

  // Extract a JSON-escaped string starting at the given quote index, handling escaped quotes/backslashes
  private extractEscapedString(text: string, startQuoteIndex: number): string | null {
    if (text[startQuoteIndex] !== '"') {
      return null;
    }
    let i = startQuoteIndex + 1;
    let escaping = false;
    for (; i < text.length; i += 1) {
      const ch = text[i];
      if (escaping) {
        escaping = false;
        continue;
      }
      if (ch === '\\') {
        escaping = true;
        continue;
      }
      if (ch === '"') {
        // substring excludes the surrounding quotes
        return text.substring(startQuoteIndex + 1, i);
      }
    }
    return null;
  }

  private tryDecodePotentialPayload(payload: unknown): any | null {
    if (!payload) {
      return null;
    }

    if (typeof payload === 'object') {
      return payload;
    }

    if (typeof payload !== 'string') {
      return null;
    }

    const trimmed = payload.trim();
    const candidateStrings = new Set<string>();
    candidateStrings.add(trimmed);

    if (trimmed.includes('%')) {
      try {
        candidateStrings.add(decodeURIComponent(trimmed));
      } catch {
        // ignore decode errors
      }
    }

    if (/^[A-Za-z0-9+/=]+$/.test(trimmed) && trimmed.length % 4 === 0) {
      try {
        const base64Decoded = Buffer.from(trimmed, 'base64');
        candidateStrings.add(base64Decoded.toString('utf8'));

        try {
          const inflated = zlib.unzipSync(base64Decoded);
          candidateStrings.add(inflated.toString('utf8'));
        } catch {
          // not a zipped payload
        }
      } catch {
        // ignore base64 errors
      }
    }

    for (const candidate of candidateStrings) {
      const cleanCandidate = candidate.trim();
      if (!cleanCandidate) {
        continue;
      }

      if (cleanCandidate.startsWith('{') || cleanCandidate.startsWith('[')) {
        try {
          return JSON.parse(cleanCandidate);
        } catch {
          // ignore JSON parse error; try next candidate
        }
      }
    }

    return null;
  }

  private tryExtractJsonViaBraces(chunk: string, relativeKeyIndex: number): any | null {
    const scanStart = Math.max(0, relativeKeyIndex - 5000);

    for (let i = scanStart; i < chunk.length; i += 1) {
      const char = chunk[i];
      if (char !== '{' && char !== '[') {
        continue;
      }

      const extracted = captureBalancedJson(chunk, i);
      if (!extracted) {
        continue;
      }

      if (extracted.length > 200000) {
        continue;
      }

      try {
        const parsed = JSON.parse(extracted);
        return parsed;
      } catch {
        // ignore; keep scanning
      }
    }

    return null;
  }

  /**
   * Get VSCode workspace storage paths
   * These store per-workspace data including webview state
   */
  /**
   * Get possible VSCode global storage paths for different OS
   */
  private getVSCodeGlobalStoragePaths(): string[] {
    const paths: string[] = [];

    // Windows paths
    if (process.platform === 'win32') {
      const appData = process.env.APPDATA;
      if (appData) {
        paths.push(path.join(appData, 'Code', 'User', 'globalStorage'));
        paths.push(path.join(appData, 'Code - Insiders', 'User', 'globalStorage'));
      }
    }

    // macOS paths
    else if (process.platform === 'darwin') {
      const home = process.env.HOME;
      if (home) {
        paths.push(path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage'));
        paths.push(path.join(home, 'Library', 'Application Support', 'Code - Insiders', 'User', 'globalStorage'));
      }
    }

    // Linux paths
    else {
      const home = process.env.HOME;
      const xdgConfig = process.env.XDG_CONFIG_HOME;

      if (xdgConfig) {
        paths.push(path.join(xdgConfig, 'Code', 'User', 'globalStorage'));
        paths.push(path.join(xdgConfig, 'Code - Insiders', 'User', 'globalStorage'));
      } else if (home) {
        paths.push(path.join(home, '.config', 'Code', 'User', 'globalStorage'));
        paths.push(path.join(home, '.config', 'Code - Insiders', 'User', 'globalStorage'));
      }
    }

    return paths;
  }

  /**
   * Attempt to parse VS Code's state.vscdb (or similar) to extract old notes JSON
   */
  private async parseVscdbForOldNotes(filePath: string): Promise<any | null> {
    try {
      const buffer = await fs.promises.readFile(filePath);
      // Read as utf8; even if binary, JSON fragments are usually present as text
      const content = buffer.toString('utf8');
      // Look for a JSON object containing a pages array
      const jsonObjectWithPages = content.match(/\{[^\{\}]*"pages"\s*:\s*\[[\s\S]*?\][^\{\}]*\}/);
      if (jsonObjectWithPages) {
        try {
          return JSON.parse(jsonObjectWithPages[0]);
        } catch {
          // Fallback: try to just extract the pages array
        }
      }

      const pagesArrayOnly = content.match(/"pages"\s*:\s*\[([\s\S]*?)\]/);
      if (pagesArrayOnly) {
        const pagesJson = `[${pagesArrayOnly[1]}]`;
        try {
          const pages = JSON.parse(pagesJson);
          return { pages };
        } catch {
          return null;
        }
      }
    } catch (e) {
      // ignore
    }
    return null;
  }

  /**
   * Check if a file exists
   */
  private async fileExists(filePath: string): Promise<boolean> {
    try {
      await fs.promises.access(filePath);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Try to read webview state from VSCode's workspace state
   * This looks for the webview state that might be stored in VSCode's internal storage
   */
  private async tryRecoverWebviewState(): Promise<any> {
    try {
      // The old extension used webview state which is stored per workspace
      // We can try to look for it in common locations

      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        return null;
      }

      // Check for VSCode workspace storage
      const workspaceStoragePaths = [
        path.join(workspaceFolder.uri.fsPath, '.vscode', 'settings.json'),
        path.join(workspaceFolder.uri.fsPath, '.vscode', 'extensions.json')
      ];

      // Also check if the user has any backup files or exports
      const backupPaths = [
        path.join(workspaceFolder.uri.fsPath, 'sidebar-notes-backup.json'),
        path.join(workspaceFolder.uri.fsPath, 'notes-export.json'),
        path.join(workspaceFolder.uri.fsPath, 'markdown-notes.json')
      ];

      const allPaths = [...workspaceStoragePaths, ...backupPaths];

      for (const filePath of allPaths) {
        try {
          if (await this.fileExists(filePath)) {
            const content = await fs.promises.readFile(filePath, 'utf8');

            // Try to find sidebar-markdown-notes data in the file
            if (content.includes('sidebar-markdown-notes') || content.includes('pages')) {
              try {
                const data = JSON.parse(content);

                // Look for the extension's data in various possible structures
                if (data.pages) {
                  return data;
                }

                // Check if it's in a nested structure
                for (const key in data) {
                  if (data[key] && typeof data[key] === 'object' && data[key].pages) {
                    return data[key];
                  }
                }
              } catch (parseError) {
                // File might contain the data but not be pure JSON
                // Try to extract JSON-like structures
                const jsonMatch = content.match(/\{[^}]*"pages"\s*:\s*\[[^\]]*\][^}]*\}/);
                if (jsonMatch) {
                  try {
                    return JSON.parse(jsonMatch[0]);
                  } catch {
                    // Continue searching
                  }
                }
              }
            }
          }
        } catch (error) {
          // Continue to next path
        }
      }
    } catch (error) {
      console.warn('Error trying to recover webview state:', error);
    }

    return null;
  }

  /**
   * Scan a directory for markdown files that could be imported
   */
  async scanForMarkdownFiles(rootPath: string, maxDepth: number = 3): Promise<DiscoveredNote[]> {
    const discoveredNotes: DiscoveredNote[] = [];

    try {
      // Scan for regular markdown files only (no old extension recovery here)
      await this.scanDirectory(rootPath, rootPath, discoveredNotes, 0, maxDepth);
    } catch (error) {
      console.error('Error scanning for markdown files:', error);
      throw new Error(`Failed to scan directory: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return discoveredNotes.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  }

  /**
   * Build DiscoveredNote list from explicit file paths (e.g. user picks individual .md files).
   */
  async loadSpecificFiles(filePaths: string[]): Promise<DiscoveredNote[]> {
    const notes: DiscoveredNote[] = [];
    for (const fp of filePaths) {
      try {
        const note = await this.createDiscoveredNote(fp, path.basename(fp));
        if (note) {
          notes.push(note);
        }
      } catch (error) {
        console.warn(`Failed to load file ${fp}:`, error);
      }
    }
    return notes.sort((a, b) => b.lastModified.getTime() - a.lastModified.getTime());
  }

  /**
   * Recursively scan a directory for markdown files
   */
  private async scanDirectory(
    currentPath: string,
    rootPath: string,
    discoveredNotes: DiscoveredNote[],
    currentDepth: number,
    maxDepth: number
  ): Promise<void> {
    if (currentDepth > maxDepth) {
      return;
    }

    try {
      const entries = await fs.promises.readdir(currentPath, { withFileTypes: true });

      for (const entry of entries) {
        const fullPath = path.join(currentPath, entry.name);
        const relativePath = path.relative(rootPath, fullPath);

        // Skip excluded patterns
        if (this.shouldExcludePath(relativePath)) {
          continue;
        }

        if (entry.isDirectory()) {
          await this.scanDirectory(fullPath, rootPath, discoveredNotes, currentDepth + 1, maxDepth);
        } else if (entry.isFile()) {
          if (this.isMarkdownFile(entry.name)) {
            try {
              const note = await this.createDiscoveredNote(fullPath, relativePath);
              if (note) {
                discoveredNotes.push(note);
              }
            } catch (error) {
              console.warn(`Failed to process file ${fullPath}:`, error);
              // Continue processing other files
            }
          } else if (this.isOldExtensionNotesFile(entry.name)) {
            // Handle old extension notes files
            try {
              const oldNotes = await this.parseOldExtensionNotesFile(fullPath, relativePath);
              discoveredNotes.push(...oldNotes);
            } catch (error) {
              console.warn(`Failed to process old extension file ${fullPath}:`, error);
              // Continue processing other files
            }
          } else if (entry.name.toLowerCase().includes('state') || entry.name.endsWith('.vscdb')) {
            // Try to parse VS Code vscdb storage when scanning old extension storage directory
            try {
              const parsed = await this.parseVscdbForOldNotes(fullPath);
              if (parsed && parsed.pages && Array.isArray(parsed.pages)) {
                const stats = await fs.promises.stat(fullPath);
                parsed.pages.forEach((pageContent: string, index: number) => {
                  if (typeof pageContent === 'string' && pageContent.trim()) {
                    // Skip default welcome/filler text pages
                    if (this.isDefaultWelcomeText(pageContent)) {
                      return;
                    }

                    const fileName = `${path.basename(fullPath)}-page-${index + 1}.md`;
                    discoveredNotes.push({
                      filePath: fullPath,
                      fileName,
                      content: pageContent,
                      size: Buffer.byteLength(pageContent, 'utf8'),
                      lastModified: stats.mtime,
                      relativePath: path.join(path.dirname(relativePath), fileName),
                      isMarkdown: true,
                      wordCount: this.countWords(pageContent),
                      preview: this.generatePreview(pageContent),
                      isOldExtensionNote: true
                    });
                  }
                });
              }
            } catch (error) {
              // ignore and continue
            }
          }
        }
      }
    } catch (error) {
      console.warn(`Failed to read directory ${currentPath}:`, error);
      // Continue processing
    }
  }

  /**
   * Create a DiscoveredNote from a file path
   */
  private async createDiscoveredNote(filePath: string, relativePath: string): Promise<DiscoveredNote | null> {
    try {
      const stats = await fs.promises.stat(filePath);
      const content = await fs.promises.readFile(filePath, 'utf8');

      // Skip empty files
      if (content.trim().length === 0) {
        return null;
      }

      const fileName = path.basename(filePath);
      const wordCount = this.countWords(content);
      const preview = this.generatePreview(content);

      return {
        filePath,
        fileName,
        content,
        size: stats.size,
        lastModified: stats.mtime,
        relativePath,
        isMarkdown: true,
        wordCount,
        preview,
        source: 'Workspace Files'
      };
    } catch (error) {
      console.warn(`Failed to create discovered note for ${filePath}:`, error);
      return null;
    }
  }

  /**
   * Check if a path should be excluded from scanning
   */
  private shouldExcludePath(relativePath: string): boolean {
    const pathParts = relativePath.split(path.sep);
    return this.excludedPatterns.some((pattern) => pathParts.some((part) => part.includes(pattern)));
  }

  /**
   * Check if a file is a markdown file based on its extension
   */
  private isMarkdownFile(fileName: string): boolean {
    const ext = path.extname(fileName).toLowerCase();
    return this.markdownExtensions.includes(ext);
  }

  /**
   * Check if a file is an old extension notes file
   */
  private isOldExtensionNotesFile(fileName: string): boolean {
    // Check for various possible file names from the old extension
    const oldExtensionFiles = ['sidebar-notes.json', 'workspace-notes.json', 'notes.json', 'markdown-notes.json'];

    return (
      oldExtensionFiles.includes(fileName) ||
      fileName.includes('sidebar-markdown-notes') ||
      (fileName.includes('notes') && fileName.endsWith('.json'))
    );
  }

  /**
   * Parse old extension notes file and convert to DiscoveredNote format
   */
  private async parseOldExtensionNotesFile(filePath: string, relativePath: string): Promise<DiscoveredNote[]> {
    const discoveredNotes: DiscoveredNote[] = [];

    try {
      const fileContent = await fs.promises.readFile(filePath, 'utf8');
      const oldNotesData = JSON.parse(fileContent);

      // Handle different formats the old extension might have used
      let pages: string[] = [];

      if (oldNotesData.pages && Array.isArray(oldNotesData.pages)) {
        // Standard format with pages array (from sidebar-markdown-notes)
        pages = oldNotesData.pages;
      } else if (typeof oldNotesData === 'string') {
        // Simple string format
        pages = [oldNotesData];
      } else if (oldNotesData.content) {
        // Object with content property
        pages = [oldNotesData.content];
      } else if (oldNotesData.notes && Array.isArray(oldNotesData.notes)) {
        // Array of notes
        pages = oldNotesData.notes;
      } else if (oldNotesData.data && oldNotesData.data.pages) {
        // Nested data structure
        pages = oldNotesData.data.pages;
      } else if (oldNotesData.state && oldNotesData.pages) {
        // Direct webview state format from sidebar-markdown-notes
        pages = oldNotesData.pages;
      }

      // Convert each page to a DiscoveredNote
      pages.forEach((pageContent, index) => {
        if (typeof pageContent === 'string' && pageContent.trim()) {
          const stats = fs.statSync(filePath);
          const fileName = `${path.basename(filePath, '.json')}-page-${index + 1}.md`;

          discoveredNotes.push({
            filePath: filePath,
            fileName: fileName,
            content: pageContent,
            size: Buffer.byteLength(pageContent, 'utf8'),
            lastModified: stats.mtime,
            relativePath: path.join(path.dirname(relativePath), fileName),
            isMarkdown: true, // Treat old extension notes as markdown
            wordCount: this.countWords(pageContent),
            preview: this.generatePreview(pageContent),
            isOldExtensionNote: true // Mark as old extension note
          });
        }
      });

      if (discoveredNotes.length > 0) {
        console.log(`Found ${discoveredNotes.length} notes in old extension file: ${filePath}`);
      }
    } catch (error) {
      console.warn(`Failed to parse old extension notes file ${filePath}:`, error);
    }

    return discoveredNotes;
  }

  /**
   * Count words in markdown content
   */
  private countWords(content: string): number {
    // Remove markdown syntax and count words
    const plainText = content
      .replace(/```[\s\S]*?```/g, '') // Remove code blocks
      .replace(/`[^`]*`/g, '') // Remove inline code
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // Replace links with text
      .replace(/[#*_~`]/g, '') // Remove markdown formatting
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();

    return plainText ? plainText.split(' ').length : 0;
  }

  /**
   * Generate a preview of the markdown content
   */
  private generatePreview(content: string): string {
    // Remove markdown syntax for preview
    let preview = content
      .replace(/```[\s\S]*?```/g, '[code block]') // Replace code blocks
      .replace(/`([^`]*)`/g, '$1') // Remove inline code backticks
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1') // Replace links with text
      .replace(/[#*_~]/g, '') // Remove markdown formatting
      .replace(/\s+/g, ' ') // Normalize whitespace
      .trim();

    if (preview.length > this.maxPreviewLength) {
      preview = preview.substring(0, this.maxPreviewLength) + '...';
    }

    return preview;
  }

  /**
   * Check if content is the default welcome/filler text from the old extension
   */
  private isDefaultWelcomeText(content: string): boolean {
    // Check for the signature heading from the old extension's default content
    // Only skip if it's EXACTLY the welcome message (empty/default notes)
    const hasWelcomeHeading = content.includes('# Welcome to `sidebar-markdown-notes`');
    const hasGettingStarted = content.includes('## Getting started');
    const isMostlyTemplate = content.trim().length < 500; // If it's short, it's likely just the template
    
    // Only skip if it has the welcome heading AND is mostly just template text
    return hasWelcomeHeading && hasGettingStarted && isMostlyTemplate;
  }

  /**
   * Import selected notes into the current notes collection
   */
  async importNotes(
    selectedNotes: DiscoveredNote[],
    conflictResolutions?: Map<string, 'skip' | 'replace' | 'merge' | 'rename'>
  ): Promise<ImportResult> {
    const result: ImportResult = {
      imported: 0,
      skipped: 0,
      skippedBlank: 0,
      errors: [],
      conflicts: []
    };

    try {
      // Load current notes
      const currentNotes = await this.storageService.loadNotes();
      const existingPages = currentNotes?.pages || [];

      // Process each selected note
      for (const note of selectedNotes) {
        try {
          const conflict = this.detectConflict(note, existingPages);

          if (conflict) {
            const resolution = conflictResolutions?.get(note.fileName) || 'skip';
            const processed = await this.handleConflict(note, conflict, resolution, existingPages);

            if (processed.imported) {
              result.imported++;
            } else {
              result.skipped++;
            }

            if (processed.conflict) {
              result.conflicts.push(processed.conflict);
            }
          } else {
            // No conflict, import directly
            existingPages.push(note.content);
            result.imported++;
          }
        } catch (error) {
          result.errors.push(
            `Failed to import ${note.fileName}: ${error instanceof Error ? error.message : 'Unknown error'}`
          );
        }
      }

      // Save updated notes if any were imported
      if (result.imported > 0) {
        const updatedNotes: NotesData = currentNotes || this.createDefaultNotesData();
        updatedNotes.pages = existingPages;
        updatedNotes.metadata.totalPages = existingPages.length;

        await this.storageService.saveNotes(updatedNotes);
      }
    } catch (error) {
      result.errors.push(`Import failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }

    return result;
  }

  /**
   * Detect if importing a note would create a conflict
   */
  private detectConflict(note: DiscoveredNote, existingPages: string[]): ConflictInfo | null {
    // Check for content similarity
    for (const existingContent of existingPages) {
      const similarity = this.calculateContentSimilarity(note.content, existingContent);

      // If content is very similar (>90%), consider it a conflict
      if (similarity > 0.9) {
        return {
          fileName: note.fileName,
          existingContent,
          newContent: note.content,
          resolution: 'skip'
        };
      }
    }

    return null;
  }

  /**
   * Handle a conflict during import
   */
  private async handleConflict(
    note: DiscoveredNote,
    conflict: ConflictInfo,
    resolution: 'skip' | 'replace' | 'merge' | 'rename',
    existingPages: string[]
  ): Promise<{ imported: boolean; conflict?: ConflictInfo }> {
    switch (resolution) {
      case 'skip':
        return { imported: false, conflict: { ...conflict, resolution } };

      case 'replace':
        const index = existingPages.indexOf(conflict.existingContent);
        if (index !== -1) {
          existingPages[index] = note.content;
        }
        return { imported: true, conflict: { ...conflict, resolution } };

      case 'merge':
        const mergedContent = this.mergeContent(conflict.existingContent, note.content);
        const mergeIndex = existingPages.indexOf(conflict.existingContent);
        if (mergeIndex !== -1) {
          existingPages[mergeIndex] = mergedContent;
        }
        return { imported: true, conflict: { ...conflict, resolution } };

      case 'rename':
        // Add as new page with a note about the source
        const renamedContent = `# Imported: ${note.fileName}\n\n${note.content}`;
        existingPages.push(renamedContent);
        return { imported: true, conflict: { ...conflict, resolution } };

      default:
        return { imported: false };
    }
  }

  /**
   * Calculate content similarity between two strings
   */
  private calculateContentSimilarity(content1: string, content2: string): number {
    const normalize = (str: string) => str.toLowerCase().replace(/\s+/g, ' ').trim();
    const norm1 = normalize(content1);
    const norm2 = normalize(content2);

    if (norm1 === norm2) {
      return 1.0;
    }
    if (norm1.length === 0 || norm2.length === 0) {
      return 0.0;
    }

    // Simple similarity based on common substrings
    const shorter = norm1.length < norm2.length ? norm1 : norm2;
    const longer = norm1.length >= norm2.length ? norm1 : norm2;

    let matches = 0;
    const windowSize = Math.min(50, shorter.length);

    for (let i = 0; i <= shorter.length - windowSize; i++) {
      const substring = shorter.substring(i, i + windowSize);
      if (longer.includes(substring)) {
        matches += windowSize;
      }
    }

    return matches / Math.max(norm1.length, norm2.length);
  }

  /**
   * Merge two pieces of content
   */
  private mergeContent(existing: string, newContent: string): string {
    return `${existing}\n\n---\n\n# Merged Content\n\n${newContent}`;
  }

  /**
   * Create default notes data structure
   */
  private createDefaultNotesData(): NotesData {
    const now = new Date().toISOString();
    return {
      version: 2,
      lastModified: now,
      deviceId: '',
      state: 'editor',
      currentPage: 0,
      pages: [],
      metadata: {
        totalPages: 0,
        createdAt: now,
        syncStatus: 'pending'
      }
    };
  }

  /**
   * Create a sample old extension format file for testing
   * This method is useful for testing the import functionality
   */
  public async createSampleOldExtensionFile(filePath: string): Promise<void> {
    const sampleData = {
      state: 'editor',
      currentPage: 0,
      pages: [
        '# Welcome to sidebar-markdown-notes\n\nThis is a sample note from the old extension.\n\n- [x] Task 1\n- [ ] Task 2\n- [ ] Task 3',
        '# Second Page\n\nThis is another page with some content.\n\n## Features\n\n- Multiple pages\n- Markdown support\n- Task lists',
        '# Third Page\n\n```javascript\nconsole.log("Code blocks work too!");\n```\n\n> This is a blockquote\n\nAnd some **bold** and *italic* text.'
      ],
      version: 1
    };

    await fs.promises.writeFile(filePath, JSON.stringify(sampleData, null, 2), 'utf8');
  }

  /**
   * Get workspace folders for scanning
   */
  async getAvailableScanPaths(): Promise<
    {
      path: string;
      name: string;
      description?: string;
      type: 'workspace' | 'custom';
      isOldExtension?: boolean;
    }[]
  > {
    const paths: {
      path: string;
      name: string;
      description?: string;
      type: 'workspace' | 'custom';
      isOldExtension?: boolean;
    }[] = [];

    // Add a single comprehensive auto-scan option that checks everything
    paths.push({
      path: 'vscode://scan-all',
      name: 'Auto Scan',
      description: 'Includes current workspace & notes from the deprecated extension',
      type: 'custom',
      isOldExtension: true // Mark as true so it uses smart scanning
    });

    return paths;
  }

  /**
   * Add paths where the old "sidebar-markdown-notes" extension might have stored notes
   */
  /**
   * Get the VSCode global storage path
   */
  private getGlobalStoragePath(): string | null {
    try {
      // Get the parent directory of our extension's global storage
      const ourGlobalStorage = this.context.globalStorageUri.fsPath;
      return path.dirname(ourGlobalStorage);
    } catch (error) {
      console.warn('Could not determine global storage path:', error);
      return null;
    }
  }

  /**
   * Show folder picker for custom scan path
   */
  async selectCustomScanPath(): Promise<string | undefined> {
    const result = await vscode.window.showOpenDialog({
      canSelectFiles: false,
      canSelectFolders: true,
      canSelectMany: false,
      openLabel: 'Select Folder to Scan'
    });

    return result?.[0]?.fsPath;
  }
}

/**
 * Captures a balanced JSON object or array starting from a given index.
 * @param text The string to search within.
 * @param start The starting index, which must be '{' or '['.
 * @returns The captured JSON string, or null if not found.
 */
function captureBalancedJson(text: string, start: number): string | null {
  const openChar = text[start];
  if (openChar !== '{' && openChar !== '[') {
    return null;
  }
  const closeChar = openChar === '{' ? '}' : ']';
  let depth = 1;
  let inString = false;
  let isEscaped = false;

  for (let i = start + 1; i < text.length; i++) {
    const char = text[i];

    if (inString) {
      if (isEscaped) {
        isEscaped = false;
      } else if (char === '\\') {
        isEscaped = true;
      } else if (char === '"') {
        inString = false;
      }
      continue;
    }

    if (char === '"') {
      inString = true;
    } else if (char === openChar) {
      depth++;
    } else if (char === closeChar) {
      depth--;
    }

    if (depth === 0) {
      return text.substring(start, i + 1);
    }
  }

  return null; // Unbalanced
}
