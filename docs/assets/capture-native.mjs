// Capture-only native-component adaptation. Never modifies installed Pi files.
// Preserve the actual BuiltInHeader, footer implementation, and all layout ownership.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { InteractiveMode } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/interactive-mode.js';
import { FooterComponent } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/components/footer.js';
import { theme } from '../../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js';
import { Text } from '@earendil-works/pi-tui';
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const originalNotice = InteractiveMode.prototype.showFullscreenModelScopeNotice;
assert.equal(typeof originalNotice, 'function');
InteractiveMode.prototype.showFullscreenModelScopeNotice = function () {
  assert.ok(this.builtInHeader && this.headerContainer.children.includes(this.builtInHeader));
  this.headerContainer.addChild(new Text(theme.fg('muted', '@ivannovr/pi-prompt-snippets'), 1, 0));
  const result = originalNotice.call(this);
  fs.writeFileSync(path.join(process.env.CAPTURE_RUN_DIR, 'native-theme.json'), JSON.stringify({ name: theme.name, appearance: theme.appearance, colors: theme.colors }, null, 2));
  return result;
};
const originalRender = FooterComponent.prototype.render;
FooterComponent.prototype.render = function (width) {
  const lines = originalRender.call(this, width);
  assert.equal(this.session.sessionManager.getCwd(), root);
  lines[0] = lines[0].replace('~/Projects/IdeaProjects/pi-prompt-snippets', '~/Projects/pi-prompt-snippets');
  return lines;
};
