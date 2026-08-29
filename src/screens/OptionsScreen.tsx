import { useState } from 'react';
import { useApp } from '../store';
import { Field, GhostBtn, Ic, Modal, Panel, PxBtn, Toggle } from '../ui';
import { idbDel, idbAll, exportLibrary, importLibrary } from '../db';
import { STORES } from '../db';
import { sfx } from '../sound';
import { downloadHostBat } from '../host/hostPackage';

export default function OptionsScreen() {
  const { options, setOptions, setScreen, toast, refresh } = useApp();
  const [wipe, setWipe] = useState(false);

  // Экспорт всей библиотеки (карты, тайлы, ромы, сохранения, фишки) в один файл
  const doExport = async () => {
    try {
      const json = await exportLibrary();
      const blob = new Blob([json], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `retropolia-library-${new Date().toISOString().slice(0, 10)}.json`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(url), 4000);
      sfx.coin();
      toast('Библиотека выгружена в файл', 'ok');
    } catch {
      toast('Не удалось экспортировать библиотеку', 'err');
    }
  };

  // Импорт библиотеки из файла (слияние с текущей)
  const doImport = async (file: File) => {
    try {
      const text = await file.text();
      const n = await importLibrary(text);
      await refresh();
      sfx.success();
      toast(`Импортировано объектов: ${n}`, 'ok');
    } catch (e) {
      sfx.fail();
      toast(e instanceof Error ? e.message : 'Неверный файл библиотеки', 'err');
    }
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
              <p className="text-[11px] text-dim leading-relaxed">
                Имя видно в лобби, в журнале партии и в подписи трансляции.
              </p>
            </div>
          </Panel>

          <Panel title="Звук" icon={Ic.gear(16)} accent="var(--color-teal)" className="slide-up">
            <div className="p-4 space-y-4">
              <div>
                <span className="tick-label block mb-2">Эффекты интерфейса · {Math.round(options.volume * 100)}%</span>
                <input
                  type="range" min={0} max={1} step={0.05}
                  value={options.volume}
                  onChange={(e) => setOptions({ volume: Number(e.target.value) })}
                  onMouseUp={() => sfx.coin()}
                  className="w-full"
                />
              </div>
              <div className="border-t-2 border-edge pt-3 space-y-3">
                <Toggle
                  checked={options.emuSound}
                  onChange={(v) => setOptions({ emuSound: v })}
                  label="Звук эмуляторов"
                  hint="NES и SEGA — отдельно от эффектов интерфейса"
                />
                <div className={options.emuSound ? '' : 'opacity-40 pointer-events-none'}>
                  <span className="tick-label block mb-2">Громкость эмуляторов · {Math.round((options.emuVolume ?? 1) * 100)}%</span>
                  <input
                    type="range" min={0} max={1} step={0.05}
                    value={options.emuVolume ?? 1}
                    onChange={(e) => setOptions({ emuVolume: Number(e.target.value) })}
                    className="w-full"
                  />
                </div>
                <p className="text-[10px] text-faint leading-relaxed">
                  Громкость NES подхватывается на лету; у SEGA применяется при следующем запуске рома.
                </p>
              </div>
            </div>
          </Panel>

          <Panel title="Партия" icon={Ic.eye(16)} accent="var(--color-teal)" className="slide-up md:col-span-2">
            <div className="p-4 space-y-3">
              <Toggle
                checked={options.broadcast}
                onChange={(v) => setOptions({ broadcast: v })}
                label="Трансляция эмулятора"
                hint="Другие игроки видят экран активного игрока"
              />
              {options.broadcast && (
                <div className="flex items-center justify-between gap-4 pl-4 border-l-[3px] border-edge slide-up">
                  <div>
                    <span className="font-display text-[12px] uppercase text-paper">Кадров в секунду</span>
                    <div className="text-[10px] text-faint mt-0.5">Больше FPS — плавнее картинка у зрителей, больше трафик</div>
                  </div>
                  <div className="flex gap-1">
                    {[5, 10, 15, 20, 30].map((f) => (
                      <button
                        key={f}
                        onClick={() => { setOptions({ streamFps: f }); sfx.hover(); }}
                        className={`w-10 h-9 border-2 font-pixel text-[9px] transition-colors cursor-pointer ${
                          options.streamFps === f ? 'border-teal text-teal bg-teal/10' : 'border-edge text-dim hover:border-edge2 hover:text-paper'
                        }`}
                      >
                        {f}
                      </button>
                    ))}
                  </div>
                </div>
              )}
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

          <Panel title="Управление эмулятором" icon={Ic.chip(16)} accent="var(--color-magma)" className="slide-up md:col-span-2">
            <div className="p-4">
              <p className="text-[12px] text-dim leading-relaxed">
                Раскладка клавиш и геймпад настраиваются <span className="text-paper">рядом с эмулятором</span> —
                кнопка <span className="text-gold font-display uppercase">«Управление»</span> в «Запуске эмулятора»
                и во время выполнения задания (откроется встроенное меню настроек). Настройки сохраняются в браузере
                и действуют для NES и SEGA. Геймпады (PS5 / Xbox / PC) поддерживаются автоматически.
              </p>
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
              <div className="border-t-2 border-edge pt-3 mt-2">
                <Field label="Игровой хаб — приоритетный канал (если заполнен, PeerJS не используется)">
                  <input
                    className="field-in w-full px-3 py-2 font-display text-sm tracking-wide"
                    placeholder="https://xxxx-xxxx.trycloudflare.com"
                    value={options.relayHub}
                    onChange={(e) => setOptions({ relayHub: e.target.value.trim() })}
                  />
                </Field>
                <div className="flex items-center gap-2 mt-2 flex-wrap">
                  <PxBtn small color="sky" onClick={() => { downloadHostBat(); toast('retropolia-host.bat скачан — запустите его двойным кликом', 'ok'); }}>
                    {Ic.download(13)} Скачать сервер (стать хостом)
                  </PxBtn>
                </div>
                <p className="text-[11px] text-faint mt-2 leading-relaxed">
                  Самый простой способ: нажмите «Скачать сервер», запустите <span className="text-paper">retropolia-host.bat</span> — он сам
                  поставит туннель Cloudflare и <span className="text-paper">скопирует ссылку в буфер</span>. Вставьте её сюда (и передайте друзьям —
                  они вставят в это же поле). Хаб пересылает весь трафик через компьютер хоста — работает там, где облако PeerJS недоступно.
                </p>
                <div className="border-t-2 border-edge pt-3 mt-3">
                <Field label="Свой реле-сервер (если облако 0.peerjs.com недоступно)">
                  <input
                    className="field-in w-full px-3 py-2 font-display text-sm tracking-wide"
                    placeholder="пусто = облако PeerJS · имя.onrender.com · 192.168.1.10:9000"
                    value={options.relay}
                    onChange={(e) => setOptions({ relay: e.target.value.trim() })}
                  />
                </Field>
                <p className="text-[11px] text-faint mt-2 leading-relaxed">
                  Облако PeerJS иногда недоступно или перегружено. Поднимите свой сервер знакомств бесплатно на{' '}
                  <span className="text-sky font-display">Render</span> или <span className="text-sky font-display">Koyeb</span>{' '}
                  (пошагово — в <span className="text-paper">server/README.md</span>) и впишите сюда его имя вида{' '}
                  <span className="text-paper">moj-relay.onrender.com</span> — свой IP раздавать никому не надо.
                  Для игры в одной сети без интернета: <span className="text-sky font-display">npx peer --port 9000</span> → сюда{' '}
                  <span className="text-paper">IP:9000</span>.
                </p>
                </div>
              </div>
            </div>
          </Panel>

          <Panel title="Данные" icon={Ic.save(16)} accent="var(--color-teal)" className="slide-up md:col-span-2">
            <div className="p-4 space-y-4">
              <p className="text-[13px] text-dim max-w-2xl leading-relaxed">
                Тайлы, карты, ромы, сохранения и фишки хранятся <span className="text-paper">в IndexedDB этого браузера</span> — не на
                сервере. Данные привязаны к адресу сайта: при переезде на новый домен или на другой компьютер перенесите библиотеку файлом.
              </p>
              <div className="flex items-center gap-3 flex-wrap">
                <PxBtn color="teal" onClick={() => void doExport()}>{Ic.download(14)} Экспорт библиотеки</PxBtn>
                <label className="btn-px btn-sky pixel-corners px-4 py-2 text-xs inline-flex items-center gap-2 cursor-pointer">
                  {Ic.upload(14)} Импорт библиотеки
                  <input
                    type="file"
                    accept="application/json,.json"
                    className="hidden"
                    onChange={(e) => {
                      const f = e.target.files?.[0];
                      if (f) void doImport(f);
                      e.target.value = '';
                    }}
                  />
                </label>
                <span className="w-px h-6 bg-edge" />
                <PxBtn color="coral" onClick={() => setWipe(true)}>{Ic.trash(14)} Очистить библиотеку</PxBtn>
              </div>
              <p className="text-[11px] text-faint">
                Экспорт скачивает один JSON-файл со всей библиотекой (ромы включены). Импорт сливает файл с текущей библиотекой —
                удобно переносить карты с localhost на опубликованный сайт и между компьютерами.
              </p>
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
