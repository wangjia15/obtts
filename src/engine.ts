import type { TtsEngine } from './types';
// `ws` is forced to its Node codepath via the esbuild alias (see esbuild.config.mjs)
// so we can set the `Origin`/`User-Agent` headers the read-aloud endpoint requires —
// the renderer's native browser WebSocket cannot, and is rejected ("Expected 101").
import WebSocket from 'ws';

/**
 * Microsoft Edge neural TTS via the free, key-less read-aloud endpoint.
 *
 * Reimplemented over the Node `ws` client (bundled): the Sec-MS-GEC token is
 * computed with `crypto.subtle`, and the SSML/audio/turn framing is reproduced
 * from the upstream protocol. The endpoint authorizes on the query-string token
 * but ALSO enforces an Edge `Origin` header, which `ws` (unlike the browser
 * WebSocket) can set.
 *
 * Every operation goes through one serial queue, and each `synth` call atomically
 * (re)connects to the requested voice if needed and then streams — so the
 * player's concurrent prefetch (and per-paragraph voice switching) can never tear
 * the WebSocket down mid-synthesis or synthesize a chunk with the wrong voice.
 */

const TOKEN = '6A5AA1D4EAFF4E9FB37E23D68491D6F4';
const WSS =
  'wss://speech.platform.bing.com/consumer/speech/synthesize/readaloud/edge/v1';
const VOICES_URL = `https://speech.platform.bing.com/consumer/speech/synthesize/readaloud/voices/list?trustedclienttoken=${TOKEN}`;
const OUTPUT_FORMAT = 'audio-24khz-48kbitrate-mono-mp3';
const GEC_VERSION = '1-143.0.3650.96';
const ORIGIN = 'chrome-extension://jdiccldimpdaibmpdkjnbmckianbfold';
const USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/143.0.0.0 Safari/537.36 Edg/143.0.0.0';

const JSON_XML_DELIM = '\r\n\r\n';
const AUDIO_DELIM = 'Path:audio\r\n';
const TURN_END = 'Path:turn.end';

const SYNTH_TIMEOUT = 30000;

/** A timer handle accepted by `clearTimeout` across the DOM and Node typings. */
export type TimerHandle = NodeJS.Timeout | number;

// Inline XML-entity escaping for SSML text content (&, <, > are the dangerous ones).

/** Derive a BCP-47 locale from a voice short name, e.g. "de-DE-Seraphina…" -> "de-DE". */
function localeFromVoice(voice: string): string {
  const m = voice.match(/^[a-z]{2,3}-[A-Za-z]{2,}/);
  return m ? m[0] : 'en-US';
}

/** Compute the Sec-MS-GEC token the endpoint authorizes on (SHA-256 of ticks+token). */
async function computeGec(): Promise<string> {
  const ticks = Math.floor(Date.now() / 1000) + 11644473600;
  const rounded = ticks - (ticks % 300);
  const winTicks = rounded * 10000000;
  const data = new TextEncoder().encode(winTicks + '' + TOKEN);

  if (globalThis.crypto?.subtle) {
    const hash = await globalThis.crypto.subtle.digest('SHA-256', data);
    return toHexUpper(new Uint8Array(hash));
  }
  // Contingency: non-secure context — Node crypto via the renderer's require.
  const nodeCrypto = nodeCreateHash();
  if (nodeCrypto) {
    return nodeCrypto('sha256').update(data).digest('hex').toUpperCase();
  }
  throw new Error('Edge TTS: no SHA-256 implementation available (crypto.subtle missing)');
}

/** Minimal Node `crypto.createHash` accessor for the non-secure-context fallback. */
function nodeCreateHash():
  | ((alg: string) => { update(d: Uint8Array): { digest(enc: string): string } })
  | undefined {
  // Node's CommonJS `require` is present on globalThis in the Electron renderer.
  const g = globalThis as { require?: unknown };
  const requireFn = g.require;
  if (typeof requireFn !== 'function') return undefined;
  const mod: unknown = requireFn('crypto');
  if (!mod || typeof mod !== 'object' || !('createHash' in mod)) return undefined;
  const fn = mod.createHash; // narrowed to unknown by `in`, then to function below
  if (typeof fn !== 'function') return undefined;
  // `fn` is Node's `createHash`; its exact signature is unexpressible from `unknown`.
  return fn as (alg: string) => { update(d: Uint8Array): { digest(enc: string): string } };
}

function toHexUpper(bytes: Uint8Array): string {
  let hex = '';
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
  return hex.toUpperCase();
}

function newConnectionId(): string {
  const { crypto } = globalThis;
  if (crypto && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return 'xxxxxxxx-xxxx-xxxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (ch) => {
    const r = (Math.random() * 16) | 0;
    const v = ch === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

function randomHex(byteLength: number): string {
  const arr = new Uint8Array(byteLength);
  const { crypto } = globalThis;
  if (crypto && typeof crypto.getRandomValues === 'function') crypto.getRandomValues(arr);
  else for (let i = 0; i < byteLength; i++) arr[i] = Math.floor(Math.random() * 256);
  return toHexUpper(arr);
}

interface PendingSynth {
  resolve: (ab: ArrayBuffer) => void;
  reject: (e: unknown) => void;
  chunks: Uint8Array[];
  timer: TimerHandle;
}

export class EdgeTtsEngine implements TtsEngine {
  readonly id = 'edge';
  readonly mime = 'audio/mpeg';

  private ws: WebSocket | null = null;
  private voice = '';
  private locale = '';
  private tail: Promise<unknown> = Promise.resolve();
  private pending = new Map<string, PendingSynth>();

  /** Public endpoint (kept for an optional catalog refresh; unused by default). */
  static readonly voicesUrl = VOICES_URL;

  synth(text: string, voice: string, locale: string): Promise<ArrayBuffer> {
    const escaped = text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    const loc = locale || localeFromVoice(voice);
    return this.enqueue(() => this.synthOnce(escaped, voice, loc, true));
  }

  warm(voice: string, locale: string): Promise<void> {
    const loc = locale || localeFromVoice(voice);
    return this.enqueue(async () => {
      // The voice travels in each request's SSML, so one open socket serves any
      // voice/locale — only (re)connect when we don't have a live one.
      if (!this.isOpen()) await this.connect(voice, loc);
    });
  }

  /** True when the current socket exists and is ready to send. */
  private isOpen(): boolean {
    return !!this.ws && this.ws.readyState === WebSocket.OPEN;
  }

  /** Serialize all socket-touching work; one operation at a time, FIFO. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn, fn);
    this.tail = run.then(
      () => undefined,
      () => undefined
    );
    return run as Promise<T>;
  }

  private connect(voice: string, locale: string): Promise<void> {
    this.closeSocket();
    return this.connectOnce(voice, locale);
  }

  private async connectOnce(voice: string, locale: string): Promise<void> {
    const gec = await computeGec();
    const url = `${WSS}?TrustedClientToken=${TOKEN}&Sec-MS-GEC=${gec}&Sec-MS-GEC-Version=${GEC_VERSION}&ConnectionId=${newConnectionId()}`;
    const ws = new WebSocket(url, { headers: { 'User-Agent': USER_AGENT, Origin: ORIGIN }, agent: undefined });

    await new Promise<void>((resolve, reject) => {
      const fail = (msg: string) => reject(new Error(`Edge TTS connect failed: ${msg}`));
      ws.once('open', () => resolve());
      ws.once('error', (e: Error) => fail(e?.message ? String(e.message) : String(e)));
      ws.once('close', (code: number) => fail(`socket closed (code=${code}) before open`));
    });

    // Route all subsequent frames; clear the one-shot open/error listeners.
    ws.removeAllListeners();
    ws.on('message', (data: Buffer, isBinary: boolean) => this.onFrame(data, isBinary));
    ws.on('error', () => {
      /* per-synth errors surface via onclose/reject */
    });
    ws.on('close', () => {
      // Drop the reference so the next synth/warm reconnects rather than reusing a dead socket.
      if (this.ws === ws) this.ws = null;
      this.failAll(new Error('Edge TTS socket closed'));
    });

    // speech.config: tell the service the output format we want.
    const cfg =
      `Content-Type:application/json; charset=utf-8\r\nPath:speech.config${JSON_XML_DELIM}` +
      JSON.stringify({
        context: {
          synthesis: {
            audio: {
              metadataoptions: { sentenceBoundaryEnabled: 'false', wordBoundaryEnabled: 'false' },
              outputFormat: OUTPUT_FORMAT,
            },
          },
        },
      });
    ws.send(cfg);

    this.ws = ws;
    this.voice = voice;
    this.locale = locale;
  }

  private async synthOnce(escaped: string, voice: string, locale: string, retry: boolean): Promise<ArrayBuffer> {
    if (!escaped.trim()) return new ArrayBuffer(0);
    // Reconnect only when the socket is gone/closed — NOT on every voice switch.
    // Each request carries its own voice in the SSML, so a single connection can
    // serve mixed-language documents without tearing down between sentences.
    if (!this.isOpen()) {
      await this.connect(voice, locale);
    }

    const requestId = randomHex(16);
    const ssml =
      `<speak version="1.0" xmlns="http://www.w3.org/2001/10/synthesis" xmlns:mstts="https://www.w3.org/2001/mstts" xml:lang="${locale}">` +
      `<voice name="${voice}"><prosody pitch="+0Hz" rate="+0%" volume="100">${escaped}</prosody></voice></speak>`;
    const request = `X-RequestId:${requestId}\r\nContent-Type:application/ssml+xml\r\nPath:ssml${JSON_XML_DELIM}${ssml}`;

    try {
      const buf = await this.sendRequest(requestId, request);
      // A mid-stream socket close can end a turn with truncated/empty bytes.
      // Treat an empty result for real text as a failure and retry once fresh.
      if (buf.byteLength === 0 && retry) {
        await this.connect(voice, locale);
        return this.synthOnce(escaped, voice, locale, false);
      }
      return buf;
    } catch (err) {
      if (retry) {
        await this.connect(voice, locale);
        return this.synthOnce(escaped, voice, locale, false);
      }
      throw err;
    }
  }

  private sendRequest(requestId: string, frame: string): Promise<ArrayBuffer> {
    return new Promise<ArrayBuffer>((resolve, reject) => {
      const entry: PendingSynth = {
        resolve,
        reject,
        chunks: [],
        timer: setTimeout(() => {
          this.pending.delete(requestId);
          reject(new Error('Edge TTS timeout'));
        }, SYNTH_TIMEOUT),
      };
      this.pending.set(requestId, entry);
      try {
        this.ws!.send(frame);
      } catch (e) {
        clearTimeout(entry.timer);
        this.pending.delete(requestId);
        reject(e);
      }
    });
  }

  /** Route one inbound frame: audio -> append; turn.end -> resolve. */
  private onFrame(data: Buffer, isBinary: boolean): void {
    const header = isBinary ? data.toString('latin1') : data.toString();
    const requestId = parseRequestId(header);

    const ai = header.indexOf(AUDIO_DELIM);
    if (ai >= 0) {
      const e = requestId ? this.pending.get(requestId) : undefined;
      if (e) {
        const start = ai + AUDIO_DELIM.length;
        e.chunks.push(data.subarray(start));
      }
      return;
    }
    if (header.includes(TURN_END)) {
      const e = requestId ? this.pending.get(requestId) : undefined;
      if (e) this.complete(requestId, e);
    }
  }

  private complete(requestId: string, e: PendingSynth): void {
    clearTimeout(e.timer);
    this.pending.delete(requestId);
    const merged =
      e.chunks.length === 0
        ? new ArrayBuffer(0)
        : e.chunks.length === 1
        ? e.chunks[0].slice().buffer
        : concatBytes(e.chunks);
    e.resolve(merged);
  }

  private failAll(err: Error): void {
    for (const [id, e] of this.pending) {
      clearTimeout(e.timer);
      e.reject(err);
    }
    this.pending.clear();
  }

  private closeSocket(): void {
    if (this.ws) {
      try {
        this.ws.removeAllListeners();
        this.ws.close();
      } catch {
        /* ignore */
      }
      this.ws = null;
    }
  }

  dispose(): void {
    this.closeSocket();
    this.failAll(new Error('Edge TTS disposed'));
    this.voice = '';
    this.locale = '';
  }
}

function parseRequestId(header: string): string {
  const m = /X-RequestId:([0-9a-fA-F]+)/.exec(header);
  return m ? m[1] : '';
}

function concatBytes(chunks: Uint8Array[]): ArrayBuffer {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let off = 0;
  for (const c of chunks) {
    out.set(c, off);
    off += c.length;
  }
  return out.buffer;
}
