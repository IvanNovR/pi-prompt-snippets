// Public-API event-order reproduction. No provider request or runtime patches.
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

const dir = mkdtempSync(join(tmpdir(), 'snippet-queue-order-'));
const trace = [];
try {
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [(pi) => {
      let recorded = false;
      pi.on('input', (event) => {
        trace.push(`input ${JSON.stringify(event.text)} recorded=${recorded} streamingBehavior=${event.streamingBehavior}`);
        if (!recorded) return { action: 'transform', text: `PRE\n\n${event.text}\n\nPOST` };
      });
      pi.on('message_end', (event) => {
        if (event.message.role === 'user') recorded = true;
      });
    }],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const model = modelRuntime.getModels().find((m) => m.provider === 'anthropic');
  if (!model) throw new Error('Fixture requires an installed static Anthropic model');
  await modelRuntime.setRuntimeApiKey(model.provider, 'test-only-no-network');
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime, settingsManager,
    resourceLoader, sessionManager: SessionManager.inMemory(dir), tools: [], thinkingLevel: 'off' });
  // Supported Agent stream injection: offline deterministic response, not a provider.
  session.agent.streamFunction = () => {
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    stream.push({ type: 'done', reason: 'stop', message });
    stream.end();
    return stream;
  };
  session.subscribe((event) => {
    if (event.message?.role === 'user' && ['message_start', 'message_end'].includes(event.type))
      trace.push(`${event.type} ${JSON.stringify(event.message.content)}`);
  });
  await session.bindExtensions({ mode: 'print', onError: (error) => { throw new Error(JSON.stringify(error)); } });
  await session.steer('queued A'); // Public API accepts queue input while idle.
  await session.prompt('starting B');
  console.log(trace.join('\n'));
  await session.dispose();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
