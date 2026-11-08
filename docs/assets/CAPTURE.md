# Demo capture provenance

The GIF and PNGs are **fixture-rendered actual extension UI**, not screenshots of a complete live Pi CLI session. They contain no model responses or user data.

## What is real

`capture.mjs` transpiles the repository's unmodified `index.ts` in memory and executes it in a Node VM. It invokes the registered `/snippets` handler, takes the custom component returned by the extension, and drives its real `handleInput()` and `render()` methods. Navigation, selection cycling, preview text, persistence changes, and the widget lines all come from the extension. The widget's returned lines are rendered using Pi's actual `Text` component. Styling comes from the installed Pi dark theme and Pi TUI utilities.

Only host integration is mocked: registration, context, a 100-column/28-row viewport, render scheduling, an empty session branch, and `ctx.ui.custom()` / `setWidget()`. The extension's filesystem import is replaced with a strictly path-checked in-memory implementation. Demo snippets are read from this repository's bundled `snippets/`; all changes to their persistent flags remain in memory. No real `~/.pi/agent/snippets`, settings, sessions, credentials, or browser profile are read or written. `os.homedir()` is **not** overridden, and no HOME/XDG/cache environment variables are changed.

The script exports ANSI output from each actual rendered frame. A strict SGR-to-HTML converter retains true-color foreground and bold styling and rejects unsupported escapes instead of dropping them silently. Chrome headless rasterizes the exported text using macOS SF Mono with system fallback for symbols/emoji; a small header explicitly identifies fixture output and describes the current action. It is not a substitute or hand-drawn menu. Browser font rasterization and emoji appearance can differ from a terminal emulator.

## Reproduce (macOS)

With the project's development dependencies already installed, plus Google Chrome and ffmpeg:

```bash
bash docs/assets/capture.sh
```

Optional executable paths: `CHROME=/path/to/chrome FFMPEG=/path/to/ffmpeg bash docs/assets/capture.sh`.

No API keys, model calls, recording permissions, or dependency downloads are needed. Chrome uses a disposable capture-only browser profile under the ignored output directory, removed on exit. The script does not use your normal browser profile. Node's experimental VM modules flag is required; Python 3 runs the bounded browser wrapper. On macOS Chrome can write its screenshot and remain alive, so each capture gets 10 seconds before terminating only its own process group. The wrapper verifies that a fresh 1100×600 PNG was produced; missing/invalid output fails the script. Per-frame Chrome diagnostics stay in the ignored output directory.

The sequence is: open menu → Space (temporary) → Space (persistent) → select an append snippet → Tab preview → Enter apply → active widget. The GIF displays those six captured frames for 1.5 seconds each and loops. `menu.png`, `preview.png`, and `widget.png` are copied directly from their corresponding captured frames.

Generated HTML, ANSI, PNG frame intermediates, browser logs, and a manifest (extension SHA-256, installed Pi version, frame labels) go to ignored `capture-output/`. The manifest is also copied to checked-in `capture-manifest.json` to identify the source used for the final assets. The final GIF/PNGs, manifest, and capture scripts are the checked-in deliverables. To remove intermediates after inspecting them:

```bash
rm -rf docs/assets/capture-output
```

## Scope of verification

The harness asserts that the menu applies both prepend and append widget lines and saves the persistent flag in the in-memory file. These captures verify actual component output, not terminal input integration, live CLI layout, reload/install behavior, or persistence across real sessions. They do not independently validate first-recorded-message lifecycle semantics; that belongs to implementation tests.
