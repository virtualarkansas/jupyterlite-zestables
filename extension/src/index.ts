/**
 * @zest/jupyterlite-bridge-extension
 *
 * Federated JupyterLab extension that bridges JupyterLite with the Zest
 * LTI wrapper page. Communicates via postMessage to enable:
 *
 * - Notebook content extraction (for state save + submission)
 * - Notebook loading (from Zest state restore)
 * - Cell execution tracking (for event logging)
 * - Dirty state monitoring (for auto-save triggers)
 * - Kernel status reporting
 *
 * The wrapper page (index.html + bridge.js) handles all Zest API
 * communication. This extension just exposes JupyterLite internals
 * to the wrapper via a clean postMessage protocol.
 *
 * Message protocol:
 *   type: 'zest-jupyter'
 *   action: string
 *   requestId?: string (for request-response correlation)
 *   data?: any
 */

import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin
} from '@jupyterlab/application';

import { INotebookTracker, NotebookActions } from '@jupyterlab/notebook';

// -----------------------------------------------------------------------
// Message Protocol Types
// -----------------------------------------------------------------------

interface ZestMessage {
  type: 'zest-jupyter';
  action: string;
  requestId?: string;
  data?: any;
}

// -----------------------------------------------------------------------
// Plugin
// -----------------------------------------------------------------------

const PLUGIN_ID = 'jupyterlite-zest-bridge:bridge';

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'Bridges JupyterLite with the Zest LTI wrapper via postMessage',
  autoStart: true,
  requires: [INotebookTracker],
  activate: (app: JupyterFrontEnd, tracker: INotebookTracker) => {
    console.log('[zest-bridge-ext] Activating Zest bridge extension');

    let cellExecutionCount = 0;
    let lastSavedHash = '';

    // -------------------------------------------------------------------
    // Helper: Get current notebook as JSON
    // -------------------------------------------------------------------

    function getNotebookJSON(): any | null {
      const panel = tracker.currentWidget;
      if (!panel) return null;
      try {
        return panel.context.model.toJSON();
      } catch (e) {
        console.warn('[zest-bridge-ext] Failed to get notebook JSON:', e);
        return null;
      }
    }

    // -------------------------------------------------------------------
    // Helper: Simple hash for change detection
    // -------------------------------------------------------------------

    function simpleHash(str: string): string {
      let hash = 0;
      for (let i = 0; i < str.length; i++) {
        const char = str.charCodeAt(i);
        hash = ((hash << 5) - hash) + char;
        hash |= 0;
      }
      return hash.toString(36);
    }

    // -------------------------------------------------------------------
    // Helper: Send message to parent wrapper
    // -------------------------------------------------------------------

    function sendToWrapper(action: string, data?: any, requestId?: string) {
      const msg: ZestMessage = {
        type: 'zest-jupyter',
        action,
        data: data || {},
        requestId
      };
      try {
        window.parent.postMessage(msg, '*');
      } catch (e) {
        console.warn('[zest-bridge-ext] postMessage failed:', e);
      }
    }

    // -------------------------------------------------------------------
    // Handle incoming messages from the wrapper
    // -------------------------------------------------------------------

    window.addEventListener('message', async (event: MessageEvent) => {
      const msg = event.data;
      if (!msg || msg.type !== 'zest-jupyter') return;

      console.log('[zest-bridge-ext] Received:', msg.action);

      switch (msg.action) {
        // ---------------------------------------------------------------
        // Get the current notebook content as nbformat JSON
        // ---------------------------------------------------------------
        case 'getNotebook': {
          const nbJSON = getNotebookJSON();
          sendToWrapper('notebookContent', {
            notebook: nbJSON,
            path: tracker.currentWidget?.context.path || null,
            cellCount: nbJSON?.cells?.length || 0,
            executionCount: cellExecutionCount
          }, msg.requestId);
          break;
        }

        // ---------------------------------------------------------------
        // Load a notebook from JSON into the JupyterLite file system
        // ---------------------------------------------------------------
        case 'loadNotebook': {
          try {
            const { notebook, path } = msg.data;
            const fileName = path || 'assignment.ipynb';
            const contentsManager = app.serviceManager.contents;

            // Write the notebook to the virtual filesystem
            await contentsManager.save(fileName, {
              type: 'notebook',
              format: 'json',
              content: notebook
            });

            // Open the notebook
            await app.commands.execute('docmanager:open', {
              path: fileName
            });

            sendToWrapper('notebookLoaded', {
              path: fileName,
              success: true
            }, msg.requestId);
          } catch (e: any) {
            console.error('[zest-bridge-ext] loadNotebook failed:', e);
            sendToWrapper('notebookLoaded', {
              success: false,
              error: e.message
            }, msg.requestId);
          }
          break;
        }

        // ---------------------------------------------------------------
        // Trigger a save of the current notebook
        // ---------------------------------------------------------------
        case 'save': {
          try {
            await app.commands.execute('docmanager:save');
            const nbJSON = getNotebookJSON();
            sendToWrapper('saved', {
              notebook: nbJSON,
              success: true
            }, msg.requestId);
          } catch (e: any) {
            sendToWrapper('saved', {
              success: false,
              error: e.message
            }, msg.requestId);
          }
          break;
        }

        // ---------------------------------------------------------------
        // Get current status
        // ---------------------------------------------------------------
        case 'getStatus': {
          const panel = tracker.currentWidget;
          sendToWrapper('status', {
            hasNotebook: !!panel,
            isDirty: panel?.context.model.dirty || false,
            path: panel?.context.path || null,
            cellCount: getNotebookJSON()?.cells?.length || 0,
            executionCount: cellExecutionCount,
            kernelStatus: panel?.sessionContext?.session?.kernel?.status || 'unknown'
          }, msg.requestId);
          break;
        }

        // ---------------------------------------------------------------
        // Execute all cells
        // ---------------------------------------------------------------
        case 'runAll': {
          try {
            await app.commands.execute('notebook:run-all-cells');
            sendToWrapper('runAllComplete', { success: true }, msg.requestId);
          } catch (e: any) {
            sendToWrapper('runAllComplete', {
              success: false,
              error: e.message
            }, msg.requestId);
          }
          break;
        }

        // ---------------------------------------------------------------
        // Reset notebook — clear all outputs
        // ---------------------------------------------------------------
        case 'clearOutputs': {
          try {
            await app.commands.execute('notebook:clear-all-cell-outputs');
            sendToWrapper('outputsCleared', { success: true }, msg.requestId);
          } catch (e: any) {
            sendToWrapper('outputsCleared', {
              success: false,
              error: e.message
            }, msg.requestId);
          }
          break;
        }

        default:
          console.warn('[zest-bridge-ext] Unknown action:', msg.action);
      }
    });

    // -------------------------------------------------------------------
    // Track cell executions
    // -------------------------------------------------------------------

    NotebookActions.executionScheduled.connect((_, args) => {
      const { cell, notebook } = args;
      const cellIndex = notebook.widgets.indexOf(cell);
      sendToWrapper('cellExecutionScheduled', {
        cellIndex,
        cellType: cell.model.type
      });
    });

    NotebookActions.executed.connect((_, args) => {
      const { cell, notebook, success } = args;
      const cellIndex = notebook.widgets.indexOf(cell);
      cellExecutionCount++;
      sendToWrapper('cellExecuted', {
        cellIndex,
        cellType: cell.model.type,
        success,
        executionCount: cellExecutionCount
      });
    });

    // -------------------------------------------------------------------
    // Track dirty state changes (content modified)
    // -------------------------------------------------------------------

    tracker.currentChanged.connect((_, panel) => {
      if (!panel) return;

      // Notify wrapper when notebook is opened
      sendToWrapper('notebookOpened', {
        path: panel.context.path,
        cellCount: panel.context.model.toJSON()?.cells?.length || 0
      });

      // Monitor content changes for auto-save
      panel.context.model.contentChanged.connect(() => {
        const nbJSON = getNotebookJSON();
        if (!nbJSON) return;

        const currentHash = simpleHash(JSON.stringify(nbJSON));
        if (currentHash !== lastSavedHash) {
          lastSavedHash = currentHash;
          sendToWrapper('dirty', {
            isDirty: true,
            path: panel.context.path
          });
        }
      });

      // Monitor save events
      panel.context.saveState.connect((_, state) => {
        if (state === 'completed') {
          sendToWrapper('dirty', {
            isDirty: false,
            path: panel.context.path
          });
        }
      });
    });

    // -------------------------------------------------------------------
    // Track kernel status
    // -------------------------------------------------------------------

    tracker.currentChanged.connect((_, panel) => {
      if (!panel) return;

      panel.sessionContext.statusChanged.connect((_, status) => {
        sendToWrapper('kernelStatus', {
          status,
          path: panel.context.path
        });
      });
    });

    // -------------------------------------------------------------------
    // Signal ready to wrapper
    // -------------------------------------------------------------------

    setTimeout(() => {
      sendToWrapper('ready', {
        version: '1.0.0',
        capabilities: [
          'getNotebook',
          'loadNotebook',
          'save',
          'getStatus',
          'runAll',
          'clearOutputs',
          'cellExecutionTracking',
          'dirtyStateTracking',
          'kernelStatusTracking'
        ]
      });
      console.log('[zest-bridge-ext] Zest bridge extension ready');
    }, 100);
  }
};

export default plugin;
