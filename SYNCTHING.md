# SyncThing Integration Guide

## Overview

This extension now includes specific features to work gracefully with SyncThing for cross-device synchronization without relying on cloud services.

## What's Been Added

### 1. **File Change Detection**
- Automatic detection of external changes to notes file
- File system watcher monitors for changes made by SyncThing
- User notification when external changes are detected
- Option to auto-reload or prompt user

### 2. **Conflict Detection & Resolution**
- **Optimistic locking**: Checks file modification time before writing
- **Timestamp-based resolution**: Automatically uses newest version (optional)
- **Manual resolution**: Prompts user to choose version (default)
- **Merge capability**: Combines unique pages from both versions

### 3. **SyncThing Conflict File Handling**
- Automatically detects `.sync-conflict-*` files created by SyncThing
- Provides UI to resolve conflicts
- Option to view conflict file before deciding
- All resolutions are backed up automatically

### 4. **Enhanced Metadata**
- Tracks device ID for each change
- Records file modification timestamps
- Maintains sync status in metadata

## Recommended Configuration

### For SyncThing Users

```json
{
  // Increase auto-save interval to reduce conflicts
  "better-sidebar-markdown-notes.storage.autoSaveInterval": 3000,
  
  // Keep file watcher enabled to detect SyncThing changes
  "better-sidebar-markdown-notes.sync.enableFileWatcher": true,
  
  // Prompt before auto-reloading (recommended)
  "better-sidebar-markdown-notes.sync.autoReloadOnExternalChange": false,
  
  // Auto-detect SyncThing conflict files
  "better-sidebar-markdown-notes.sync.checkSyncThingConflicts": true,
  
  // Choose how to handle conflicts
  "better-sidebar-markdown-notes.sync.conflictResolution": "manual"
}
```

## How It Works

### Normal Operation
1. You edit notes in VS Code
2. Extension saves to `.vscode/sidebar-notes.json` (with 3-second debounce)
3. SyncThing syncs the file to your other devices
4. On other devices, file watcher detects the change
5. You're prompted to reload the updated notes

### Conflict Scenario
**When you edit on two machines simultaneously:**

1. **Auto-save triggers** on Machine A
2. Extension checks file modification time
3. If file changed externally → **conflict detected**
4. You're prompted with options:
   - **Use My Version**: Overwrite with your changes
   - **Use Other Version**: Discard your changes, load theirs
   - **Merge**: Combine unique pages from both
   - **Cancel**: Keep current state

### SyncThing Conflict Files
**When SyncThing itself detects a conflict:**

1. SyncThing creates `sidebar-notes.sync-conflict-YYYYMMDD-HHMMSS-XXXXXXX.json`
2. Extension detects this file before next save
3. You're prompted to resolve:
   - **Keep Current Version**: Delete conflict file
   - **Use Conflict Version**: Replace with conflict file
   - **View Conflict File First**: Open in editor to inspect

## Best Practices

### 1. Increase Auto-Save Interval
```json
{
  "better-sidebar-markdown-notes.storage.autoSaveInterval": 3000
}
```
- Reduces chance of simultaneous saves
- Still provides good auto-save experience
- Gives SyncThing time to propagate changes

### 2. Close-Before-Open Pattern
- When possible, close VS Code on one machine before opening on another
- Ensures clean sync without conflicts
- Not required, but reduces conflict frequency

### 3. Monitor Sync Status
- Keep SyncThing UI open or accessible
- Check that files are "Up to Date" before editing
- Pause sync temporarily if making major edits

### 4. Regular Backups
- Extension auto-creates backups while saving (at most one every 10 minutes, plus one before overwriting an externally changed file)
- Use "Restore from Backup" if conflicts resolved incorrectly
- Backups stored in `.vscode/sidebar-notes-backups/`

### 5. Manual Conflict Resolution
- Don't rely on timestamp-based auto-resolution
- Review conflicts manually to avoid data loss
- Use merge option to preserve work from both devices

## Troubleshooting

### Conflicts Keep Happening
**Solution**: Increase `autoSaveInterval` to 5000ms or more

```json
{
  "better-sidebar-markdown-notes.storage.autoSaveInterval": 5000
}
```

### Not Detecting External Changes
**Check**:
1. File watcher is enabled: `sync.enableFileWatcher: true`
2. SyncThing is running and syncing
3. File path is correct in `.vscode/sidebar-notes.json`
4. No permission issues on the `.vscode` folder

### SyncThing Conflict Files Not Detected
**Check**:
1. Setting enabled: `sync.checkSyncThingConflicts: true`
2. Conflict files are in same directory as `sidebar-notes.json`
3. Filenames contain "sync-conflict" and "sidebar-notes"

### Lost Changes After Conflict
**Recovery**:
1. Open Command Palette (`Ctrl+Shift+P` or `Cmd+Shift+P`)
2. Run: "Sidebar markdown notes: Restore from Backup"
3. Choose most recent backup before conflict
4. Review and re-save as needed

## Technical Details

### Conflict Detection Algorithm
```typescript
1. Before save, get file modification time
2. Compare to last known modification time
3. If file is newer:
   a. In 'timestamp' mode: Compare lastModified timestamps
   b. In 'manual' mode: Prompt user
4. If no conflict: Save and update modification time
```

### Merge Strategy
```typescript
1. Combine all unique pages (by content)
2. Use newer metadata (state, currentPage)
3. Preserve bookmarks from both versions
4. Assign new deviceId and timestamp
5. Save merged result
```

### File Watcher Behavior
- Watches specific file: `.vscode/sidebar-notes.json`
- Triggers on: create, change, delete events
- Debounced to avoid rapid-fire notifications
- Only triggers if modification time actually changed

## Migration from Previous Version

If you were using the extension before these sync improvements:

1. **First load on new machine**: May show no conflict (clean migration)
2. **Subsequent edits**: Conflict detection will activate
3. **No data loss**: All backups preserved during migration
4. **Settings**: Add new sync settings manually (see Recommended Configuration)

## Support

If you encounter issues:
1. Check VS Code Developer Console (`Help > Toggle Developer Tools`)
2. Look for `[StorageService]` or `[WebviewProvider]` log messages
3. Check SyncThing logs for sync errors
4. Verify file permissions on `.vscode` folder
5. Try "Reset Migration (Debug)" command if problems persist

---

**The extension is now SyncThing-aware and will help you manage conflicts gracefully!**
