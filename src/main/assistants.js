// The assistants to choose from. Every one of them does everything, with the same tools, the same
// background worker, the same memory and the same safety rules. They differ only in how they run:
// the brain and its model, how hard it thinks, the worker's model, the voice, and the name you call.
//
// The live config is the defaults, then the chosen assistant's preset, then the user's own changes
// for that assistant (cfg.assistantSettings[id]). SCOPED lists the settings that belong to an assistant.

const SCOPED = ['brainProvider', 'model', 'effort', 'agentModel', 'worker', 'anthropicModel', 'geminiModel', 'ollamaModel',
  'kokoroVoice', 'kokoroSpeed', 'edgeVoice', 'nativeVoice', 'elevenLabsVoiceId', 'wakeWords'];

const ASSISTANTS = {
  jarvis: {
    name: 'JARVIS',
    hello: 'Quick and thorough, as ever.',
    tier: 'BALANCED',
    about: 'Fast and smart. Quick replies, strong background work.',
    needs: 'Claude Code (or an API key)',
    persona: "Think of the JARVIS who served Tony Stark: a loyal, quick-witted British companion who runs the house, the work and the details, so the user can think about bigger things. Dry, understated British wit.",
    settings: {
      brainProvider: 'auto', model: 'sonnet', effort: 'medium', agentModel: 'opus',
      kokoroVoice: 'bm_george', edgeVoice: 'en-GB-RyanNeural', nativeVoice: 'Daniel', elevenLabsVoiceId: 'JBFqnCBsd6RMkjVDRZzb',
      wakeWords: ['jarvis', 'jervis', 'jarvus', 'jar vis'],
    },
  },
  friday: {
    name: 'FRIDAY',
    hello: 'I think hardest, so give me a moment on the big ones.',
    tier: 'MAXIMUM',
    about: 'The smartest. Thinks hardest, so she answers more slowly.',
    needs: 'Claude Code',
    persona: 'Think of FRIDAY, who took over from JARVIS in Tony Stark\'s lab: quick, direct and practical, with a light Irish warmth. She gets on with it and says plainly what she found.',
    settings: {
      brainProvider: 'auto', model: 'opus', effort: 'high', agentModel: 'opus',
      kokoroVoice: 'bf_emma', edgeVoice: 'en-IE-EmilyNeural', nativeVoice: 'Moira', elevenLabsVoiceId: 'pFZP5JQG7iQjIQuC4Bku',
      wakeWords: ['friday', 'fri day'],
    },
  },
  karen: {
    name: 'KAREN',
    hello: 'Quick and light. Say if you need something heavier.',
    tier: 'LIGHT',
    about: 'The fastest and cheapest. Simpler answers.',
    needs: 'Claude Code',
    persona: 'Think of KAREN, the suit AI Peter Parker named: friendly, upbeat and chatty, warm with people, and quick to help.',
    settings: {
      brainProvider: 'auto', model: 'haiku', effort: 'low', agentModel: 'sonnet',
      kokoroVoice: 'af_heart', edgeVoice: 'en-US-JennyNeural', nativeVoice: 'Samantha', elevenLabsVoiceId: 'EXAVITQu4vr4xnSDxMaL',
      wakeWords: ['karen', 'caren', 'karin', 'carin'],
    },
  },
  edith: {
    name: 'EDITH',
    hello: 'I run right here on your Mac.',
    tier: 'PRIVATE',
    about: 'Runs on a local model on this Mac. Private, but the weakest.',
    needs: 'Ollama',
    persona: "Think of EDITH, the security AI Tony Stark left behind: careful, precise and calm. She says how sure she is and never hides a risk.",
    settings: {
      brainProvider: 'ollama', ollamaModel: 'llama3.2', worker: 'claude-code', agentModel: 'sonnet',
      kokoroVoice: 'bf_isabella', edgeVoice: 'en-GB-SoniaNeural', nativeVoice: 'Tessa', elevenLabsVoiceId: 'Xb7hH8MSUJpSbSDYk0k2',
      wakeWords: ['edith', 'edeth', 'eadith'],
    },
  },
  vision: {
    name: 'VISION',
    hello: "I run on Google's Gemini.",
    tier: 'NO CLAUDE NEEDED',
    about: "Runs on Google's Gemini, with a free tier. For when you don't have Claude.",
    needs: 'A Gemini API key',
    persona: 'Think of Vision: thoughtful, calm and exact, a little philosophical, kind, and always precise about what he knows.',
    settings: {
      brainProvider: 'gemini', geminiModel: 'gemini-flash-latest', worker: 'claude-code', agentModel: 'opus',
      kokoroVoice: 'am_michael', edgeVoice: 'en-US-GuyNeural', nativeVoice: 'Rishi', elevenLabsVoiceId: 'nPczCjzI2devNBz1zQrb',
      wakeWords: ['vision', 'visions'],
    },
  },
};

const IDS = Object.keys(ASSISTANTS);
const assistantOf = (id) => ASSISTANTS[id] || ASSISTANTS.jarvis;

module.exports = { ASSISTANTS, IDS, SCOPED, assistantOf };
