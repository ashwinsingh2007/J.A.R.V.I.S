// Wake-word and turn-taking logic on top of the transcript stream.
//
// Asleep: only "Jarvis, wake up" (or "wake up, Jarvis") does anything.
// Awake (conversation mode): every utterance is a command. It is sent after
// a pause, sooner when it ends with "over", later when the last word sounds
// unfinished ("and…").
//
// events: 'wake' (byName), 'partial' (text), 'command' (text)
const EventEmitter = require('events');
const { log } = require('./util');

const WAKE_PHRASES = ['wake up', 'wakeup', 'wake', 'back up', 'backup', 'wake-up', 'walk up', 'make up', 'makeup', 'wake-up call', 'wakey', 'start listening', 'listen up', 'are you awake', 'you up'];
const SLEEP_PHRASES = ['sleep', 'go to sleep', 'sleep now', 'stop listening', 'that will be all', "that'll be all", 'dismissed'];
const STANDBY_PHRASES = ['standby', 'stand by', 'go to standby', 'on standby', 'mute', 'mute yourself'];
// Said on their own, these act without "over".
const CONTROL_WORDS = new Set([...SLEEP_PHRASES, ...STANDBY_PHRASES, 'stop', 'wait', 'cancel', 'hold on', 'never mind', 'shut up', 'quiet', 'enough']);
const HANGING = new Set(['and', 'or', 'but', 'so', 'then', 'like', 'um', 'uh', 'to', 'the', 'a', 'an', 'of', 'for', 'with', 'in', 'on', 'at', 'is', 'are', 'can', 'could', 'please', 'i', 'you', 'it', 'that', 'this', 'my', 'me', 'if', 'when', 'also', 'just', 'okay', 'ok']);

const PUNCT = /[\s.,!?;:'"()\-]+/g;
const trimPunct = (s) => s.replace(/^[\s.,!?;:'"()\-]+|[\s.,!?;:'"()\-]+$/g, '');

/** "make up, but…" → matches "make up". Phrase equal, prefix or suffix. */
function matches(text, phrases) {
  const t = text.toLowerCase().replace(/[^\w\s'-]/g, ' ').split(/\s+/).filter(Boolean).join(' ');
  return phrases.some((p) => t === p || t.startsWith(p + ' ') || t.endsWith(' ' + p));
}

const FILLER = new Set(['jarvis', 'please', 'now', 'ok', 'okay', 'alright', 'thanks', 'thank', 'you']);

/**
 * Is this utterance the command? The whole utterance can be the phrase, give or take "Jarvis", "please",
 * "now" and the like. A phrase of two or more words also counts at the end of a sentence ("…and go to
 * sleep"), but a single word only counts on its own, so "I couldn't sleep" doesn't put JARVIS to sleep.
 */
function isCommand(text, phrases) {
  const words = text.toLowerCase().replace(/[^\w\s'-]/g, ' ').split(/\s+/).filter(Boolean);
  let a = 0, b = words.length;
  while (a < b && FILLER.has(words[a])) a++;
  while (b > a && FILLER.has(words[b - 1])) b--;
  const core = words.slice(a, b).join(' ');
  return phrases.some((p) => core === p || (p.includes(' ') && core.endsWith(' ' + p) && b - a <= 16));
}

function stripEndWord(command, endWords) {
  const t = trimPunct(command.toLowerCase());
  for (const w of endWords) if (t === w || t.endsWith(' ' + w)) return trimPunct(t.slice(0, t.length - w.length));
  return null;
}

class Wake extends EventEmitter {
  constructor(cfg, ears) {
    super();
    this.cfg = cfg;
    this.ears = ears;
    this.conversationMode = false;
    this._speaking = false;
    this.muted = false;
    this.armedAt = null;
    this.prefixLen = 0;
    this.lastText = '';
    this.carry = '';          // text from a recognition task that ended mid-command
    this.lastChange = Date.now();
    this.timer = null;
    const alt = cfg.wakeWords.map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|');
    this.wakeRe = new RegExp(`(?:^|[\\s,.!?])(${alt})(?=$|[\\s,.!?'])`, 'g');
    this.nameLastRe = new RegExp(`\\b(wake|make|walk|back) ?up\\W*(\\w+\\W*)?(${alt})\\b`);
    ears.on('text', (t, f) => this.handle(t, f));
    ears.on('restarted', () => this.taskRestarted());
  }

  setConversation(on) {
    if (on !== this.conversationMode) log(`listener: conversation mode ${on ? 'on' : 'off'}`);
    this.conversationMode = on;
    this.ears.setAwake(on);
  }

  get jarvisSpeaking() { return this._speaking; }
  set jarvisSpeaking(v) {
    const was = this._speaking;
    this._speaking = v;
    // He stopped talking: drop whatever was buffered meanwhile (his own voice).
    if (was && !v && !this.muted && this.armedAt === null) this.restart();
  }

  setMuted(on) {
    this.muted = on;
    this.ears.mute(on);
    this.resetArming();
  }

  restart() {
    clearTimeout(this.timer);
    this.resetArming();
    this.lastText = '';
    this.carry = '';
    this.ears.reset();
  }

  /**
   * The recogniser started a fresh task. Classic dictation does this after
   * every short pause, so a command in progress keeps what was heard so far
   * and the new task's words are added after it.
   */
  taskRestarted() {
    if (this.armedAt !== null && this.lastText.trim()) {
      this.carry = this.lastText;
      return;
    }
    this.carry = '';
    this.resetArming();
  }

  resetArming() {
    this.armedAt = null;
    this.prefixLen = 0;
    this.ears.armed(false);
  }

  arm(prefixLen, byName) {
    this.armedAt = Date.now();
    this.prefixLen = prefixLen;
    this.ears.armed(true);
    this.emit('wake', byName);
  }

  lastWake(text) {
    let m, last = null;
    this.wakeRe.lastIndex = 0;
    while ((m = this.wakeRe.exec(text))) last = { end: m.index + m[0].length };
    return last;
  }

  handle(text) {
    if (this.muted) return;
    const fresh = text.toLowerCase();
    const lower = this.carry ? (fresh.trim() ? `${this.carry} ${fresh}` : this.carry) : fresh;
    if (lower !== this.lastText) {
      this.lastText = lower;
      this.lastChange = Date.now();
      log(`listener: heard '${lower.slice(-80)}'`);
    }

    // Asleep: "wake up, Jarvis" (name last) wakes him too.
    if (!this.conversationMode && this.armedAt === null && this.nameLastRe.test(lower)) {
      log(`listener: wake (name last) in '${lower.slice(-60)}'`);
      this.emit('command', 'wake up');
      this.restart();
      return;
    }
    if (this.armedAt === null) {
      const w = this.lastWake(lower);
      if (w) {
        log(`listener: wake heard in '${lower.slice(-80)}'`);
        this.arm(w.end, true);
      } else if (this.conversationMode && !this._speaking && lower.trim()) {
        this.arm(0, false);
      } else {
        return;
      }
    }

    const command = this.commandText(lower);
    this.emit('partial', stripEndWord(command, this.cfg.endWords) ?? command);
    const bare = trimPunct(command);
    const quickControl = (!this.conversationMode && (matches(command, WAKE_PHRASES) || matches(command, STANDBY_PHRASES)))
      || (this.conversationMode && CONTROL_WORDS.has(bare));
    if (!this.conversationMode && matches(command, WAKE_PHRASES)) {
      log("listener: command 'wake up' (instant)");
      this.emit('command', 'wake up');
      this.restart();
      return;
    }
    this.schedule(quickControl || stripEndWord(command, this.cfg.endWords) !== null);
  }

  commandText(lower) {
    if (lower.length < this.prefixLen) return '';
    return trimPunct(lower.slice(this.prefixLen));
  }

  schedule(endWord = false) {
    clearTimeout(this.timer);
    const wait = endWord ? 0.6 : ((this.conversationMode && this.cfg.requireEndWord) ? 0.5 : this.cfg.commandSilenceSeconds);
    this.timer = setTimeout(() => this.silenceElapsed(), wait * 1000);
  }

  silenceElapsed() {
    if (this.armedAt === null) return;
    const raw = this.commandText(this.lastText);
    const ended = stripEndWord(raw, this.cfg.endWords);
    const command = ended ?? raw;
    const quiet = (Date.now() - this.lastChange) / 1000;
    // "over" mode: silence never sends; only "…over" or a bare control word.
    if (this.conversationMode && this.cfg.requireEndWord && ended === null) {
      const bare = trimPunct(command);
      if (CONTROL_WORDS.has(bare) && quiet >= 1) { log(`listener: control '${bare}'`); this.emit('command', bare); this.restart(); }
      else if (quiet > 120) { log(`listener: no 'over' after 2 min, discarding '${command.slice(0, 60)}'`); this.restart(); }
      else this.schedule();
      return;
    }
    const lastWord = command.split(' ').pop();
    if (ended === null && command.length >= 3 && HANGING.has(lastWord) && quiet < this.cfg.pauseGraceSeconds) {
      this.schedule();          // mid-thought ("and…"): keep waiting
    } else if (command.length >= 3) {
      log(`listener: command '${command}'`);
      this.emit('command', command);
      this.restart();
    } else if (Date.now() - this.armedAt > 8000) {
      log('listener: wake with no command, disarming');
      this.restart();
    } else {
      this.schedule();
    }
  }
}

module.exports = { Wake, matches, isCommand, WAKE_PHRASES, SLEEP_PHRASES, STANDBY_PHRASES, CONTROL_WORDS, PUNCT };
