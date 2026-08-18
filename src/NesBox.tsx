import { useEffect, useRef } from 'react';
import { NES, Controller } from 'jsnes';

export interface NesApi {
  snapshot: () => unknown;
  reload: (state?: unknown) => void;
}

const KEYMAP: Record<string, number> = {
  ArrowUp: Controller.BUTTON_UP,
  ArrowDown: Controller.BUTTON_DOWN,
  ArrowLeft: Controller.BUTTON_LEFT,
  ArrowRight: Controller.BUTTON_RIGHT,
  KeyX: Controller.BUTTON_A,
  KeyZ: Controller.BUTTON_B,
  Enter: Controller.BUTTON_START,
  ShiftLeft: Controller.BUTTON_SELECT,
  ShiftRight: Controller.BUTTON_SELECT,
};

function bufToBinary(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let s = '';
  const CH = 0x8000;
  for (let i = 0; i < bytes.length; i += CH) {
    s += String.fromCharCode(...bytes.subarray(i, i + CH));
  }
  return s;
}

export default function NesBox({
  romData,
  initialState,
  enabled,
  onApi,
  registerCanvas,
}: {
  romData: ArrayBuffer;
  initialState?: unknown;
  enabled: boolean;
  onApi?: (api: NesApi) => void;
  registerCanvas?: (c: HTMLCanvasElement | null) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const stateRef = useRef<unknown>(initialState);
  stateRef.current = initialState;
  const apiRef = useRef<NesApi | null>(null);

  useEffect(() => {
    const cv = canvasRef.current!;
    const ctx2 = cv.getContext('2d')!;
    const img = ctx2.createImageData(256, 240);
    const buf32 = new Uint32Array(img.data.buffer);

    let audio: AudioContext | null = null;
    let proc: ScriptProcessorNode | null = null;
    const RSIZE = 16384;
    const lb = new Float32Array(RSIZE);
    const rb = new Float32Array(RSIZE);
    let wp = 0, rp = 0;

    const nes = new NES({
      onFrame: (b) => {
        for (let i = 0; i < b.length && i < buf32.length; i++) buf32[i] = 0xff000000 | (b[i] & 0xffffff);
        ctx2.putImageData(img, 0, 0);
      },
      onAudioSample: (l, r) => {
        lb[wp] = l; rb[wp] = r;
        wp = (wp + 1) % RSIZE;
      },
      sampleRate: 44100,
    });

    let romOk = true;
    try {
      nes.loadROM(bufToBinary(romData));
      if (stateRef.current) nes.fromJSON(stateRef.current as never);
    } catch {
      romOk = false;
    }

    try {
      audio = new AudioContext();
      proc = audio.createScriptProcessor(2048, 0, 2);
      proc.onaudioprocess = (e) => {
        const L = e.outputBuffer.getChannelData(0);
        const R = e.outputBuffer.getChannelData(1);
        for (let i = 0; i < L.length; i++) {
          if (rp !== wp) { L[i] = lb[rp]; R[i] = rb[rp]; rp = (rp + 1) % RSIZE; }
          else { L[i] = 0; R[i] = 0; }
        }
      };
      proc.connect(audio.destination);
      void audio.resume().catch(() => undefined);
      const unlock = () => { void audio?.resume().catch(() => undefined); };
      window.addEventListener('pointerdown', unlock);
      (audio as unknown as { __unlock?: () => void }).__unlock = unlock;
    } catch {
      audio = null;
    }

    const api: NesApi = {
      snapshot: () => {
        try { return nes.toJSON(); } catch { return null; }
      },
      reload: (st) => {
        try {
          if (st) nes.fromJSON(st as never);
          else if (stateRef.current) nes.fromJSON(stateRef.current as never);
          else nes.reloadROM();
        } catch { /* noop */ }
      },
    };
    apiRef.current = api;
    onApi?.(api);
    registerCanvas?.(cv);

    let raf = 0;
    let last = performance.now();
    let acc = 0;
    const FRAME = 1000 / 60;
    const loop = (t: number) => {
      acc += Math.min(120, t - last);
      last = t;
      if (romOk) {
        let n = 0;
        while (acc >= FRAME && n < 3) { nes.frame(); acc -= FRAME; n++; }
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    const down = (e: KeyboardEvent) => {
      const b = KEYMAP[e.code];
      if (b !== undefined && enabledRef.current) {
        e.preventDefault();
        nes.buttonDown(0, b);
      }
    };
    const up = (e: KeyboardEvent) => {
      const b = KEYMAP[e.code];
      if (b !== undefined) nes.buttonUp(0, b);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      registerCanvas?.(null);
      try { proc?.disconnect(); } catch { /* noop */ }
      if (audio) void audio.close().catch(() => undefined);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [romData]);

  return (
    <div className="relative w-full aspect-[256/240] bg-black border-[3px] border-edge shadow-[0_0_40px_rgba(46,230,168,0.12)]">
      <canvas ref={canvasRef} width={256} height={240} className="w-full h-full block" style={{ imageRendering: 'pixelated' }} />
      {!enabled && (
        <div className="absolute inset-0 bg-[rgba(4,6,14,0.55)] flex flex-col items-center justify-center gap-2">
          <span className="font-pixel text-[9px] text-gold blink-hard">НАБЛЮДЕНИЕ</span>
          <span className="text-[11px] text-dim">Управление у активного игрока</span>
        </div>
      )}
      <div className="absolute bottom-1 right-2 font-pixel text-[7px] text-[rgba(233,236,255,0.4)]">JSNES CORE</div>
    </div>
  );
}
