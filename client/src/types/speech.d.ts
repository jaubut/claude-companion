// Web Speech API — SpeechRecognition is not in TypeScript's DOM lib (it is
// vendor-prefixed in Chromium and absent elsewhere), so composer.tsx's dictation
// never typechecked: `tsc -b` in client/ has been red on five errors since the
// feature landed. Minimal declarations for the members the composer uses;
// SpeechRecognitionResult / ResultList / Alternative already exist in lib.dom.

interface SpeechRecognitionEventMap {
  result: SpeechRecognitionEvent
  end: Event
  error: SpeechRecognitionErrorEvent
  start: Event
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean
  interimResults: boolean
  lang: string
  maxAlternatives: number
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null
  onend: ((this: SpeechRecognition, ev: Event) => void) | null
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null
  onstart: ((this: SpeechRecognition, ev: Event) => void) | null
  start(): void
  stop(): void
  abort(): void
  addEventListener<K extends keyof SpeechRecognitionEventMap>(
    type: K,
    listener: (this: SpeechRecognition, ev: SpeechRecognitionEventMap[K]) => void,
    options?: boolean | AddEventListenerOptions,
  ): void
}

declare var SpeechRecognition: {
  prototype: SpeechRecognition
  new (): SpeechRecognition
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number
  readonly results: SpeechRecognitionResultList
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string
  readonly message: string
}

interface Window {
  SpeechRecognition: typeof SpeechRecognition
  webkitSpeechRecognition: typeof SpeechRecognition
}
