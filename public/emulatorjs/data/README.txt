EmulatorJS 4.2.3 (stable) — файлы с официального CDN https://cdn.emulatorjs.org/stable/data/
Содержимое не менялось. Список:
  loader.js, emulator.min.js, emulator.min.css, version.json — загрузчик и ядро EmulatorJS
  cores/genesis_plus_gx-wasm.data — SEGA Mega Drive/Genesis (md, gen, bin) и Game Gear (gg)
  cores/smsplus-wasm.data          — SEGA Master System (sms)
  cores/fceumm-wasm.data           — NES (nes)
  cores/snes9x-wasm.data           — SNES / Super Nintendo (sfc, smc, fig)
  cores/gambatte-wasm.data         — Game Boy и Game Boy Color (gb, gbc)
  cores/mgba-wasm.data             — Game Boy Advance (gba)
  cores/picodrive-wasm.data        — SEGA 32X (32x)
  cores/stella2014-wasm.data       — Atari 2600 (a26)
  cores/mednafen_pce-wasm.data     — PC Engine / TurboGrafx-16 (pce; HuCard, без CD)
  cores/reports/*.json             — отчёты сборок ядер (для кэша браузера)
  compression/*                    — распаковка 7z/zip/rar (нужна для ядер .data)
  localization/ru.json             — русская локализация (копия ru-RU.json; официальный
                                     CDN отдаёт только ru-RU.json, а игра запрашивает ru)
Ядра отдаются с самого сайта (EmulatorJS: EJS_pathtodata = <адрес сайта>/emulatorjs/data/).
Интернет-CDN — только запасной источник при сбое (см. src/SegaBox.tsx, CORE_BASES).
