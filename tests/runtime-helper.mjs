import { join } from 'node:path';
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } from '@earendil-works/pi-coding-agent';
import { createAssistantMessageEventStream } from '@earendil-works/pi-ai';

// Real AgentSession input, queue, Agent loop, extension runner and persistence.
// Only the model stream is deterministic/offline, through its supported setter.
export async function queuedSession(t, { dir, extension, menuUI }) {
  let menuCommand;
  let context;
  const runtimeExtension = (pi) => {
    extension({ ...pi, registerCommand(name, options) {
      if (name === 'snippets') menuCommand = options.handler;
      pi.registerCommand(name, options);
    } });
    pi.on('session_start', (_event, ctx) => { context = ctx; });
  };
  const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const resourceLoader = new DefaultResourceLoader({
    cwd: dir, agentDir: dir, settingsManager, noExtensions: true,
    noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [runtimeExtension],
  });
  await resourceLoader.reload();
  const modelRuntime = await ModelRuntime.create({ authPath: join(dir, 'auth.json'), modelsPath: null, refreshOnCreate: false });
  const model = modelRuntime.getModels().find((m) => m.provider === 'anthropic' && m.input.includes('image'));
  if (!model) throw new Error('Fixture requires installed static Anthropic model');
  await modelRuntime.setRuntimeApiKey(model.provider, 'test-only-no-network');
  const { session } = await createAgentSession({ cwd: dir, agentDir: dir, model, modelRuntime, settingsManager,
    resourceLoader, sessionManager: SessionManager.inMemory(dir), tools: [], thinkingLevel: 'off' });
  t.after(() => session.dispose());
  let holdResponse = false;
  let releaseResponse;
  let responseStarted;
  session.agent.streamFunction = () => {
    const stream = createAssistantMessageEventStream();
    const message = { role: 'assistant', content: [], api: model.api, provider: model.provider, model: model.id,
      usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: 'stop', timestamp: Date.now() };
    const finish = () => {
      stream.push({ type: 'done', reason: 'stop', message });
      stream.end();
    };
    if (holdResponse) {
      holdResponse = false;
      releaseResponse = finish;
      responseStarted();
    } else finish();
    return stream;
  };
  const starts = [];
  session.subscribe((event) => {
    if (event.type === 'message_start' && event.message.role === 'user') {
      starts.push(structuredClone(event.message));
    }
  });
  await session.bindExtensions({ mode: 'print', onError: (error) => { throw new Error(JSON.stringify(error)); } });
  return { session, starts,
    holdNextResponse() {
      holdResponse = true;
      return { started: new Promise((resolve) => { responseStarted = resolve; }), release: () => releaseResponse() };
    },
    menu: async (keys) => {
      const ui = menuUI(keys);
      await menuCommand('', { ...context, mode: 'tui', hasUI: true, ui });
    },
  };
}
