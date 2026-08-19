import { useEffect, useState } from 'react';
import { useApp } from '../store';
import { Field, GhostBtn, Ic, Modal, Panel, PxBtn, Toggle } from '../ui';
import { idbDel, idbAll } from '../db';
import { STORES } from '../db';
import { sfx } from '../sound';
import {
  ACTION_LABELS, DEFAULT_KEYS, PAD_ACTIONS, PREFS_EVENT,
  keyLabel, listGamepads, loadEmuPrefs, saveEmuPrefs,
  type EmuPrefs, type PadAction,
} from '../input';

export default function OptionsScreen() {
  const { options, setOptions, setScreen, toast, refresh } = useApp();
  const [wipe, setWipe] = useState(false);
  const [prefs, setPrefs] = useState<EmuPrefs>(() => loadEmuPrefs());
  const [capturing, setCapturing] = useState<PadAction | null>(null);
  const [pads, setPads] = useState<Gamepad[]>([]);

  useEffect(() => {
    const bump = () => setPads(listGamepads());
    window.addEventListener('gamepadconnected', bump);
    window.addEventListener('gamepaddisconnected', bump);
    const t = setInterval(bump, 800);
    return () => { window.removeEventListener('gamepadconnected', bump); window.removeEventListener('gamepaddisconnected', bump); clearInterval(t); };
  }, []);

  useEffect(() => {
    if (!capturing) return;
    const grab = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      if (e.code === 'Escape') { setCapturing(null); return; }
      const base = loadEmuPrefs();
      const next: EmuPrefs = { ...base, keys: { ...base.keys, [capturing]: e.code } };
      setPrefs(next);
      saveEmuPrefs(next);
      setCapturing(null);
      sfx.coin();
    };
    window.addEventListener('keydown', grab, true);
    return () => window.removeEventListener('keydown', grab, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [capturing]);

  const updatePrefs = (p: Partial<EmuPrefs>) => {
    const next = { ...prefs, ...p };
    setPrefs(next);
    saveEmuPrefs(next);
  };

  const doWipe = async () => {
    for (const s of STORES) {
      const all = await idbAll(s);
      await Promise.all(all.map((e) => idbDel(s, e.key)));
    }
    await refresh();
    setWipe(false);
    sfx.fail();
    toast('Библиотека очищена', 'err');
  };

  return (
    <div className="h-full crt-grid-bg overflow-y-auto">
      <div className="max-w-3xl mx-auto px-6 py-8">
        <div className="flex items-center gap-4 mb-6">
          <GhostBtn onClick={() => setScreen('menu')}>{Ic.back(14)} Меню</GhostBtn>
          <h1 className="font-display text-2xl uppercase tracking-wider text-gold flex items-center gap-3">
            <span className="text-gold">{Ic.gear(22)}</span> Опции
          </h1>
        </div>

        <div className="grid md:grid-cols-2 gap-5">
          <Panel title="Игрок" icon={Ic.users(16)} className="slide-up">
            <div className="p-4 space-y-4">
              <Field label="Имя в комнате">
                <input
                  className="field-in w-full px-3 py-2 font-display uppercase text-sm tracking-wide"
                  maxLength={14}
                  value={options.name}
                  onChange={(e) => setOptions({ name: e.target.value.toUpperCase() })}
                />
              </Field>
              <div>
                <span className="tick-label block mb-2">Громкость эффектов · {Math.round(options.volume * 100)}%</span>
                <input
                  type="range" min={0} max={1} step={0.05}
                  value={options.volume}
                  onChange={(e) => setOptions({ volume: Number(e.target.value) })}
                  onMouseUp={() => sfx.coin()}
                  className="w-full"
                />
              </div>
            </div>
          </Panel>

          <Panel title="Эмулятор · клавиатура" icon={Ic.chip(16)} accent="var(--color-magma)" className="slide-up md:col-span-2">
            <div className="p-4">
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                {PAD_ACTIONS.map((a) => (
                  <div key={a} className="border-2 border-edge bg-[rgba(0,0,0,0.25)] px-2.5 py-2">
                    <div className="tick-label text-faint mb-1.5">{ACTION_LABELS[a]}</div>
                    <button
                      onClick={() => { setCapturing(a); sfx.hover(); }}
                      className={`w-full font-pixel text-[9px] px-2 py-1.5 border-2 transition-colors cursor-pointer ${capturing === a ? 'border-magma text-magma blink-hard bg-magma/10' : 'border-edge2 text-paper hover:border-gold hover:text-gold'}`}
                    >
                      {capturing === a ? 'НАЖМИТЕ…' : keyLabel(prefs.keys[a])}
                    </button>
                  </div>
                ))}
              </div>
              <div className="flex items-center justify-between gap-3 mt-4 flex-wrap">
                <p className="text-[11px] text-dim max-w-md">
                  Кликните кнопку и нажмите новую клавишу. Раскладка действует и в игре (задания NES), и в тестовом эмуляторе.
                </p>
                <div className="flex gap-2">
                  <Toggle checked={prefs.smoothing} onChange={(v) => updatePrefs({ smoothing: v })} label="Сглаживание картинки" />
                  <GhostBtn small onClick={() => { updatePrefs({ keys: { ...DEFAULT_KEYS } }); toast('Раскладка сброшена', 'info'); }}>
                    Сбросить
                  </GhostBtn>
                </div>
              </div>
            </div>
          </Panel>

          <Panel title={`Геймпад · подключено: ${pads.length}`} icon={Ic.dice(16)} accent="var(--color-sky)" className="slide-up md:col-span-2">
            <div className="p-4 space-y-3">
              <Toggle
                checked={prefs.gamepad}
                onChange={(v) => updatePrefs({ gamepad: v })}
                label="Поддержка геймпадов"
                hint="PS5 DualSense, Xbox и PC-джойстики со стандартной раскладкой"
              />
              {pads.length === 0 ? (
                <div className="border-[3px] border-dashed border-edge px-4 py-5 text-center">
                  <p className="text-[12px] text-dim">Геймпады не обнаружены.</p>
                  <p className="text-[11px] text-faint mt-1">Подключите джойстик и нажмите на нём любую кнопку — он появится здесь.</p>
                </div>
              ) : (
                <div className="grid sm:grid-cols-2 gap-2">
                  {pads.map((g) => (
                    <div key={g.index} className="border-2 border-sky/50 bg-sky/5 px-3 py-2.5">
                      <div className="font-display text-[11px] uppercase text-sky truncate">{g.id}</div>
                      <div className="tick-label text-faint mt-1">
                        Геймпад {g.index + 1} → игрок {g.index < 2 ? g.index + 1 : '—'} · кнопок {g.buttons.length}
                        {g.mapping === 'standard' ? ' · standard' : ' · нестандартная раскладка'}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-[10px] text-dim">
                <div className="hud-chip pixel-corners px-2 py-1.5">Крестовина / левый стик — движение</div>
                <div className="hud-chip pixel-corners px-2 py-1.5">✕/A и △/Y — кнопка A</div>
                <div className="hud-chip pixel-corners px-2 py-1.5">○/B и □/X — кнопка B</div>
                <div className="hud-chip pixel-corners px-2 py-1.5">Start (9) · Select/Back (8)</div>
              </div>
            </div>
          </Panel>

          <Panel title="Партия" icon={Ic.eye(16)} accent="var(--color-teal)" className="slide-up">
            <div className="p-4 space-y-3">
              <Toggle
                checked={options.broadcast}
                onChange={(v) => setOptions({ broadcast: v })}
                label="Трансляция эмулятора"
                hint="Другие игроки видят экран активного игрока"
              />
              <Toggle
                checked={options.autoReloadOnViolation}
                onChange={(v) => setOptions({ autoReloadOnViolation: v })}
                label="Авто-перезагрузка при нарушении"
                hint="Если все соперники нажали «Нарушил» — сохранение грузится само"
              />
              <Toggle
                checked={options.showCellNumbers}
                onChange={(v) => setOptions({ showCellNumbers: v })}
                label="Номера ячеек на поле"
                hint="Нумерация нужна карточкам-телепортам"
              />
            </div>
          </Panel>

          <Panel title="Как устроена связь" icon={Ic.globe(16)} accent="var(--color-sky)" className="slide-up md:col-span-2">
            <div className="p-4 text-[13px] text-dim leading-relaxed space-y-2">
              <p>
                <span className="text-sky font-display uppercase">Онлайн:</span> комнаты синхронизируются P2P через брокер PeerJS —
                код комнаты передаётся соперникам любым мессенджером. Хост партии — авторитетный узел: у всех должна быть
                одинаковая версия игры, иначе подключение будет отклонено.
              </p>
              <p>
                <span className="text-teal font-display uppercase">Локально:</span> параллельно работает tab-канал
                (BroadcastChannel) — откройте две вкладки браузера, чтобы мгновенно протестировать мультиплеер на одной машине.
              </p>
            </div>
          </Panel>

          <Panel title="Данные" icon={Ic.trash(16)} accent="var(--color-coral)" className="slide-up md:col-span-2">
            <div className="p-4 flex items-center justify-between gap-4 flex-wrap">
              <p className="text-[13px] text-dim max-w-md">
                Тайлы, карты, ромы и сохранения хранятся в IndexedDB этого браузера. Очистка удалит всю библиотеку безвозвратно.
              </p>
              <PxBtn color="coral" onClick={() => setWipe(true)}>{Ic.trash(14)} Очистить библиотеку</PxBtn>
            </div>
          </Panel>
        </div>
      </div>

      {wipe && (
        <Modal title="Очистить библиотеку?" icon={Ic.trash(16)} onClose={() => setWipe(false)} w="max-w-md">
          <p className="text-sm text-dim mb-5">Будут удалены все тайлы, карты, ромы, сохранения и сессии. Отменить действие нельзя.</p>
          <div className="flex gap-3 justify-end">
            <GhostBtn onClick={() => setWipe(false)}>Отмена</GhostBtn>
            <PxBtn color="coral" onClick={doWipe}>Стереть всё</PxBtn>
          </div>
        </Modal>
      )}
    </div>
  );
}
