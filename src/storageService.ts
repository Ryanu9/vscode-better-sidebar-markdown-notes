import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { getConfig } from './config';

export interface NotesData {
  version: number;
  lastModified: string; // ISO timestamp
  deviceId: string; // For conflict resolution
  state: 'editor' | 'render';
  currentPage: number;
  pages: string[];
  bookmarks?: boolean[]; // Per-note bookmark flags (index matches pages array)
  metadata: {
    totalPages: number;
    createdAt: string;
    syncStatus?: 'synced' | 'pending' | 'conflict';
    fileModTime?: number; // File modification timestamp for conflict detection
  };
}

export interface LegacyNotesData {
  state: 'editor' | 'render';
  currentPage: number;
  pages: string[];
  version: number;
}

// Minimum time between automatic (save-triggered) backups. Manual backups and
// backups taken before overwriting externally changed data are not throttled.
const AUTO_BACKUP_INTERVAL_MS = 10 * 60 * 1000;

export class StorageService {
  private readonly notesFilename = 'sidebar-notes.json';
  private readonly backupFolder = 'sidebar-notes-backups';
  private deviceId: string;
  // mtime of the notes file as of our last read/write. 0 means we have never read the file,
  // so it must not be overwritten without a conflict check.
  private lastKnownModTime: number = 0;
  private lastAutoBackupAt: number = 0;
  private fileWatcher?: vscode.FileSystemWatcher;
  private suppressFileWatcherEvents: boolean = false;

  constructor(private context: vscode.ExtensionContext) {
    // Generate or retrieve a unique device ID for conflict resolution
    this.deviceId = this.context.globalState.get('deviceId') || this.generateDeviceId();
    this.context.globalState.update('deviceId', this.deviceId);
  }

  private generateDeviceId(): string {
    return `device-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
  }

  /**
   * Get the storage path based on configuration
   */
  private getStoragePath(): string {
    const config = getConfig();
    const storageConfig = config.storage;

    if (storageConfig.location === 'custom' && storageConfig.customPath) {
      return path.resolve(storageConfig.customPath);
    }

    // Default: use workspace .vscode folder
    const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
    if (!workspaceFolder) {
      // Fallback: use global storage path when no workspace is open
      const globalStoragePath = this.context.globalStorageUri.fsPath;
      console.log('No workspace folder found, using global storage:', globalStoragePath);
      return globalStoragePath;
    }

    return path.join(workspaceFolder.uri.fsPath, '.vscode');
  }

  /**
   * Get the full path to the notes file
   */
  private getNotesFilePath(): string {
    return path.join(this.getStoragePath(), this.notesFilename);
  }

  /**
   * Get the full path to the notes file (public accessor)
   */
  getNotesFilePathPublic(): string {
    return this.getNotesFilePath();
  }

  /**
   * Get the backup directory path
   */
  private getBackupDirectoryPath(): string {
    return path.join(this.getStoragePath(), this.backupFolder);
  }

  /**
   * Ensure the storage directory exists
   */
  private async ensureStorageDirectory(): Promise<void> {
    const storagePath = this.getStoragePath();

    try {
      await fs.promises.access(storagePath);
    } catch {
      await fs.promises.mkdir(storagePath, { recursive: true });
    }
  }

  /**
   * Ensure the backup directory exists
   */
  private async ensureBackupDirectory(): Promise<void> {
    const backupPath = this.getBackupDirectoryPath();

    try {
      await fs.promises.access(backupPath);
    } catch {
      await fs.promises.mkdir(backupPath, { recursive: true });
    }
  }

  /**
   * Create a backup of the current notes file
   */
  async createBackup(): Promise<string | null> {
    const config = getConfig();
    if (!config.backup.enabled) {
      return null;
    }

    const notesPath = this.getNotesFilePath();

    try {
      // Check if notes file exists
      await fs.promises.access(notesPath);

      await this.ensureBackupDirectory();

      // Keep milliseconds so two backups in the same second don't overwrite each other
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupFileName = `backup-${timestamp}.json`;
      const backupPath = path.join(this.getBackupDirectoryPath(), backupFileName);

      await fs.promises.copyFile(notesPath, backupPath);

      // Clean up old backups
      await this.cleanupOldBackups();

      return backupPath;
    } catch (error) {
      // If notes file doesn't exist, no backup needed
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Backup taken as part of a save. Throttled to one per AUTO_BACKUP_INTERVAL_MS so that
   * frequent auto-saves don't rotate useful history out of the backup folder.
   */
  private async createAutoBackup(force: boolean): Promise<void> {
    if (!force && Date.now() - this.lastAutoBackupAt < AUTO_BACKUP_INTERVAL_MS) {
      return;
    }

    const backupPath = await this.createBackup();
    if (backupPath) {
      this.lastAutoBackupAt = Date.now();
    }
  }

  /**
   * Clean up old backup files based on maxBackups setting
   */
  private async cleanupOldBackups(): Promise<void> {
    const config = getConfig();
    const backupDir = this.getBackupDirectoryPath();

    try {
      const files = await fs.promises.readdir(backupDir);
      const backupFiles = files
        .filter((file) => file.startsWith('backup-') && file.endsWith('.json'))
        .map((file) => ({
          name: file,
          path: path.join(backupDir, file),
          stat: fs.statSync(path.join(backupDir, file))
        }))
        .sort((a, b) => b.stat.mtime.getTime() - a.stat.mtime.getTime());

      // Keep only the most recent maxBackups files
      const filesToDelete = backupFiles.slice(config.backup.maxBackups);

      for (const file of filesToDelete) {
        await fs.promises.unlink(file.path);
      }
    } catch (error) {
      console.warn('Failed to cleanup old backups:', error);
    }
  }

  /**
   * Load notes from file. The loaded file becomes the base for conflict detection.
   */
  async loadNotes(): Promise<NotesData | null> {
    const notesPath = this.getNotesFilePath();

    try {
      const data = await fs.promises.readFile(notesPath, 'utf8');
      const stat = await fs.promises.stat(notesPath);
      const parsed = JSON.parse(data);

      // If file looks like legacy v1 format (no version or version === 1), attempt migration
      if (parsed && typeof parsed === 'object' && (!parsed.version || parsed.version === 1)) {
        try {
          // Create a backup of the original file before migrating
          await this.ensureBackupDirectory();
          const backupFileName = `pre-migration-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
          const backupPath = path.join(this.getBackupDirectoryPath(), backupFileName);
          await fs.promises.copyFile(notesPath, backupPath);

          // Convert legacy data to new format
          const migrated = this.convertLegacyData(parsed as LegacyNotesData);

          // Persist migrated data
          const jsonData = JSON.stringify(migrated, null, 2);
          await fs.promises.writeFile(notesPath, jsonData, 'utf8');
          this.lastKnownModTime = (await fs.promises.stat(notesPath)).mtimeMs;

          return migrated;
        } catch (migrateError) {
          console.warn('Failed to migrate legacy notes file:', migrateError);
          // Fall through to validation error
        }
      }

      const notesData = this.normalizeNotesData(parsed);

      // Validate the data structure
      if (!notesData) {
        throw new Error('Invalid notes data format');
      }

      // Store file modification time for conflict detection
      this.lastKnownModTime = stat.mtimeMs;
      if (!notesData.metadata.fileModTime) {
        notesData.metadata.fileModTime = stat.mtimeMs;
      }

      return notesData;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        // File doesn't exist yet
        return null;
      }
      throw error;
    }
  }

  /**
   * Read the notes file without changing conflict-detection state.
   * Returns null if the file is missing or not valid notes data.
   */
  async readNotesFromDisk(): Promise<NotesData | null> {
    try {
      const data = await fs.promises.readFile(this.getNotesFilePath(), 'utf8');
      return this.normalizeNotesData(JSON.parse(data));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' || error instanceof SyntaxError) {
        return null;
      }
      throw error;
    }
  }

  /**
   * Validate parsed file data and fill in fields added in later versions
   */
  private normalizeNotesData(parsed: any): NotesData | null {
    if (!this.isValidNotesData(parsed)) {
      return null;
    }

    // Notes created before the bookmark feature have no (or a mismatched) bookmarks array.
    // Fixed in memory only; the next save persists it.
    if (!parsed.bookmarks || parsed.bookmarks.length !== parsed.pages.length) {
      parsed.bookmarks = new Array(parsed.pages.length).fill(false);
    }

    return parsed;
  }

  private async statNotesFile(): Promise<fs.Stats | null> {
    try {
      return await fs.promises.stat(this.getNotesFilePath());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      throw error;
    }
  }

  /**
   * Whether the notes file changed on disk since we last read or wrote it.
   * Any mtime difference counts: sync tools like SyncThing keep the remote device's mtime,
   * which can be older than ours.
   */
  async hasExternalChange(): Promise<boolean> {
    const stat = await this.statNotesFile();
    // A deleted file is simply recreated by the next save
    return stat !== null && stat.mtimeMs !== this.lastKnownModTime;
  }

  /**
   * Accept the file currently on disk as our base so the next save overwrites it.
   * Only call this after the user chose to keep their own version.
   */
  async acknowledgeExternalChange(): Promise<void> {
    const stat = await this.statNotesFile();
    this.lastKnownModTime = stat ? stat.mtimeMs : 0;
  }

  /**
   * Save notes to file
   * @param skipConflictCheck - overwrite even if the file changed externally (explicit user choice)
   */
  async saveNotes(notesData: NotesData, skipConflictCheck: boolean = false): Promise<void> {
    await this.ensureStorageDirectory();

    const notesPath = this.getNotesFilePath();

    // Also true when the file exists but we never read it (lastKnownModTime === 0),
    // so a file we haven't seen is never silently overwritten.
    const existing = await this.statNotesFile();
    const changedExternally = existing !== null && existing.mtimeMs !== this.lastKnownModTime;

    if (changedExternally && !skipConflictCheck) {
      if (getConfig().sync.conflictResolution !== 'timestamp') {
        // Manual resolution required
        throw new Error('CONFLICT_DETECTED');
      }

      // Auto-resolve: only overwrite if our data is newer. Read without updating
      // lastKnownModTime so a rejected save keeps detecting the conflict.
      const externalData = await this.readNotesFromDisk();
      if (externalData) {
        const externalTime = new Date(externalData.lastModified).getTime();
        const localTime = new Date(notesData.lastModified).getTime();

        if (externalTime > localTime) {
          throw new Error('CONFLICT_EXTERNAL_NEWER');
        }
      }
    }

    // Always keep a copy of data we are about to overwrite without having seen it
    await this.createAutoBackup(changedExternally);

    // Update metadata
    notesData.lastModified = new Date().toISOString();
    notesData.deviceId = this.deviceId;
    notesData.metadata.totalPages = notesData.pages.length;

    const jsonData = JSON.stringify(notesData, null, 2);
    await fs.promises.writeFile(notesPath, jsonData, 'utf8');

    // Update our last known modification time
    const stat = await fs.promises.stat(notesPath);
    this.lastKnownModTime = stat.mtimeMs;
    notesData.metadata.fileModTime = stat.mtimeMs;
  }

  /**
   * Validate notes data structure
   */
  private isValidNotesData(data: any): data is NotesData {
    return (
      typeof data === 'object' &&
      typeof data.version === 'number' &&
      typeof data.lastModified === 'string' &&
      typeof data.deviceId === 'string' &&
      (data.state === 'editor' || data.state === 'render') &&
      typeof data.currentPage === 'number' &&
      Array.isArray(data.pages) &&
      typeof data.metadata === 'object' &&
      typeof data.metadata.totalPages === 'number' &&
      typeof data.metadata.createdAt === 'string'
    );
  }

  /**
   * Convert legacy webview state to new format
   */
  convertLegacyData(legacyData: LegacyNotesData): NotesData {
    const now = new Date().toISOString();

    return {
      version: 2, // New version
      lastModified: now,
      deviceId: this.deviceId,
      state: legacyData.state,
      currentPage: legacyData.currentPage,
      pages: legacyData.pages,
      bookmarks: new Array(legacyData.pages.length).fill(false), // Initialize bookmarks for legacy data
      metadata: {
        totalPages: legacyData.pages.length,
        createdAt: now,
        syncStatus: 'pending'
      }
    };
  }

  /**
   * Get list of available backups
   */
  async getBackupList(): Promise<Array<{ name: string; path: string; date: Date }>> {
    const backupDir = this.getBackupDirectoryPath();

    try {
      const files = await fs.promises.readdir(backupDir);
      const backupFiles = [];

      for (const file of files) {
        if (file.startsWith('backup-') && file.endsWith('.json')) {
          const filePath = path.join(backupDir, file);
          const stat = await fs.promises.stat(filePath);
          backupFiles.push({
            name: file,
            path: filePath,
            date: stat.mtime
          });
        }
      }

      return backupFiles.sort((a, b) => b.date.getTime() - a.date.getTime());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }

  /**
   * Restore notes from a backup file
   */
  async restoreFromBackup(backupPath: string): Promise<NotesData> {
    const data = await fs.promises.readFile(backupPath, 'utf8');
    const notesData = this.normalizeNotesData(JSON.parse(data));

    if (!notesData) {
      throw new Error('Invalid backup data format');
    }

    // Keep the current notes so the restore itself can be undone
    await this.createBackup();

    // Save the restored data as current notes (explicit user choice, so overwrite)
    await this.saveNotes(notesData, true);

    return notesData;
  }

  /**
   * Check if there's a potential sync conflict
   */
  async checkForConflicts(): Promise<{ hasConflict: boolean; remoteData?: NotesData; localData?: NotesData }> {
    const localData = await this.loadNotes();

    if (!localData) {
      return { hasConflict: false };
    }

    // In a real implementation, you might check against a remote source
    // For now, we'll check if the file was modified by a different device
    if (localData.deviceId !== this.deviceId) {
      return {
        hasConflict: true,
        remoteData: localData,
        localData: undefined // Would come from webview state
      };
    }

    return { hasConflict: false };
  }

  /**
   * Setup file system watcher to detect external changes
   */
  setupFileWatcher(onExternalChange: () => void): void {
    const notesPath = this.getNotesFilePath();

    // Dispose existing watcher if any
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
    }

    // A RelativePattern is required to watch files outside the workspace folders
    // (custom storage path or global storage); a plain string glob only matches inside them.
    this.fileWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(path.dirname(notesPath), path.basename(notesPath))
    );

    const handleEvent = async (kind: string) => {
      if (this.suppressFileWatcherEvents) {
        console.log(`[StorageService] File ${kind} event suppressed (internal operation)`);
        return;
      }

      try {
        // Our own saves update lastKnownModTime, so they don't count as external.
        // lastKnownModTime is deliberately NOT updated here: the change stays "unseen" until
        // the user reloads or chooses to keep their version, which keeps saveNotes from
        // silently overwriting it in the meantime.
        if (await this.hasExternalChange()) {
          console.log(`[StorageService] External file ${kind} detected`);
          onExternalChange();
        }
      } catch (error) {
        console.warn('[StorageService] Error handling file change:', error);
      }
    };

    this.fileWatcher.onDidChange(() => handleEvent('change'));
    this.fileWatcher.onDidCreate(() => handleEvent('create'));
    // Deletion needs no prompt: the next save recreates the file
    this.fileWatcher.onDidDelete(() => console.log('[StorageService] Notes file deleted externally'));
  }

  /**
   * Dispose file watcher
   */
  disposeFileWatcher(): void {
    if (this.fileWatcher) {
      this.fileWatcher.dispose();
      this.fileWatcher = undefined;
    }
  }

  /**
   * Check for and handle SyncThing conflict files
   */
  async checkForSyncThingConflicts(): Promise<string[]> {
    const storagePath = this.getStoragePath();
    const conflictFiles: string[] = [];

    try {
      const files = await fs.promises.readdir(storagePath);
      console.log(`[StorageService] Checking for conflicts in: ${storagePath}`);
      console.log(`[StorageService] Found ${files.length} files in directory`);
      
      for (const file of files) {
        // SyncThing creates conflict files with pattern: filename.sync-conflict-YYYYMMDD-HHMMSS-XXXXXXX.ext
        if (file.includes('sync-conflict') && file.includes('sidebar-notes')) {
          const fullPath = path.join(storagePath, file);
          conflictFiles.push(fullPath);
          console.log(`[StorageService] Found conflict file: ${file}`);
        }
      }
      
      if (conflictFiles.length === 0) {
        console.log('[StorageService] No SyncThing conflict files found');
      }
    } catch (error) {
      console.warn('[StorageService] Error checking for SyncThing conflicts:', error);
    }

    return conflictFiles;
  }

  /**
   * Resolve a SyncThing conflict by choosing between files
   */
  async resolveSyncThingConflict(conflictFilePath: string, useConflictVersion: boolean): Promise<void> {
    const notesPath = this.getNotesFilePath();

    if (useConflictVersion) {
      // Backup the current file
      await this.createBackup();
      
      // Replace with conflict file
      await fs.promises.copyFile(conflictFilePath, notesPath);
      
      // Delete the conflict file
      await fs.promises.unlink(conflictFilePath);
    } else {
      // Keep current version, just delete the conflict file
      // But first, backup the conflict file just in case
      await this.ensureBackupDirectory();
      const backupFileName = `conflict-backup-${path.basename(conflictFilePath)}`;
      const backupPath = path.join(this.getBackupDirectoryPath(), backupFileName);
      await fs.promises.copyFile(conflictFilePath, backupPath);
      
      // Delete the conflict file
      await fs.promises.unlink(conflictFilePath);
    }

    // Reload the file to update our state
    await this.loadNotes();
  }

  /**
   * Attempt to merge two versions of notes
   */
  async mergeNotes(localData: NotesData, remoteData: NotesData): Promise<NotesData> {
    // Simple merge strategy: combine unique pages
    const allPages = Array.from(new Set([...localData.pages, ...remoteData.pages]));

    // Use the more recent metadata
    const localTime = new Date(localData.lastModified).getTime();
    const remoteTime = new Date(remoteData.lastModified).getTime();
    const newerData = localTime > remoteTime ? localData : remoteData;

    // Create merged data
    const mergedData: NotesData = {
      version: Math.max(localData.version, remoteData.version),
      lastModified: new Date().toISOString(),
      deviceId: this.deviceId,
      state: newerData.state,
      currentPage: Math.min(newerData.currentPage, allPages.length - 1),
      pages: allPages,
      bookmarks: new Array(allPages.length).fill(false),
      metadata: {
        totalPages: allPages.length,
        createdAt: localData.metadata.createdAt || remoteData.metadata.createdAt,
        syncStatus: 'synced'
      }
    };

    // Try to preserve bookmarks where pages match
    const pageIndexMap = new Map(allPages.map((page, idx) => [page, idx]));
    
    // Merge bookmarks from both versions
    if (localData.bookmarks) {
      localData.pages.forEach((page, idx) => {
        const newIdx = pageIndexMap.get(page);
        if (newIdx !== undefined && localData.bookmarks![idx]) {
          mergedData.bookmarks![newIdx] = true;
        }
      });
    }
    
    if (remoteData.bookmarks) {
      remoteData.pages.forEach((page, idx) => {
        const newIdx = pageIndexMap.get(page);
        if (newIdx !== undefined && remoteData.bookmarks![idx]) {
          mergedData.bookmarks![newIdx] = true;
        }
      });
    }

    return mergedData;
  }

  /**
   * Get the device ID for this instance
   */
  getDeviceId(): string {
    return this.deviceId;
  }

  /**
   * Temporarily suppress file watcher events (for internal operations)
   */
  setSuppressFileWatcher(suppress: boolean): void {
    this.suppressFileWatcherEvents = suppress;
    if (suppress) {
      console.log('[StorageService] File watcher events suppressed');
    } else {
      console.log('[StorageService] File watcher events re-enabled');
    }
  }
}
