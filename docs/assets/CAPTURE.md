# Demo capture provenance

These assets show **the actual native Pi CLI TUI**, captured offline through a PTY and terminal emulation. They are **not desktop screen-recording pixels** and are not hand-drawn component lookalikes. No model answer is invented.

## Pipeline

`capture.sh` runs `capture-terminal.py`. An isolated tmux server (`-f /dev/null`, no user tmux configuration; documented `extended-keys on` and `extended-keys-format csi-u`) launches the installed Pi CLI in its native default fullscreen mode, at 110 columns × 30 rows. tmux performs VT cursor movement, erasure, screen switching, wrapping and scrolling. `capture-pane -e -p` exports the resulting visible terminal cells and their foreground/background/style sequences. Pillow rasterizes those cells using macOS Menlo at a 10 × 20 pixel cell size, producing 1100 × 600 PNGs. ffmpeg encodes those actual terminal states as looping GIFs. There is no added title, caption, window chrome, panel, or layout rearrangement. Pi itself positions the editor/footer and clips or scrolls the transcript. Startup is not silenced: the actual standard Pi logo/version, shortcut hints and onboarding remain visible wherever native scrollback allows.

`capture-native.mjs`, explicitly preloaded only for this capture, wraps the installed `InteractiveMode.showFullscreenModelScopeNotice()` to append one stock `muted` Text attribution line (`@ivannovr/pi-prompt-snippets`) to its actual header container. It does not recreate or replace the built-in header. The documented `setHeader` API replaces the whole native header, so this narrow, approved fixture adaptation is used instead. The same file wraps the native footer's render method only to substitute the first-line displayed cwd `~/Projects/IdeaProjects/pi-prompt-snippets` with `~/Projects/pi-prompt-snippets`. The actual working directory, session cwd, filesystem and process HOME remain unchanged. All other footer content and placement are native, not redrawn by the adapter. No installed Pi file is edited.

`capture.mjs` is capture infrastructure loaded explicitly as a Pi extension. It transpiles the repository's **unmodified** `pi-extension/prompt-snippets/*.ts` module tree in memory and runs the `index.ts` factory with the **real Pi extension API/context**, not a mocked UI. Only the extension's `node:fs` import is replaced. This strictly path-checked adapter serves the bundled snippet files and visibility JSON from memory. It recognizes only the exact extension snippet directory (`~/.pi/agent/snippets`), bundled source directory, and exact `~/.pi/agent/prompt-snippets-config.json` and `~/.pi/agent/prompt-snippets-defaults-ledger.json` paths. The in-memory ledger marks all bundled fixtures known, so capture never seeds or persists real defaults. Unknown snippet paths fail assertions. The exact visibility parent directory is recognized only for the extension's existence check; this returns in-memory metadata and never accesses that directory. The real snippet/config/ledger paths are compared as strings, never opened or written. Temporary selection is asserted not to modify any snippet fixture. The extension's homedir-based paths are independent of `PI_CODING_AGENT_DIR`; that variable alone would not isolate them.

Pi's own configuration uses a clean capture-only `PI_CODING_AGENT_DIR` under ignored `capture-output/`. HOME, XDG and cache locations are not overridden. No other user extensions, skills, templates, themes, context files, MCP servers, tools, or sessions are loaded. The CLI uses documented `--no-extensions -e <capture.mjs> --no-skills --no-prompt-templates --no-themes --no-context-files --no-mcp --no-tools --no-session --offline --provider capture-offline --model GPT-Ivan`. The adapter invokes the project extension unchanged; the provider adds no UI widgets or responses.

The clean settings omit `theme`, so Pi uses its genuine **`system` default**, not the separately selectable stock `dark` theme. Verified against installed `docs/themes.md`, `theme.js` and `getSettingsListTheme()`: selected labels, values and cursor use Pi's semantic `accent`. This isolated tmux terminal does not answer OSC foreground/background/ANSI-palette queries, so stock system falls back to ANSI indices/default terminal colors (recorded in `native-theme.json` intermediates). The rasterizer's explicit terminal fixture uses xterm's 16-color palette (listed in the script), default foreground `#e5e5e5`, background `#000000`; SGR 2 uses half-intensity foreground composited against its background. This is an emulator default palette, not a custom Pi theme. It is not a claim that every desktop terminal's system theme looks identical. The stock opt-in dark theme uses violet accents (`okhsl(295 50% 67%)`), but those values are not forced into these default-system captures.

The supported `registerProvider`/`streamSimple` API supplies a capture-only offline provider. It records the request context, emits a start and successful empty completion, and closes the stream. Assistant content is an empty array. Its dummy credential is local fixture metadata, not a real secret. It performs no HTTP request, model inference, or paid activity. Zero usage/cost is fixture bookkeeping, not measured usage from a real model. The native footer identifies the registered fixture model as `GPT-Ivan` (the user-approved fixture name). This is not an OpenAI/GPT service or a real GPT response.

## Approved fixture and sequence

Both modes use the identical, unmodified bundled bodies of:

- Session kickoff: prepend, temporary
- Orchestrator mode: prepend, temporary
- Ask questions: append, temporary

The exact typed input is `Help me review this project.`

The native keyboard sequence opens `/snippets`, selects the two prepend snippets and one append snippet with Space/Down, uses Tab to preview Ask questions and Tab to return, then Esc to save/apply. The widget is shown above the editor. The input is typed and Enter sends it. Hidden additionally navigates to Visibility and cycles it to Hidden before applying. The sent transcript and native editor/footer are captured after the empty offline completion.

- `demo.gif`: complete Visible sequence, from standard startup through menu selection, Tab preview, applied pending widget, typed input and send.
- `menu.gif`: menu/selection only; no preview or send.
- `visible.gif`: only the applied pending widget, exact typed input and sent Visible transcript. No selection menu or Tab preview.
- `hidden.gif`: only the applied pending widget, identical input and sent Hidden transcript. No selection menu or Tab preview. Both send clips use unchanged full terminal frames starting immediately after Esc applies selection.
- `menu.png`, `preview.png`, `widget.png`: regenerated compatible stills; `menu.png` remains the package image referenced by `package.json`.

The driver asserts that the provider receives exactly the same complete prompt in both modes, in snippet/input order, and checks that the final Visible screen includes the end of the appended prompt while Hidden shows the typed input without snippet bodies. In-memory session entries, request context, styled terminal snapshots, PNG intermediates and encoding lists stay under ignored `capture-output/` for inspection. No real user content is in the fixtures.

## Reproduce (macOS)

Requires already installed project development dependencies, Node (VM modules), tmux, Python 3 with Pillow, macOS Menlo, and ffmpeg. No dependency installation is performed.

```sh
bash docs/assets/capture.sh
```

Set `FFMPEG=/path/to/ffmpeg` if needed. The capture child prepends the verified existing `~/.pi/agent/bin` to PATH for executable discovery of fd and ripgrep; it does not relocate their caches. The driver executes `fd --version` and `rg --version` with this same child PATH and records those versions in the manifest. These already installed binaries avoid Pi's missing-command warnings; no installs or downloads occur. The driver rejects snapshots containing native warnings rather than cropping or hiding them. The checked-in `capture-manifest.json` records installed versions, application source SHA-256 (a deterministic digest of the sorted relative-path-to-SHA-256 map for the module tree, also recorded as `sourceFilesSha256`; the complete map is asserted unchanged from capture start to finish), exact input, selected temporary snippet IDs, resolved native theme tokens, terminal dimensions, frame timings, GIF SHA-256/file sizes and ffprobe dimensions/frame counts/durations, per-frame GIF delays, and verification results. Capture validation asserts all three selected titles are temporary (two prepend, one append), exact full request-body equality, an actual successful empty assistant entry, complete Visible body display, Hidden original-only display, no warning or `IdeaProjects` text in any displayed snapshot, no menu/preview in send clips, and model/cwd on the bottom two native footer lines. Timings are deliberately held terminal states, not a claim of real-time interaction speed. `capture-browser.py` is a retained legacy compatibility helper and is not used by this pipeline.

The existing checked-in media and manifest remain historical capture artifacts from the original single-file layout; their `sourceSha256` still identifies that original file. A new capture uses the module-tree provenance described above. The refactor's VM smoke test exercises module loading, in-memory ledger handling, selection, and injection without regenerating images or videos.

## Verification boundary

These captures verify actual interactive CLI input, native extension menu/preview/widget output, Visible versus Hidden display, native transcript clipping/layout and the context delivered to the offline provider. They do not demonstrate a real model response, network transport, installation, a reload, real-user-file persistence, or cross-session lifecycle behavior. Those are not represented as verified by these images.
