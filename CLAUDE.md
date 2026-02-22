# JupyterLite Zestables

JupyterLite notebooks packaged as Zest content for Canvas LMS integration.

## Architecture

```
jupyterlite-zestables/
  extension/              Federated JupyterLab extension (pip-installable)
    src/index.ts          TypeScript — postMessage bridge between JupyterLite and wrapper
    pyproject.toml        Python packaging for pip install
    package.json          JupyterLab extension metadata
  template/               Zest wrapper files (shared by all notebooks)
    index.html            Wrapper page with toolbar + JupyterLite iframe
    bridge.js             Zest API integration (state, grading, events, storage isolation)
    review.html           SpeedGrader review page (notebook viewer + event timeline)
    zest.json             Manifest template
  build-tool/
    build.js              Package notebooks into standalone Zest zips
    build-runtime.js      Build the shared JupyterLite runtime with kernels + extension
  runtime/                JupyterLite build directory (generated)
    _output/              Built JupyterLite static site
  examples/               Example notebook projects
    python-basics/
    data-analysis/
    physics-simulation/
  dist/                   Output zips (generated)
```

## How It Works

1. The **extension** runs inside JupyterLite and communicates with the wrapper via postMessage
2. The **wrapper** (index.html + bridge.js) handles Zest API calls — state save/load, submission, grading
3. The **build tool** packages each notebook with the JupyterLite runtime into a standalone zip
4. Each zip is a complete Zest content package — upload to the Zest picker and it works

## Key Design Decisions

- **Storage isolation**: IndexedDB is cleared before each session. The Zest server is the source of truth for student state, not the browser. This prevents Student B from seeing Student A's work on shared lab computers.
- **Federated extension**: The Zest bridge is a proper JupyterLab federated extension installed via pip. `jupyter lite build` automatically picks it up. No hacks.
- **Both kernels**: Python (Pyodide) and JavaScript kernels are both included. Teachers choose via the kernel parameter or students select when opening a notebook.
- **Teacher-graded by default**: Notebooks use `submitWork()` not `submitScore()`. The teacher reviews in SpeedGrader via review.html which renders the submitted notebook with all outputs.

## Build Process

```bash
# 1. Install Python dependencies
pip install -r requirements.txt

# 2. Build the JupyterLite runtime (includes extension + kernels)
node build-tool/build-runtime.js

# 3. Package notebooks into Zest zips
node build-tool/build.js

# Output: dist/*.zip files ready for upload to Zest
```

## Creating New Notebooks

Drop a directory into `examples/` (or any directory you point --dir at):

```
my-notebook/
  assignment.ipynb     # Required: the main notebook
  data/                # Optional: data files accessible from the notebook
  requirements.txt     # Optional: pip packages (for documentation)
  zest.json            # Optional: override metadata (title, tags, etc.)
```

Or just drop a bare `.ipynb` file — the build tool handles both patterns.

## PostMessage Protocol

Extension (inside JupyterLite) ↔ Wrapper (parent page):

**Wrapper → Extension:**
- `getNotebook` — Request current notebook as JSON
- `loadNotebook` — Load a notebook from JSON into the filesystem
- `save` — Trigger a save
- `getStatus` — Get kernel/notebook status
- `runAll` — Execute all cells
- `clearOutputs` — Clear all cell outputs

**Extension → Wrapper:**
- `ready` — Extension initialized, lists capabilities
- `notebookContent` — Response to getNotebook
- `cellExecuted` — Cell finished running (index, success)
- `dirty` — Notebook modified
- `kernelStatus` — Kernel state changed (idle/busy/error)
- `notebookOpened` — A notebook was opened

## Server-Side Requirements

The Zest server needs no changes for JupyterLite support. Notebooks use the same APIs as PhET sims:
- `Zest.saveState()` / `Zest.loadState()` — notebook JSON stored as state
- `Zest.submitWork()` — notebook JSON + events submitted as artifacts
- `review.html` — renders submitted notebook in SpeedGrader

State size: notebook JSON is typically 10-500 KB, well within the 10 MB limit.
