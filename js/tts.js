// Озвучка. По умолчанию — живой голос Google Переводчика (бесплатно, нужен интернет).
// Запасной вариант — встроенные голоса системы (работают офлайн).
import { settings } from './state.js';
import { langByCode } from './langs.js';

const synth = window.speechSynthesis;
export const ttsAvailable = true;

// ---------- Голоса системы ----------
export function voicesFor(lang) {
  if (!synth) return [];
  const prefix = langByCode(lang).speech.slice(0, 2);
  return synth.getVoices().filter((v) => v.lang.toLowerCase().startsWith(prefix));
}

function pickVoice(lang) {
  const list = voicesFor(lang);
  return list.find((v) => v.voiceURI === settings.ttsVoice)
    || list.find((v) => /natural|online|enhanced|premium|neural/i.test(v.name))
    || list.find((v) => v.localService) || list[0];
}

function systemSay(text, lang) {
  return new Promise((resolve) => {
    if (!synth) { resolve(); return; }
    const u = new SpeechSynthesisUtterance(text);
    u.lang = langByCode(lang).speech;
    const v = pickVoice(lang);
    if (v) u.voice = v;
    u.rate = settings.ttsRate;
    u.onend = resolve;
    u.onerror = resolve;
    synth.speak(u);
  });
}

// ---------- Голос Google ----------
const gl = (code) => ({ zh: 'zh-CN', he: 'iw' }[code] || code);
const player = new Audio();      // один плеер — так iPhone разрешает проигрывать подряд
const warm = new Audio();        // подгружает следующий фрагмент заранее
warm.preload = 'auto';

function splitForTts(text, max = 180) {
  const parts = [];
  let rest = text.replace(/\s+/g, ' ').trim();
  while (rest.length > max) {
    let cut = Math.max(rest.lastIndexOf('. ', max), rest.lastIndexOf(', ', max), rest.lastIndexOf('; ', max));
    if (cut < max * 0.4) cut = rest.lastIndexOf(' ', max);
    if (cut <= 0) cut = max;
    parts.push(rest.slice(0, cut + 1).trim());
    rest = rest.slice(cut + 1).trim();
  }
  if (rest) parts.push(rest);
  return parts;
}

const ttsUrl = (text, lang) =>
  'https://translate.googleapis.com/translate_tts?' + new URLSearchParams({ client: 'gtx', ie: 'UTF-8', tl: gl(lang), q: text });

let cancelPlay = null;
function playUrl(url) {
  return new Promise((resolve, reject) => {
    cancelPlay = resolve;
    player.onended = () => resolve();
    player.onerror = () => reject(new Error('audio'));
    player.src = url;
    player.playbackRate = settings.ttsRate;
    player.preservesPitch = true;
    player.play().catch(reject);
  });
}

async function googleSay(text, lang, isCurrent, nextText) {
  const parts = splitForTts(text);
  for (let i = 0; i < parts.length; i++) {
    if (!isCurrent()) return;
    const upcoming = parts[i + 1] ?? (nextText ? splitForTts(nextText)[0] : null);
    if (upcoming) { warm.src = ttsUrl(upcoming, lang); warm.load(); }
    await playUrl(ttsUrl(parts[i], lang));
  }
}

let session = 0;
let googleFailed = false;

async function say(text, lang, isCurrent, nextText) {
  if (settings.ttsEngine !== 'system' && !googleFailed && navigator.onLine !== false) {
    try { await googleSay(text, lang, isCurrent, nextText); return; }
    catch (e) {
      // Браузер не дал включить звук без нажатия — это не сбой голоса, просто молчим.
      if (!isCurrent() || e?.name === 'NotAllowedError') return;
      googleFailed = true; // до перезапуска говорим системным голосом
      setTimeout(() => { googleFailed = false; }, 60000);
    }
  }
  if (isCurrent()) await systemSay(text, lang);
}

export function speak(text, lang) {
  stopSpeech();
  const my = session;
  say(text, lang, () => my === session);
}

// Читает предложения по очереди и сообщает, какое звучит сейчас.
export async function speakSequence(items, lang, { onItem, onEnd } = {}) {
  stopSpeech();
  const my = session;
  const isCurrent = () => my === session;
  for (let i = 0; i < items.length; i++) {
    if (!isCurrent()) return;
    onItem?.(i);
    await say(items[i], lang, isCurrent, items[i + 1]);
  }
  if (isCurrent()) onEnd?.();
}

export function stopSpeech() {
  session++;
  cancelPlay?.();
  cancelPlay = null;
  player.pause();
  player.removeAttribute('src');
  synth?.cancel();
}

if (synth) synth.onvoiceschanged = () => document.dispatchEvent(new Event('voices'));
