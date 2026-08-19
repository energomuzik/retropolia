import { useEffect, useRef } from 'react';
import { NES } from 'jsnes';
import {
  ACTION_TO_BTN, GPAD_BUTTONS, GPAD_DEADZONE, PREFS_EVENT,
  loadEmuPrefs, type EmuPrefs, type PadAction,
} from './input';
import { useApp } from './store';

export interface NesApi {
  snapshot: () => unknown;
  reload: (state?: unknown) => void;
}

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
  const prefsRef = useRef<EmuPrefs>(loadEmuPrefs());

  useEffect(() => {
    const cv = canvasRef.current!;
    const ctx2 = cv.getContext('2d')!;
    const img = ctx2.createImageData(256, 240);
    const buf32 = new Uint32Array(img.data.buffer);

    const applyPrefs = () => {
      const p = prefsRef.current;
      cv.style.imageRendering = p.smoothing ? 'auto' : 'pixelated';
      ctx2.imageSmoothingEnabled = p.smoothing;
    };
    applyPrefs();
    const onPrefs = () => { prefsRef.current = loadEmuPrefs(); applyPrefs(); };
    window.addEventListener(PREFS_EVENT, onPrefs);

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
        const vol = useApp.getState().options.volume;
        const L = e.outputBuffer.getChannelData(0);
        const R = e.outputBuffer.getChannelData(1);
        for (let i = 0; i < L.length; i++) {
          if (rp !== wp) { L[i] = lb[rp] * vol; R[i] = rb[rp] * vol; rp = (rp + 1) % RSIZE; }
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
    onApi?.(api);
    registerCanvas?.(cv);

    /* ---------- клавиатура: раскладка из настроек, игрок №1 ---------- */
    const press = (action: PadAction, down: boolean) => {
      if (!enabledRef.current) return;
      try {
        if (down) nes.buttonDown(1, ACTION_TO_BTN[action]);
        else nes.buttonUp(1, ACTION_TO_BTN[action]);
      } catch { /* noop */ }
    };
    const down = (e: KeyboardEvent) => {
      const p = prefsRef.current;
      const action = (Object.keys(p.keys) as PadAction[]).find((a) => p.keys[a] === e.code);
      if (action && enabledRef.current) {
        e.preventDefault();
        press(action, true);
      }
    };
    const up = (e: KeyboardEvent) => {
      const p = prefsRef.current;
      const action = (Object.keys(p.keys) as PadAction[]).find((a) => p.keys[a] === e.code);
      if (action) press(action, false);
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);

    /* ---------- геймпады: pad 0 → игрок 1, pad 1 → игрок 2 ---------- */
    const padPrev: Map<number, { buttons: boolean[]; axes: number[] }> = new Map();
    const pollGamepads = () => {
      if (!prefsRef.current.gamepad) { padPrev.clear(); return; }
      let pads: (Gamepad | null)[] = [];
      try { pads = Array.from(navigator.getGamepads?.() ?? []); } catch { return; }
      pads.forEach((gp, gi) => {
        if (!gp || gi > 1) return;
        const player = gi + 1;
        const prev = padPrev.get(gi);
        const curBtn: boolean[] = [];
        // кнопки
        for (const [bi, action] of GPAD_BUTTONS) {
          const pressed = !!gp.buttons[bi]?.pressed;
          curBtn[bi] = pressed;
          const was = prev?.buttons[bi] ?? false;
          if (pressed && !was) {
            try { nes.buttonDown(player, ACTION_TO_BTN[action]); } catch { /* noop */ }
          } else if (!pressed && was) {
            try { nes.buttonUp(player, ACTION_TO_BTN[action]); } catch { /* noop */ }
          }
        }
        // левый стик
        const ax = gp.axes[0] ?? 0;
        const ay = gp.axes[1] ?? 0;
        const pax = prev?.axes[0] ?? 0;
        const pay = prev?.axes[1] ?? 0;
        const d = GPAD_DEADZONE;
        const dirs: [PadAction, number, number][] = [
          ['LEFT', ax, pax], ['RIGHT', ax, pax], ['UP', ay, pay], ['DOWN', ay, pay],
        ];
        const nowL = ax < -d, wasL = pax < -d;
        const nowR = ax > d, wasR = pax > d;
        const nowU = ay < -d, wasU = pay < -d;
        const nowD = ay > d, wasD = pay > d;
        void dirs;
        try {
          if (nowL && !wasL) nes.buttonDown(player, ACTION_TO_BTN.LEFT);
          if (!nowL && wasL) nes.buttonUp(player, ACTION_TO_BTN.LEFT);
          if (nowR && !wasR) nes.buttonDown(player, ACTION_TO_BTN.RIGHT);
          if (!nowR && wasR) nes.buttonUp(player, ACTION_TO_BTN.RIGHT);
          if (nowU && !wasU) nes.buttonDown(player, ACTION_TO_BTN.UP);
          if (!nowU && wasU) nes.buttonUp(player, ACTION_TO_BTN.UP);
          if (nowD && !wasD) nes.buttonDown(player, ACTION_TO_BTN.DOWN);
          if (!nowD && wasD) nes.buttonUp(player, ACTION_TO_BTN.DOWN);
        } catch { /* noop */ }
        padPrev.set(gi, {
          buttons: curBtn,
          axes: [ax, ay],
        });
      });
    };

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
      pollGamepads();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener(PREFS_EVENT, onPrefs);
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
