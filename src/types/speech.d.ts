// Minimal ambient declarations for the Web Speech API.
//
// The spec is still a Working Draft and isn't shipped in `lib.dom.d.ts`,
// but it's implemented in Chromium / WebView2 (which Tauri uses on
// Windows) under the unprefixed `SpeechRecognition` constructor. Older
// versions and Safari expose `webkitSpeechRecognition` with the same
// shape. Both branches are handled at the call site via a fallback:
//   const SR = window.SpeechRecognition ?? window.webkitSpeechRecognition;
//
// We only declare the surface we actually use — the full spec has many
// more fields (grammars, maxAlternatives, ...) we don't touch.

export {};

declare global {
  interface SpeechRecognitionAlternative {
    readonly transcript: string;
    readonly confidence: number;
  }

  interface SpeechRecognitionResult {
    readonly isFinal: boolean;
    readonly length: number;
    item(index: number): SpeechRecognitionAlternative;
    [index: number]: SpeechRecognitionAlternative;
  }

  interface SpeechRecognitionResultList {
    readonly length: number;
    item(index: number): SpeechRecognitionResult;
    [index: number]: SpeechRecognitionResult;
  }

  interface SpeechRecognitionEvent extends Event {
    readonly resultIndex: number;
    readonly results: SpeechRecognitionResultList;
  }

  interface SpeechRecognitionErrorEvent extends Event {
    readonly error: string;
    readonly message?: string;
  }

  interface SpeechRecognition extends EventTarget {
    lang: string;
    continuous: boolean;
    interimResults: boolean;
    maxAlternatives: number;
    start(): void;
    stop(): void;
    abort(): void;
    onresult:
      | ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void)
      | null;
    onerror:
      | ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void)
      | null;
    onend: ((this: SpeechRecognition, ev: Event) => void) | null;
    onstart: ((this: SpeechRecognition, ev: Event) => void) | null;
  }

  type SpeechRecognitionCtor = new () => SpeechRecognition;

  interface Window {
    SpeechRecognition?: SpeechRecognitionCtor;
    webkitSpeechRecognition?: SpeechRecognitionCtor;
  }
}
