declare module 'jsnes' {
  export interface NESOpts {
    onFrame?: (buffer: ReadonlyArray<number>) => void;
    onAudioSample?: (left: number, right: number) => void;
    sampleRate?: number;
  }
  export class NES {
    constructor(opts?: NESOpts);
    loadROM(data: string): void;
    reloadROM(): void;
    frame(): void;
    buttonDown(player: number, button: number): void;
    buttonUp(player: number, button: number): void;
    toJSON(): unknown;
    fromJSON(s: unknown): void;
  }
  export const Controller: {
    BUTTON_A: number;
    BUTTON_B: number;
    BUTTON_SELECT: number;
    BUTTON_START: number;
    BUTTON_UP: number;
    BUTTON_DOWN: number;
    BUTTON_LEFT: number;
    BUTTON_RIGHT: number;
  };
}
