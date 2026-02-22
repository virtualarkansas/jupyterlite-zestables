# JupyterLite Zestables

Interactive Jupyter notebooks that run entirely in the browser, packaged as [Zest](https://getzest.dev) content for Canvas LMS.

Students write and run Python or JavaScript code directly in Canvas assignments. Their work auto-saves to the Zest server and teachers review submitted notebooks in SpeedGrader.

## Quick Start (For Teachers)

If you just want to create a notebook assignment, download the **notebook template**:

1. Download `notebook-template.zip` from the [dist/](dist/) folder (or ask your Zest admin)
2. Unzip it
3. Put your `.ipynb` file in the `lite/files/` folder, renamed to `assignment.ipynb`
4. Edit `zest.json` to set your title and description
5. Zip the contents back up
6. Upload the zip to the Zest content picker in Canvas

See `HOW-TO-USE.txt` inside the template for detailed instructions.

## Quick Start (For Developers)

### Prerequisites

- **Node.js** 18+
- **Python** 3.10+ with pip

### Setup

```bash
# Clone the repo
git clone https://github.com/virtualarkansas/jupyterlite-zestables.git
cd jupyterlite-zestables

# Install Node dependencies
npm install

# Install Python dependencies (pinned to JupyterLite 0.7.x)
pip install -r requirements.txt
```

### Build

```bash
# 1. Build the JupyterLite runtime (one-time, includes Python + JS kernels)
node build-tool/build-runtime.js

# 2. Package example notebooks into Zest zips
node build-tool/build.js

# Output: dist/*.zip files ready for upload
```

### Build Options

```bash
# Build notebooks from a custom directory
node build-tool/build.js --dir path/to/notebooks/

# Build a single notebook
node build-tool/build.js --single my-notebook.ipynb

# Preview what would be built without building
node build-tool/build.js --dry-run
```

## Project Structure

```
jupyterlite-zestables/
  template/                 Zest wrapper files (shared by all notebooks)
    index.html              Wrapper page with toolbar + JupyterLite iframe
    bridge.js               Zest API integration (state, grading, events)
    bridge-shim.js          Runs inside JupyterLite — reads/writes IndexedDB
    review.html             SpeedGrader review page (notebook viewer + timeline)
    zest.json               Manifest template
  build-tool/
    build.js                Package notebooks into standalone Zest zips
    build-runtime.js        Build the shared JupyterLite runtime
  runtime/                  JupyterLite build output (generated)
  examples/                 Example notebook projects
    python-basics/
    python-explorer/
    data-analysis/
    physics-simulation/
  dist/                     Output zips (generated)
  notebook-template/        Downloadable template for non-technical users
```

## Creating Notebooks

### Directory Format

Drop a directory into `examples/` with your notebook and optional files:

```
my-notebook/
  assignment.ipynb      # Required: the main notebook (must be this name)
  data/                 # Optional: data files (CSVs, images, etc.)
  requirements.txt      # Optional: pip packages (for documentation only)
  zest.json             # Optional: override title, description, tags
```

### Single File Format

Or just drop a bare `.ipynb` file into `examples/` — the build tool handles it.

### What Students Can Do

- Write and run Python code (via Pyodide) or JavaScript
- Upload files (CSVs, images) into the notebook environment
- Create plots and visualizations (matplotlib, etc.)
- Their work auto-saves every 30 seconds
- Click "Submit" when done

## How It Works

Each built zip is a self-contained Zest content package:

1. **index.html** wraps JupyterLite in an iframe with a toolbar (Run All, Clear, Submit)
2. **bridge.js** connects to the Zest server API for state persistence and grading
3. **bridge-shim.js** runs inside JupyterLite and accesses its IndexedDB directly to read/write notebook content
4. On submit, the notebook JSON + any uploaded files are sent to the Zest server for teacher review in SpeedGrader

### State Management

- Student work is auto-saved to the Zest server (not just the browser)
- When a student returns to an assignment, their previous work is restored
- Storage isolation: IndexedDB is cleared per session so shared computers don't leak data between students

### Kernels

Both kernels are included in every build:

- **Python** (Pyodide) — full Python 3 with numpy, pandas, matplotlib, etc.
- **JavaScript** — native browser JS kernel

Teachers can set the default kernel via the `kernel` parameter in the Zest content picker, or students can choose when they open the notebook.

## Version Pinning

JupyterLite versions are pinned in `requirements.txt` to `0.7.x` because:

- The bridge-shim reads JupyterLite's IndexedDB directly
- The database name format changed in v0.6.0 (breaking)
- v0.8.0 may restructure the drive package
- Stay within `0.7.x` until the bridge-shim is retested against newer versions

## Integration with Zest Server

This project produces content packages for the [Zest LTI platform](https://github.com/virtualarkansas/zest-server). The Zest server handles:

- LTI 1.3 authentication with Canvas
- State persistence (save/load student work)
- Grade passback (via LTI AGS)
- SpeedGrader review rendering

The server needs a body parser limit of at least 110MB to handle notebooks with embedded images.

## License

BSD-3-Clause (JupyterLite) + project-specific code.
