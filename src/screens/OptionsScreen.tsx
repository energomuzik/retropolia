import { useState } from 'react';
import { useApp } from '../store';
import { Field, GhostBtn, Ic, Modal, Panel, PxBtn, Toggle } from '../ui';
import { idbDel, idbAll } from '../db';
import { STORES } from '../db';
import { sfx } from '../sound';

export default function OptionsScreen() {
  const { options, setOptions, setScreen, toast, refresh } = useApp();
  const [wipe, setWipe] = useState(false);

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
