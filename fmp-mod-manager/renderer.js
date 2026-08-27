// renderer.js - electron renderer process
console.log("renderer script loaded."); // debug log: initial load confirmation

const consoleOutput = document.getElementById('console-output');
let currentSettings = {
    modFolderPath: '',
    pakFolderPath: '', // legacy, kept for backward compatibility
    language: 'english',
    platform: 'steam', // legacy, kept for backward compatibility
    deployTargets: [],
    trainerZipPath: '',
    spooferZipPath: '',
    gameLaunchPaths: { Steam: '', 'Epic Games': '', Microsoft: '' }
};
let currentDeployTargets = []; // kept in sync with the main process via renderDeployTargets()
let installedModsData = {}; // stores the data about installed mods from main process

// helper to strip supported mod archive extensions for display
const SUPPORTED_MOD_EXTENSIONS = ['.mmpackage', '.zip', '.7z', '.rar'];
function stripModExtension(filename) {
    const lower = filename.toLowerCase();
    for (const ext of SUPPORTED_MOD_EXTENSIONS) {
        if (lower.endsWith(ext)) return filename.slice(0, -ext.length);
    }
    return filename;
}
function isSupportedModFile(filename) {
    const lower = filename.toLowerCase();
    return SUPPORTED_MOD_EXTENSIONS.some(ext => lower.endsWith(ext));
}

// --- localization data ---
const translations = {
    english: {
        "home-dashboard-title": "dashboard",
        "home-greeting": "welcome back!",
        "dashboard-installed-mods-title": "installed mods",
        "dashboard-installed-mods-desc": "see and manage your installed mods",
        "dashboard-install-mods-title": "install mods",
        "dashboard-install-mods-desc": "browse and install new mods",
        "dashboard-settings-title": "settings",
        "dashboard-settings-desc": "configure paths and preferences",
        "dashboard-console-title": "console",
        "dashboard-console-desc": "view logs and errors",
        "dashboard-platform-title": "platform",
        "dashboard-update-status-title": "update status",
        "dashboard-version-title": "version",
        "developed-by": "developed by desgubernamentalizar",
        "mods-title": "mods",
        "drop-mmpackage-message": "drag & drop to install",
        "settings-title": "settings",
        "mod-folder-path-label": "mod folder path:",
        "pak-folder-path-label": "pak folder path:",
        "game-locations-label": "game install locations (mods are installed to ALL of these):",
        "language-label": "language:",
        "platform-label": "platform:",
        "console-title": "console output",
        "no-button": "no",
        "yes-button": "yes",
        "ok-button": "ok",
        "select-mods-title": "select mods to install",
        "close-button": "close",
        "select-language-title": "select language",
        "install-mods-button": "install mods",
        "browse-button": "browse",
        "uninstall-all-mods-button": "uninstall all mods",
        "look-for-updates-button": "look for updates",
        "installed-button": "installed",
        "uninstall-button": "uninstall",
        "installing-button": "installing...",
        "installing-message": "installing, please wait",
        "no-mods-installed": "no mods installed yet.",
        "export-log-button": "export log",
        "clear-log-button": "clear log",
        "copy-log-button": "copy all",
        "show-errors-button": "only errors",
        "show-warnings-button": "only warnings",
        "show-all-log-button": "show all",
        "mod-folder-not-set": "mod folder path is not set. cannot display available mods.",
        "pak-folder-not-set": "pak folder path is not set. cannot install/uninstall mods.",
        "confirm-action-title": "confirm action",
        "confirm-uninstall-all-mods-message": "are you sure you want to uninstall all non-base mods from your pak folder? this action cannot be undone.",
        "success-title": "success",
        "error-title": "error",
        "select-language-title": "select language",
        "conversor-title": "conversor",
        "mod-name-label": "mod name:",
        "all-files-label": "files (.pak, .sig, .ucas, .utoc):",
        "convert-button": "convert to .mmpackage",
        "conversion-success": "files successfully converted to \"{modName}.mmpackage\".",
        "conversion-error": "failed to convert files to .mmpackage: {error}",
        "invalid-files-selected": "please select one .pak, one .sig, one .ucas, and one .utoc file.",
        "mod-name-required": "please enter a name for the mod.",
        "mod-uninstalled-success": "mod \"{modName}\" was successfully uninstalled.",
        "latest-version-message": "you have the latest version!",
        "update-available": "update available!",
        "up-to-date": "up to date",
        "update-available-title": "update available!",
        "home-update-status-title": "update status:",
        "home-update-status-up": "your version is up to date",
        "home-update-status-out": "your version is outdated",
        "home-update-status-check-failed": "update check failed",
        "home-update-modal-title": "update required",
        "home-update-modal-message": "your version is outdated. please download the latest version from the website. the program will now close and open the website.",
        "home-update-modal-ok": "ok",
        "home-platform-title": "platform",
        "update-available": "update available!",
        "up-to-date": "up to date",
        "install-button": "install",
        "installed-button": "installed",
        "uninstall-button": "uninstall",
        "installing-button": "installing...",
        "installing-message": "installing, please wait",
        "drop-mmpackage-message": "drag & drop to install",
        "no-available-mods": "no available mods found.",
        "no-mods-installed": "no mods installed yet.",
        "mod-details-title": "mod details",
        "mod-details-body": "details will be shown here",
        "mod-details-close": "close",
        "mod-folder-not-set": "mod folder path is not set. cannot display available mods.",
        "warning-title": "warning",
        "nav-mods": "mods",
        "nav-downloads": "downloads",
        "nav-console": "console",
        "nav-settings": "settings",
        "trainer-button": "trainer",
        "spoofer-button": "spoofer",
        "launch-game-button": "launch game",
        "platform-steam": "steam",
        "platform-microsoft": "microsoft",
        "platform-epic": "epic games",
        "profile-select-placeholder": "— select a profile —",
        "load-profile-button": "load",
        "delete-profile-button": "delete",
        "new-profile-name-placeholder": "new profile name...",
        "save-profile-button": "save current as profile",
        "search-mods-placeholder": "search mods by name or author...",
        "sort-alphabetical": "alphabetical",
        "sort-recent": "recently added",
        "archived-mods-button": "archived mods",
        "downloads-title": "downloads",
        "downloads-subtitle": "real mod archives found in your downloads folder",
        "change-folder-button": "change folder",
        "rescan-button": "rescan",
        "no-downloads-message": "no mod archives found here — only zips/7z/rar/mmpackage files that actually contain pakchunk files show up.",
        "settings-section-general": "general",
        "nerd-mode-label": "nerd mode",
        "settings-section-game-locations": "game locations",
        "settings-section-game-locations-subtitle": "where mods get installed",
        "settings-section-game-launch-override": "game launch overrides",
        "settings-section-game-launch-override-subtitle": "only needed if \"launch game\" opens the wrong thing or fails",
        "no-deploy-targets-message": "no game install locations yet. click auto-detect, or add one manually.",
        "auto-detect-button": "auto-detect",
        "add-manually-button": "add manually",
        "game-launch-override-label": "game launch executables (override — only set these if \"launch game\" opens the wrong thing or fails)",
        "subrow-microsoft-label": "microsoft (xbox / game pass)",
        "game-launch-steam-placeholder": "default: launched via the Steam client (steam://rungameid/381210)",
        "game-launch-epic-placeholder": "default: auto-detected from the epic games install location above",
        "game-launch-microsoft-placeholder": "default: auto-detected from the microsoft install location above",
        "game-launch-epic-hint": "pick \"DeadByDaylight.exe\" in the root of the install folder — not the one inside DeadByDaylight\\Binaries\\Win64.",
        "game-launch-microsoft-hint": "pick \"gamelaunchhelper.exe\" directly inside the install's Content folder — the shipping exe won't launch on its own since this is a packaged Store app.",
        "settings-section-trainer-spoofer": "trainer & spoofer",
        "settings-section-trainer-spoofer-subtitle": "zip paths — re-extracted and launched fresh every time",
        "trainer-zip-path-label": "trainer zip path:",
        "trainer-zip-hint": "zip file containing the trainer .exe — it's re-extracted and launched fresh every time (the exe deletes itself after each run).",
        "spoofer-zip-path-label": "spoofer zip path:",
        "spoofer-zip-hint": "zip file containing the spoofer .exe — it's re-extracted and launched fresh every time (the exe deletes itself after each run).",
        "settings-section-appearance": "appearance",
        "settings-section-appearance-subtitle": "colors",
        "reset-theme-button": "reset to default",
        "color-accent": "accent",
        "color-hover": "hover",
        "color-background": "background",
        "color-sidebar": "sidebar",
        "color-text": "text",
        "color-mod-cards-on": "mod cards (on)",
        "color-mod-cards-off": "mod cards (off)",
        "color-borders": "borders",
        "color-title-bar": "title bar",
        "settings-section-layout": "layout",
        "settings-section-layout-subtitle": "font size, glow, mod numbers",
        "font-size-label": "font size",
        "font-size-small": "small",
        "font-size-medium": "medium",
        "font-size-large": "large",
        "text-glow-label": "text glow",
        "glow-intensity-label": "glow intensity",
        "glow-color-label": "glow color",
        "show-mod-numbers-label": "show mod numbers",
        "settings-section-danger-zone": "danger zone",
        "rename-modal-title": "rename mod",
        "rename-modal-hint": "display name only — the file on disk is unchanged.",
        "cancel-button": "cancel",
        "save-button": "save",
        "archived-modal-title": "archived mods",
        "archived-modal-hint": "these are hidden from install mods but still sitting in your mods folder. restore one to bring it back, or delete it permanently.",
        "no-archived-mods-message": "nothing archived yet.",
        "progress-modal-title": "progress",
        "variant-note": "these share the same pak slot, so only one can be active at a time — pick which ones you want available to toggle between, each becomes its own separate mod. edit the name field to rename before creating.",
        "variants-found-suffix": "variants found in this download",
        "create-selected-mods-button": "create selected as mods",
        "pakchunk-singular": "pakchunk",
        "pakchunk-plural": "pakchunks",
    },
    russian: {
        "home-dashboard-title": "панель приборов",
        "home-greeting": "с возвращением!",
        "dashboard-installed-mods-title": "установленные моды",
        "dashboard-installed-mods-desc": "просмотр и управление установленными модами",
        "dashboard-install-mods-title": "установить моды",
        "dashboard-install-mods-desc": "обзор и установка новых модов",
        "dashboard-settings-title": "настройки",
        "dashboard-settings-desc": "настройка путей и предпочтений",
        "dashboard-console-title": "консоль",
        "dashboard-console-desc": "просмотр логов и ошибок",
        "dashboard-platform-title": "платформа",
        "dashboard-update-status-title": "статус обновления",
        "dashboard-version-title": "версия",
        "developed-by": "разработано desgubernamentalizar",
        "mods-title": "моды",
        "drop-mmpackage-message": "перетащите, чтобы установить",
        "settings-title": "настройки",
        "mod-folder-path-label": "путь к папке с модами:",
        "pak-folder-path-label": "путь к папке pak:",
        "language-label": "язык:",
        "platform-label": "платформа:",
        "console-title": "вывод консоли",
        "no-button": "нет",
        "yes-button": "да",
        "ok-button": "ок",
        "select-mods-title": "выберите моды для установки",
        "close-button": "закрыть",
        "select-language-title": "выберите язык",
        "install-mods-button": "установить моды",
        "browse-button": "обзор",
        "uninstall-all-mods-button": "удалить все моды",
        "look-for-updates-button": "проверить обновления",
        "installed-button": "установлено",
        "uninstall-button": "удалить",
        "installing-button": "установка...",
        "installing-message": "идет установка, пожалуйста, подождите",
        "no-mods-installed": "моды еще не установлены.",
        "export-log-button": "экспортировать лог",
        "clear-log-button": "очистить лог",
        "copy-log-button": "копировать всё",
        "show-errors-button": "только ошибки",
        "show-warnings-button": "только предупреждения",
        "show-all-log-button": "показать всё",
        "mod-folder-not-set": "путь к папке с модами не указан. невозможно отобразить доступные моды.",
        "pak-folder-not-set": "путь к папке pak не указан. невозможно установить/удалить моды.",
        "confirm-action-title": "подтвердите действие",
        "confirm-uninstall-all-mods-message": "вы уверены, что хотите удалить все не базовые моды из вашей папки pak? это действие нельзя отменить.",
        "success-title": "успех",
        "error-title": "ошибка",
        "conversor-title": "конвертер",
        "mod-name-label": "имя мода:",
        "all-files-label": "файлы (.pak, .sig, .ucas, .utoc):",
        "convert-button": "конвертировать в .mmpackage",
        "conversion-success": "файлы успешно конвертированы в «{modName}.mmpackage».",
        "conversion-error": "не удалось конвертировать файлы в .mmpackage: {error}",
        "invalid-files-selected": "пожалуйста, выберите по одному файлу .pak, .sig, .ucas и .utoc.",
        "mod-name-required": "пожалуйста, введите имя для мода.",
        "mod-uninstalled-success": "мод «{modName}» был успешно удален.",
        "latest-version-message": "у вас последняя версия!",
        "update-available": "доступно обновление!",
        "up-to-date": "актуальная версия",
        "update-available-title": "доступно обновление!",
        "home-update-status-title": "статус обновления:",
        "home-update-status-up": "ваша версия актуальна",
        "home-update-status-out": "ваша версия устарела",
        "home-update-status-check-failed": "проверка обновления не удалась",
        "home-update-modal-title": "требуется обновление",
        "home-update-modal-message": "ваша версия устарела. пожалуйста, загрузите последнюю версию с веб-сайта. программа сейчас закроется и откроет веб-сайт.",
        "home-update-modal-ok": "ок",
        "home-platform-title": "платформа",
        "install-button": "установить",
        "no-available-mods": "доступные моды не найдены.",
        "mod-details-title": "детали мода",
        "mod-details-body": "детали будут показаны здесь",
        "mod-details-close": "закрыть",
        "warning-title": "предупреждение",
        "nav-mods": "моды",
        "nav-downloads": "загрузки",
        "nav-console": "консоль",
        "nav-settings": "настройки",
        "trainer-button": "трейнер",
        "spoofer-button": "спуфер",
        "launch-game-button": "запустить игру",
        "platform-steam": "steam",
        "platform-microsoft": "microsoft",
        "platform-epic": "epic games",
        "profile-select-placeholder": "— выберите профиль —",
        "load-profile-button": "загрузить",
        "delete-profile-button": "удалить",
        "new-profile-name-placeholder": "имя нового профиля...",
        "save-profile-button": "сохранить текущий как профиль",
        "search-mods-placeholder": "поиск модов по имени или автору...",
        "sort-alphabetical": "по алфавиту",
        "sort-recent": "недавно добавленные",
        "archived-mods-button": "архивные моды",
        "downloads-title": "загрузки",
        "downloads-subtitle": "реальные архивы модов, найденные в папке загрузок",
        "change-folder-button": "изменить папку",
        "rescan-button": "пересканировать",
        "no-downloads-message": "архивы модов не найдены — отображаются только zip/7z/rar/mmpackage файлы, содержащие файлы pakchunk.",
        "settings-section-general": "общие",
        "nerd-mode-label": "режим для продвинутых",
        "game-locations-label": "расположения игры (моды устанавливаются во ВСЕ из них):",
        "settings-section-game-locations": "расположения игры",
        "settings-section-game-locations-subtitle": "куда устанавливаются моды",
        "settings-section-game-launch-override": "переопределение запуска игры",
        "settings-section-game-launch-override-subtitle": "нужно только если \"запустить игру\" открывает не то или не работает",
        "no-deploy-targets-message": "расположения игры ещё не добавлены. нажмите автоопределение или добавьте вручную.",
        "auto-detect-button": "автоопределение",
        "add-manually-button": "добавить вручную",
        "game-launch-override-label": "исполняемые файлы запуска игры (переопределение — используйте только если \"запустить игру\" открывает не то или не работает)",
        "subrow-microsoft-label": "microsoft (xbox / game pass)",
        "game-launch-steam-placeholder": "по умолчанию: запуск через клиент Steam (steam://rungameid/381210)",
        "game-launch-epic-placeholder": "по умолчанию: определяется автоматически по расположению epic games выше",
        "game-launch-microsoft-placeholder": "по умолчанию: определяется автоматически по расположению microsoft выше",
        "game-launch-epic-hint": "выберите \"DeadByDaylight.exe\" в корне папки установки — не тот, что внутри DeadByDaylight\\Binaries\\Win64.",
        "game-launch-microsoft-hint": "выберите \"gamelaunchhelper.exe\" прямо внутри папки Content установки — исполняемый файл сборки не запустится сам по себе, так как это приложение из Store.",
        "settings-section-trainer-spoofer": "трейнер и спуфер",
        "settings-section-trainer-spoofer-subtitle": "пути к zip-архивам — извлекаются и запускаются заново каждый раз",
        "trainer-zip-path-label": "путь к zip трейнера:",
        "trainer-zip-hint": "zip-архив с exe-файлом трейнера — извлекается и запускается заново каждый раз (exe удаляет себя после каждого запуска).",
        "spoofer-zip-path-label": "путь к zip спуфера:",
        "spoofer-zip-hint": "zip-архив с exe-файлом спуфера — извлекается и запускается заново каждый раз (exe удаляет себя после каждого запуска).",
        "settings-section-appearance": "внешний вид",
        "settings-section-appearance-subtitle": "цвета",
        "reset-theme-button": "сбросить по умолчанию",
        "color-accent": "акцент",
        "color-hover": "наведение",
        "color-background": "фон",
        "color-sidebar": "боковая панель",
        "color-text": "текст",
        "color-mod-cards-on": "карточки модов (вкл)",
        "color-mod-cards-off": "карточки модов (выкл)",
        "color-borders": "границы",
        "color-title-bar": "панель заголовка",
        "settings-section-layout": "макет",
        "settings-section-layout-subtitle": "размер шрифта, свечение, номера модов",
        "font-size-label": "размер шрифта",
        "font-size-small": "маленький",
        "font-size-medium": "средний",
        "font-size-large": "большой",
        "text-glow-label": "свечение текста",
        "glow-intensity-label": "интенсивность свечения",
        "glow-color-label": "цвет свечения",
        "show-mod-numbers-label": "показывать номера модов",
        "settings-section-danger-zone": "опасная зона",
        "rename-modal-title": "переименовать мод",
        "rename-modal-hint": "только отображаемое имя — файл на диске не изменяется.",
        "cancel-button": "отмена",
        "save-button": "сохранить",
        "archived-modal-title": "архивные моды",
        "archived-modal-hint": "они скрыты из установки модов, но всё ещё находятся в папке модов. восстановите, чтобы вернуть, или удалите навсегда.",
        "no-archived-mods-message": "пока ничего не архивировано.",
        "progress-modal-title": "прогресс",
        "variant-note": "они используют один и тот же слот pak, поэтому активным может быть только один — выберите, какие варианты будут доступны для переключения, каждый станет отдельным модом. отредактируйте имя перед созданием.",
        "variants-found-suffix": "вариантов найдено в этой загрузке",
        "create-selected-mods-button": "создать выбранные как моды",
        "pakchunk-singular": "pakchunk",
        "pakchunk-plural": "pakchunk'ов"
    },
    german: {
        "home-dashboard-title": "Dashboard",
        "home-greeting": "willkommen zurück!",
        "dashboard-installed-mods-title": "installierte mods",
        "dashboard-installed-mods-desc": "deine installierten mods ansehen und verwalten",
        "dashboard-install-mods-title": "mods installieren",
        "dashboard-install-mods-desc": "neue mods durchsuchen und installieren",
        "dashboard-settings-title": "einstellungen",
        "dashboard-settings-desc": "pfade und präferenzen konfigurieren",
        "dashboard-console-title": "konsole",
        "dashboard-console-desc": "protokolle und fehler anzeigen",
        "dashboard-platform-title": "plattform",
        "dashboard-update-status-title": "update-status",
        "dashboard-version-title": "version",
        "developed-by": "entwickelt von desgubernamentalizar",
        "mods-title": "mods",
        "drop-mmpackage-message": "per drag & drop installieren",
        "settings-title": "einstellungen",
        "mod-folder-path-label": "mod-ordnerpfad:",
        "pak-folder-path-label": "pak-ordnerpfad:",
        "language-label": "sprache:",
        "platform-label": "plattform:",
        "console-title": "konsolenausgabe",
        "no-button": "nein",
        "yes-button": "ja",
        "ok-button": "ok",
        "select-mods-title": "mods zum installieren auswählen",
        "close-button": "schließen",
        "select-language-title": "sprache auswählen",
        "install-mods-button": "mods installieren",
        "browse-button": "durchsuchen",
        "uninstall-all-mods-button": "alle mods deinstallieren",
        "look-for-updates-button": "nach updates suchen",
        "installed-button": "installiert",
        "uninstall-button": "deinstallieren",
        "installing-button": "wird installiert...",
        "installing-message": "wird installiert, bitte warten",
        "no-mods-installed": "noch keine mods installiert.",
        "export-log-button": "protokoll exportieren",
        "clear-log-button": "protokoll löschen",
        "copy-log-button": "alles kopieren",
        "show-errors-button": "nur fehler",
        "show-warnings-button": "nur warnungen",
        "show-all-log-button": "alles anzeigen",
        "mod-folder-not-set": "mod-ordnerpfad ist nicht festgelegt. verfügbare mods können nicht angezeigt werden.",
        "pak-folder-not-set": "pak-ordnerpfad ist nicht festgelegt. mods können nicht installiert/deinstalliert werden.",
        "confirm-action-title": "aktion bestätigen",
        "confirm-uninstall-all-mods-message": "bist du sicher, dass du alle nicht-basis-mods aus deinem pak-ordner deinstallieren möchtest? diese aktion kann nicht rückgängig gemacht werden.",
        "success-title": "erfolg",
        "error-title": "fehler",
        "conversor-title": "konverter",
        "mod-name-label": "mod-name:",
        "all-files-label": "dateien (.pak, .sig, .ucas, .utoc):",
        "convert-button": "zu .mmpackage konvertieren",
        "conversion-success": "dateien erfolgreich zu „{modName}.mmpackage“ konvertiert.",
        "conversion-error": "fehler beim konvertieren der dateien zu .mmpackage: {error}",
        "invalid-files-selected": "bitte wähle eine .pak-, eine .sig-, eine .ucas- und eine .utoc-datei aus.",
        "mod-name-required": "bitte gib einen namen für den mod ein.",
        "mod-uninstalled-success": "mod „{modName}“ wurde erfolgreich deinstalliert.",
        "latest-version-message": "du hast die neueste version!",
        "update-available": "update verfügbar!",
        "up-to-date": "auf dem neuesten stand",
        "update-available-title": "update verfügbar!",
        "home-update-status-title": "update-status:",
        "home-update-status-up": "deine version ist auf dem neuesten stand",
        "home-update-status-out": "deine version ist veraltet",
        "home-update-status-check-failed": "update-prüfung fehlgeschlagen",
        "home-update-modal-title": "update erforderlich",
        "home-update-modal-message": "deine version ist veraltet. bitte lade die neueste version von der website herunter. das programm wird sich nun schließen und die website öffnen.",
        "home-update-modal-ok": "ok",
        "home-platform-title": "plattform",
        "install-button": "installieren",
        "no-available-mods": "keine verfügbaren mods gefunden.",
        "mod-details-title": "mod-details",
        "mod-details-body": "details werden hier angezeigt",
        "mod-details-close": "schließen",
        "warning-title": "warnung",
        "nav-mods": "mods",
        "nav-downloads": "downloads",
        "nav-console": "konsole",
        "nav-settings": "einstellungen",
        "trainer-button": "trainer",
        "spoofer-button": "spoofer",
        "launch-game-button": "spiel starten",
        "platform-steam": "steam",
        "platform-microsoft": "microsoft",
        "platform-epic": "epic games",
        "profile-select-placeholder": "— profil auswählen —",
        "load-profile-button": "laden",
        "delete-profile-button": "löschen",
        "new-profile-name-placeholder": "neuer profilname...",
        "save-profile-button": "aktuelles als profil speichern",
        "search-mods-placeholder": "mods nach name oder autor suchen...",
        "sort-alphabetical": "alphabetisch",
        "sort-recent": "kürzlich hinzugefügt",
        "archived-mods-button": "archivierte mods",
        "downloads-title": "downloads",
        "downloads-subtitle": "echte mod-archive im downloads-ordner gefunden",
        "change-folder-button": "ordner ändern",
        "rescan-button": "erneut scannen",
        "no-downloads-message": "keine mod-archive gefunden — es werden nur zip/7z/rar/mmpackage-dateien angezeigt, die tatsächlich pakchunk-dateien enthalten.",
        "settings-section-general": "allgemein",
        "nerd-mode-label": "nerd-modus",
        "game-locations-label": "spiel-installationsorte (mods werden auf ALLE davon installiert):",
        "settings-section-game-locations": "spielstandorte",
        "settings-section-game-locations-subtitle": "wohin mods installiert werden",
        "settings-section-game-launch-override": "spielstart-überschreibungen",
        "settings-section-game-launch-override-subtitle": "nur nötig, wenn \"spiel starten\" das falsche öffnet oder fehlschlägt",
        "no-deploy-targets-message": "noch keine spielstandorte. klicke auf automatisch erkennen oder füge manuell einen hinzu.",
        "auto-detect-button": "automatisch erkennen",
        "add-manually-button": "manuell hinzufügen",
        "game-launch-override-label": "spielstart-programme (überschreiben — nur festlegen, wenn \"spiel starten\" das falsche öffnet oder fehlschlägt)",
        "subrow-microsoft-label": "microsoft (xbox / game pass)",
        "game-launch-steam-placeholder": "standard: gestartet über den Steam-client (steam://rungameid/381210)",
        "game-launch-epic-placeholder": "standard: automatisch erkannt vom epic games-standort oben",
        "game-launch-microsoft-placeholder": "standard: automatisch erkannt vom microsoft-standort oben",
        "game-launch-epic-hint": "wähle \"DeadByDaylight.exe\" im stammverzeichnis des installationsordners — nicht die in DeadByDaylight\\Binaries\\Win64.",
        "game-launch-microsoft-hint": "wähle \"gamelaunchhelper.exe\" direkt im Content-ordner der installation — die shipping-exe startet nicht von selbst, da dies eine store-app ist.",
        "settings-section-trainer-spoofer": "trainer & spoofer",
        "settings-section-trainer-spoofer-subtitle": "zip-pfade — werden bei jedem start neu extrahiert",
        "trainer-zip-path-label": "trainer-zip-pfad:",
        "trainer-zip-hint": "zip-datei mit der trainer-exe — wird bei jedem start neu extrahiert und gestartet (die exe löscht sich nach jedem lauf selbst).",
        "spoofer-zip-path-label": "spoofer-zip-pfad:",
        "spoofer-zip-hint": "zip-datei mit der spoofer-exe — wird bei jedem start neu extrahiert und gestartet (die exe löscht sich nach jedem lauf selbst).",
        "settings-section-appearance": "erscheinungsbild",
        "settings-section-appearance-subtitle": "farben",
        "reset-theme-button": "auf standard zurücksetzen",
        "color-accent": "akzent",
        "color-hover": "hover",
        "color-background": "hintergrund",
        "color-sidebar": "seitenleiste",
        "color-text": "text",
        "color-mod-cards-on": "mod-karten (an)",
        "color-mod-cards-off": "mod-karten (aus)",
        "color-borders": "ränder",
        "color-title-bar": "titelleiste",
        "settings-section-layout": "layout",
        "settings-section-layout-subtitle": "schriftgröße, leuchteffekt, mod-nummern",
        "font-size-label": "schriftgröße",
        "font-size-small": "klein",
        "font-size-medium": "mittel",
        "font-size-large": "groß",
        "text-glow-label": "text-leuchteffekt",
        "glow-intensity-label": "leuchtintensität",
        "glow-color-label": "leuchtfarbe",
        "show-mod-numbers-label": "mod-nummern anzeigen",
        "settings-section-danger-zone": "gefahrenzone",
        "rename-modal-title": "mod umbenennen",
        "rename-modal-hint": "nur der anzeigename — die datei auf der festplatte bleibt unverändert.",
        "cancel-button": "abbrechen",
        "save-button": "speichern",
        "archived-modal-title": "archivierte mods",
        "archived-modal-hint": "diese sind bei \"mods installieren\" ausgeblendet, liegen aber noch im mods-ordner. stelle sie wieder her oder lösche sie endgültig.",
        "no-archived-mods-message": "noch nichts archiviert.",
        "progress-modal-title": "fortschritt",
        "variant-note": "diese teilen sich denselben pak-slot, daher kann nur einer gleichzeitig aktiv sein — wähle aus, welche zum umschalten verfügbar sein sollen, jede wird ein eigener mod. bearbeite das namensfeld vor dem erstellen.",
        "variants-found-suffix": "varianten in diesem download gefunden",
        "create-selected-mods-button": "ausgewählte als mods erstellen",
        "pakchunk-singular": "pakchunk",
        "pakchunk-plural": "pakchunks"
    },
    spanish: {
        "home-dashboard-title": "panel",
        "home-greeting": "¡bienvenido de vuelta!",
        "dashboard-installed-mods-title": "mods instalados",
        "dashboard-installed-mods-desc": "ver y gestionar tus mods instalados",
        "dashboard-install-mods-title": "instalar mods",
        "dashboard-install-mods-desc": "buscar e instalar nuevos mods",
        "dashboard-settings-title": "ajustes",
        "dashboard-settings-desc": "configurar rutas y preferencias",
        "dashboard-console-title": "consola",
        "dashboard-console-desc": "ver registros y errores",
        "dashboard-platform-title": "plataforma",
        "dashboard-update-status-title": "estado de la actualización",
        "dashboard-version-title": "versión",
        "developed-by": "desarrollado por desgubernamentalizar",
        "mods-title": "mods",
        "drop-mmpackage-message": "arrastra y suelta para instalar",
        "settings-title": "ajustes",
        "mod-folder-path-label": "ruta de la carpeta de mods:",
        "pak-folder-path-label": "ruta de la carpeta pak:",
        "language-label": "idioma:",
        "platform-label": "plataforma:",
        "console-title": "salida de la consola",
        "no-button": "no",
        "yes-button": "sí",
        "ok-button": "ok",
        "select-mods-title": "seleccionar mods para instalar",
        "close-button": "cerrar",
        "select-language-title": "seleccionar idioma",
        "install-mods-button": "instalar mods",
        "browse-button": "examinar",
        "uninstall-all-mods-button": "desinstalar todos los mods",
        "look-for-updates-button": "buscar actualizaciones",
        "installed-button": "instalado",
        "uninstall-button": "desinstalar",
        "installing-button": "instalando...",
        "installing-message": "instalando, por favor espera",
        "no-mods-installed": "aún no hay mods instalados.",
        "export-log-button": "exportar registro",
        "clear-log-button": "limpiar registro",
        "copy-log-button": "copiar todo",
        "show-errors-button": "solo errores",
        "show-warnings-button": "solo advertencias",
        "show-all-log-button": "mostrar todo",
        "mod-folder-not-set": "la ruta de la carpeta de mods no está configurada. no se pueden mostrar los mods disponibles.",
        "pak-folder-not-set": "la ruta de la carpeta pak no está configurada. no se pueden instalar/desinstalar mods.",
        "confirm-action-title": "confirmar acción",
        "confirm-uninstall-all-mods-message": "¿estás seguro de que quieres desinstalar todos los mods que no son de base de tu carpeta pak? esta acción no se puede deshacer.",
        "success-title": "éxito",
        "error-title": "error",
        "conversor-title": "conversor",
        "mod-name-label": "nombre del mod:",
        "all-files-label": "archivos (.pak, .sig, .ucas, .utoc):",
        "convert-button": "convertir a .mmpackage",
        "conversion-success": "archivos convertidos con éxito a \"{modName}.mmpackage\".",
        "conversion-error": "no se pudieron convertir los archivos a .mmpackage: {error}",
        "invalid-files-selected": "por favor, selecciona un archivo .pak, un .sig, un .ucas y un .utoc.",
        "mod-name-required": "por favor, introduce un nombre para el mod.",
        "mod-uninstalled-success": "el mod \"{modName}\" se ha desinstalado correctamente.",
        "latest-version-message": "¡tienes la última versión!",
        "update-available": "¡actualización disponible!",
        "up-to-date": "actualizado",
        "update-available-title": "¡actualización disponible!",
        "home-update-status-title": "estado de la actualización:",
        "home-update-status-up": "tu versión está actualizada",
        "home-update-status-out": "tu versión está desactualizada",
        "home-update-status-check-failed": "fallo en la comprobación de actualizaciones",
        "home-update-modal-title": "actualización requerida",
        "home-update-modal-message": "tu versión está desactualizada. por favor, descarga la última versión desde el sitio web. el programa se cerrará y abrirá el sitio web.",
        "home-update-modal-ok": "ok",
        "home-platform-title": "plataforma",
        "install-button": "instalar",
        "no-available-mods": "no se encontraron mods disponibles.",
        "mod-details-title": "detalles del mod",
        "mod-details-body": "los detalles se mostrarán aquí",
        "mod-details-close": "cerrar",
        "warning-title": "advertencia",
        "nav-mods": "mods",
        "nav-downloads": "descargas",
        "nav-console": "consola",
        "nav-settings": "ajustes",
        "trainer-button": "trainer",
        "spoofer-button": "spoofer",
        "launch-game-button": "iniciar juego",
        "platform-steam": "steam",
        "platform-microsoft": "microsoft",
        "platform-epic": "epic games",
        "profile-select-placeholder": "— seleccionar un perfil —",
        "load-profile-button": "cargar",
        "delete-profile-button": "eliminar",
        "new-profile-name-placeholder": "nombre del nuevo perfil...",
        "save-profile-button": "guardar actual como perfil",
        "search-mods-placeholder": "buscar mods por nombre o autor...",
        "sort-alphabetical": "alfabético",
        "sort-recent": "añadidos recientemente",
        "archived-mods-button": "mods archivados",
        "downloads-title": "descargas",
        "downloads-subtitle": "archivos de mods reales encontrados en tu carpeta de descargas",
        "change-folder-button": "cambiar carpeta",
        "rescan-button": "volver a escanear",
        "no-downloads-message": "no se encontraron archivos de mods aquí — solo se muestran archivos zip/7z/rar/mmpackage que realmente contienen archivos pakchunk.",
        "settings-section-general": "general",
        "nerd-mode-label": "modo avanzado",
        "game-locations-label": "ubicaciones de instalación del juego (los mods se instalan en TODAS estas):",
        "settings-section-game-locations": "ubicaciones del juego",
        "settings-section-game-locations-subtitle": "dónde se instalan los mods",
        "settings-section-game-launch-override": "anulaciones de lanzamiento del juego",
        "settings-section-game-launch-override-subtitle": "solo necesario si \"iniciar juego\" abre lo incorrecto o falla",
        "no-deploy-targets-message": "aún no hay ubicaciones del juego. haz clic en autodetectar o añade una manualmente.",
        "auto-detect-button": "autodetectar",
        "add-manually-button": "añadir manualmente",
        "game-launch-override-label": "ejecutables de lanzamiento del juego (anulación — solo configúralos si \"iniciar juego\" abre lo incorrecto o falla)",
        "subrow-microsoft-label": "microsoft (xbox / game pass)",
        "game-launch-steam-placeholder": "predeterminado: lanzado a través del cliente de Steam (steam://rungameid/381210)",
        "game-launch-epic-placeholder": "predeterminado: detectado automáticamente desde la ubicación de epic games de arriba",
        "game-launch-microsoft-placeholder": "predeterminado: detectado automáticamente desde la ubicación de microsoft de arriba",
        "game-launch-epic-hint": "elige \"DeadByDaylight.exe\" en la raíz de la carpeta de instalación — no el que está dentro de DeadByDaylight\\Binaries\\Win64.",
        "game-launch-microsoft-hint": "elige \"gamelaunchhelper.exe\" directamente dentro de la carpeta Content de la instalación — el ejecutable principal no se iniciará por sí solo porque es una app de la Store.",
        "settings-section-trainer-spoofer": "trainer y spoofer",
        "settings-section-trainer-spoofer-subtitle": "rutas zip — se extraen y lanzan de nuevo cada vez",
        "trainer-zip-path-label": "ruta del zip del trainer:",
        "trainer-zip-hint": "archivo zip que contiene el .exe del trainer — se extrae y lanza de nuevo cada vez (el exe se elimina a sí mismo después de cada ejecución).",
        "spoofer-zip-path-label": "ruta del zip del spoofer:",
        "spoofer-zip-hint": "archivo zip que contiene el .exe del spoofer — se extrae y lanza de nuevo cada vez (el exe se elimina a sí mismo después de cada ejecución).",
        "settings-section-appearance": "apariencia",
        "settings-section-appearance-subtitle": "colores",
        "reset-theme-button": "restablecer valores predeterminados",
        "color-accent": "acento",
        "color-hover": "resaltado",
        "color-background": "fondo",
        "color-sidebar": "barra lateral",
        "color-text": "texto",
        "color-mod-cards-on": "tarjetas de mods (activado)",
        "color-mod-cards-off": "tarjetas de mods (desactivado)",
        "color-borders": "bordes",
        "color-title-bar": "barra de título",
        "settings-section-layout": "diseño",
        "settings-section-layout-subtitle": "tamaño de fuente, brillo, números de mods",
        "font-size-label": "tamaño de fuente",
        "font-size-small": "pequeño",
        "font-size-medium": "mediano",
        "font-size-large": "grande",
        "text-glow-label": "brillo del texto",
        "glow-intensity-label": "intensidad del brillo",
        "glow-color-label": "color del brillo",
        "show-mod-numbers-label": "mostrar números de mods",
        "settings-section-danger-zone": "zona de peligro",
        "rename-modal-title": "renombrar mod",
        "rename-modal-hint": "solo el nombre mostrado — el archivo en disco no cambia.",
        "cancel-button": "cancelar",
        "save-button": "guardar",
        "archived-modal-title": "mods archivados",
        "archived-modal-hint": "estos están ocultos en instalar mods pero siguen en tu carpeta de mods. restaura uno para recuperarlo, o elimínalo permanentemente.",
        "no-archived-mods-message": "nada archivado todavía.",
        "progress-modal-title": "progreso",
        "variant-note": "estos comparten la misma ranura pak, así que solo uno puede estar activo a la vez — elige cuáles quieres tener disponibles para alternar, cada uno se convierte en su propio mod separado. edita el nombre antes de crear.",
        "variants-found-suffix": "variantes encontradas en esta descarga",
        "create-selected-mods-button": "crear seleccionados como mods",
        "pakchunk-singular": "pakchunk",
        "pakchunk-plural": "pakchunks"
    },
    chinese: {
        "home-dashboard-title": "仪表盘",
        "home-greeting": "欢迎回来！",
        "dashboard-installed-mods-title": "已安装的模组",
        "dashboard-installed-mods-desc": "查看和管理您已安装的模组",
        "dashboard-install-mods-title": "安装模组",
        "dashboard-install-mods-desc": "浏览并安装新模组",
        "dashboard-settings-title": "设置",
        "dashboard-settings-desc": "配置路径和偏好设置",
        "dashboard-console-title": "控制台",
        "dashboard-console-desc": "查看日志和错误",
        "dashboard-platform-title": "平台",
        "dashboard-update-status-title": "更新状态",
        "dashboard-version-title": "版本",
        "developed-by": "由 desgubernamentalizar 开发",
        "mods-title": "模组",
        "drop-mmpackage-message": "拖放以安装",
        "settings-title": "设置",
        "mod-folder-path-label": "模组文件夹路径：",
        "pak-folder-path-label": "pak 文件夹路径：",
        "language-label": "语言：",
        "platform-label": "平台：",
        "console-title": "控制台输出",
        "no-button": "否",
        "yes-button": "是",
        "ok-button": "确定",
        "select-mods-title": "选择要安装的模组",
        "close-button": "关闭",
        "select-language-title": "选择语言",
        "install-mods-button": "安装模组",
        "browse-button": "浏览",
        "uninstall-all-mods-button": "卸载所有模组",
        "look-for-updates-button": "检查更新",
        "installed-button": "已安装",
        "uninstall-button": "卸载",
        "installing-button": "正在安装...",
        "installing-message": "正在安装，请稍候",
        "no-mods-installed": "尚未安装任何模组。",
        "export-log-button": "导出日志",
        "clear-log-button": "清除日志",
        "copy-log-button": "全部复制",
        "show-errors-button": "仅错误",
        "show-warnings-button": "仅警告",
        "show-all-log-button": "显示全部",
        "mod-folder-not-set": "未设置模组文件夹路径。无法显示可用模组。",
        "pak-folder-not-set": "未设置 pak 文件夹路径。无法安装/卸载模组。",
        "confirm-action-title": "确认操作",
        "confirm-uninstall-all-mods-message": "您确定要从您的 pak 文件夹中卸载所有非基础模组吗？此操作无法撤销。",
        "success-title": "成功",
        "error-title": "错误",
        "conversor-title": "转换器",
        "mod-name-label": "模组名称：",
        "all-files-label": "文件 (.pak, .sig, .ucas, .utoc)：",
        "convert-button": "转换为 .mmpackage",
        "conversion-success": "文件已成功转换为“{modName}.mmpackage”。",
        "conversion-error": "无法将文件转换为 .mmpackage：{error}",
        "invalid-files-selected": "请选择一个 .pak、一个 .sig、一个 .ucas 和一个 .utoc 文件。",
        "mod-name-required": "请输入模组的名称。",
        "mod-uninstalled-success": "模组“{modName}”已成功卸载。",
        "latest-version-message": "您已拥有最新版本！",
        "update-available": "有可用更新！",
        "up-to-date": "最新版本",
        "update-available-title": "有可用更新！",
        "home-update-status-title": "更新状态：",
        "home-update-status-up": "您的版本是最新版本",
        "home-update-status-out": "您的版本已过时",
        "home-update-status-check-failed": "更新检查失败",
        "home-update-modal-title": "需要更新",
        "home-update-modal-message": "您的版本已过时。请从网站下载最新版本。程序现在将关闭并打开网站。",
        "home-update-modal-ok": "确定",
        "home-platform-title": "平台",
        "install-button": "安装",
        "no-available-mods": "未找到可用的模组。",
        "mod-details-title": "模组详情",
        "mod-details-body": "详情将在此处显示",
        "mod-details-close": "关闭",
        "warning-title": "警告",
        "nav-mods": "模组",
        "nav-downloads": "下载",
        "nav-console": "控制台",
        "nav-settings": "设置",
        "trainer-button": "修改器",
        "spoofer-button": "欺骗器",
        "launch-game-button": "启动游戏",
        "platform-steam": "steam",
        "platform-microsoft": "microsoft",
        "platform-epic": "epic games",
        "profile-select-placeholder": "— 选择一个配置文件 —",
        "load-profile-button": "加载",
        "delete-profile-button": "删除",
        "new-profile-name-placeholder": "新配置文件名称...",
        "save-profile-button": "将当前保存为配置文件",
        "search-mods-placeholder": "按名称或作者搜索模组...",
        "sort-alphabetical": "按字母顺序",
        "sort-recent": "最近添加",
        "archived-mods-button": "已归档的模组",
        "downloads-title": "下载",
        "downloads-subtitle": "在下载文件夹中找到的真实模组存档",
        "change-folder-button": "更改文件夹",
        "rescan-button": "重新扫描",
        "no-downloads-message": "此处未找到模组存档 — 只显示真正包含pakchunk文件的zip/7z/rar/mmpackage文件。",
        "settings-section-general": "常规",
        "nerd-mode-label": "高级模式",
        "game-locations-label": "游戏安装位置（模组将安装到所有这些位置）：",
        "settings-section-game-locations": "游戏位置",
        "settings-section-game-locations-subtitle": "模组安装到哪里",
        "settings-section-game-launch-override": "游戏启动覆盖设置",
        "settings-section-game-launch-override-subtitle": "仅当\"启动游戏\"打开错误内容或失败时才需要",
        "no-deploy-targets-message": "尚未添加游戏安装位置。点击自动检测，或手动添加一个。",
        "auto-detect-button": "自动检测",
        "add-manually-button": "手动添加",
        "game-launch-override-label": "游戏启动可执行文件（覆盖设置 — 仅当\"启动游戏\"打开错误内容或失败时才设置这些）",
        "subrow-microsoft-label": "microsoft (xbox / game pass)",
        "game-launch-steam-placeholder": "默认：通过Steam客户端启动 (steam://rungameid/381210)",
        "game-launch-epic-placeholder": "默认：从上方的epic games安装位置自动检测",
        "game-launch-microsoft-placeholder": "默认：从上方的microsoft安装位置自动检测",
        "game-launch-epic-hint": "选择安装文件夹根目录中的\"DeadByDaylight.exe\" — 不是DeadByDaylight\\Binaries\\Win64中的那个。",
        "game-launch-microsoft-hint": "选择安装的Content文件夹中直接的\"gamelaunchhelper.exe\" — 由于这是打包的商店应用，主执行文件无法自行启动。",
        "settings-section-trainer-spoofer": "修改器与欺骗器",
        "settings-section-trainer-spoofer-subtitle": "zip路径 — 每次都会重新解压并启动",
        "trainer-zip-path-label": "修改器zip路径：",
        "trainer-zip-hint": "包含修改器.exe的zip文件 — 每次都会重新解压并启动（exe在每次运行后会自我删除）。",
        "spoofer-zip-path-label": "欺骗器zip路径：",
        "spoofer-zip-hint": "包含欺骗器.exe的zip文件 — 每次都会重新解压并启动（exe在每次运行后会自我删除）。",
        "settings-section-appearance": "外观",
        "settings-section-appearance-subtitle": "颜色",
        "reset-theme-button": "重置为默认值",
        "color-accent": "强调色",
        "color-hover": "悬停色",
        "color-background": "背景",
        "color-sidebar": "侧边栏",
        "color-text": "文字",
        "color-mod-cards-on": "模组卡片（开启）",
        "color-mod-cards-off": "模组卡片（关闭）",
        "color-borders": "边框",
        "color-title-bar": "标题栏",
        "settings-section-layout": "布局",
        "settings-section-layout-subtitle": "字体大小、发光效果、模组编号",
        "font-size-label": "字体大小",
        "font-size-small": "小",
        "font-size-medium": "中",
        "font-size-large": "大",
        "text-glow-label": "文字发光",
        "glow-intensity-label": "发光强度",
        "glow-color-label": "发光颜色",
        "show-mod-numbers-label": "显示模组编号",
        "settings-section-danger-zone": "危险区域",
        "rename-modal-title": "重命名模组",
        "rename-modal-hint": "仅显示名称 — 磁盘上的文件不会更改。",
        "cancel-button": "取消",
        "save-button": "保存",
        "archived-modal-title": "已归档的模组",
        "archived-modal-hint": "这些在安装模组中被隐藏，但仍保留在您的模组文件夹中。恢复可将其取回，或永久删除。",
        "no-archived-mods-message": "尚未归档任何内容。",
        "progress-modal-title": "进度",
        "variant-note": "这些共享同一个pak插槽，因此一次只能激活一个 — 选择您想要保留以便切换的变体，每个都会成为独立的模组。创建前请编辑名称字段以重命名。",
        "variants-found-suffix": "在此下载中找到变体",
        "create-selected-mods-button": "将所选内容创建为模组",
        "pakchunk-singular": "pakchunk",
        "pakchunk-plural": "个pakchunk"
    }
};


/**
 * applies translations to the ui elements.
 * @param {string} langkey - the key for the selected language (e.g., 'english').
 */
// --- update status persistence ---

function applyTranslations(langKey) {
    const lang = langKey ? langKey.toLowerCase() : 'english';
    const currentLang = translations[lang] || translations.english;
    document.querySelectorAll('[data-translate]').forEach(element => {
        const key = element.getAttribute('data-translate');
        if (currentLang[key]) {
            element.textContent = currentLang[key];
        } else if (translations.english[key]) {
            // fallback to english if missing in currentLang
            element.textContent = translations.english[key];
        }
    });
    // Also update placeholders for inputs/selects
    document.querySelectorAll('[data-translate-placeholder]').forEach(element => {
        const key = element.getAttribute('data-translate-placeholder');
        if (currentLang[key]) {
            element.placeholder = currentLang[key];
        } else if (translations.english[key]) {
            element.placeholder = translations.english[key];
        }
    });

    // handle elements with combined icons and text
    const setHtml = (selector, key) => {
        const element = document.querySelector(selector);
        if (element) {
            const translationText = currentLang[key] || translations.english[key] || `missing: ${key}`;
            // Fixed regex: match <i class="..."></i>
            const iconMatch = element.innerHTML.match(/<i class="[^"]+"><\/i>/);
            element.innerHTML = iconMatch ? `${iconMatch[0]} ${translationText}` : translationText;
        }
    };
    // --- END regex fix ---
    setHtml('#install-mods-button', 'install-mods-button');
    setHtml('#select-mod-folder', 'browse-button');
    setHtml('#uninstall-all-mods-button', 'uninstall-all-mods-button');
    setHtml('#export-log-button', 'export-log-button');
    setHtml('#clear-log-button', 'clear-log-button');
    setHtml('#copy-log-button', 'copy-log-button');
    setHtml('#show-errors-button', 'show-errors-button');
    setHtml('#show-warnings-button', 'show-warnings-button');
    setHtml('#show-all-log-button', 'show-all-log-button');

    document.querySelectorAll('.mod-toggle-button').forEach(button => {
        const currentText = button.textContent.toLowerCase();
        if (currentText.includes('install')) button.textContent = currentLang['install-button'] || translations.english['install-button'];
        else if (currentText.includes('installed')) button.textContent = currentLang['installed-button'] || translations.english['installed-button'];
        else if (currentText.includes('uninstall')) button.textContent = currentLang['uninstall-button'] || translations.english['uninstall-button'];
    });

    // drop message
    const dropMsg = document.getElementById('mods-drop-message');
    if (dropMsg) {
        const icon = dropMsg.querySelector('i');
        dropMsg.innerHTML = '';
        if (icon) dropMsg.appendChild(icon);
        const span = document.createElement('span');
        span.textContent = currentLang['drop-mmpackage-message'] || translations.english['drop-mmpackage-message'];
        dropMsg.appendChild(span);
    }
    // Modal buttons (ok, yes, no, close)
    const okBtns = document.querySelectorAll('[data-translate="ok-button"]');
    okBtns.forEach(btn => btn.textContent = currentLang['ok-button'] || translations.english['ok-button']);
    const yesBtns = document.querySelectorAll('[data-translate="yes-button"]');
    yesBtns.forEach(btn => btn.textContent = currentLang['yes-button'] || translations.english['yes-button']);
    const noBtns = document.querySelectorAll('[data-translate="no-button"]');
    noBtns.forEach(btn => btn.textContent = currentLang['no-button'] || translations.english['no-button']);
    const closeBtns = document.querySelectorAll('[data-translate="close-button"]');
    closeBtns.forEach(btn => btn.textContent = currentLang['close-button'] || translations.english['close-button']);
}


// --- utility functions ---

function log(message, type = 'info') {
    const entry = document.createElement('div');
    entry.classList.add('console-log-entry', type);
    entry.textContent = `${new Date().toLocaleTimeString()} [${type.toUpperCase()}]: ${message}`;
    consoleOutput?.appendChild(entry);
    if (consoleOutput) {
        consoleOutput.scrollTop = consoleOutput.scrollHeight;
    }
}

function showConfirmationModal(title, message) {
    return new Promise(resolve => {
        const modal = document.getElementById('confirmation-modal');
        document.getElementById('confirmation-modal-title').textContent = title;
        document.getElementById('confirmation-modal-message').textContent = message;
        const confirmBtn = document.getElementById('confirmation-modal-confirm');
        const cancelBtn = document.getElementById('confirmation-modal-cancel');

        const onConfirm = () => {
            hideModal('confirmation-modal');
            resolve(true);
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
        };
        const onCancel = () => {
            hideModal('confirmation-modal');
            resolve(false);
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
        };

        confirmBtn.addEventListener('click', onConfirm, { once: true });
        cancelBtn.addEventListener('click', onCancel, { once: true });

        modal.classList.remove('hidden');
    });
}

// Electron does not implement window.prompt() (unlike alert/confirm, which
// it does support) — it just returns null immediately with no UI. This is
// a real text-input modal to use instead, anywhere a rename/text prompt
// is needed.
function showRenameModal(currentValue) {
    return new Promise(resolve => {
        const modal = document.getElementById('rename-modal');
        const input = document.getElementById('rename-modal-input');
        const confirmBtn = document.getElementById('rename-modal-confirm');
        const cancelBtn = document.getElementById('rename-modal-cancel');
        input.value = currentValue || '';

        const cleanup = () => {
            confirmBtn.removeEventListener('click', onConfirm);
            cancelBtn.removeEventListener('click', onCancel);
            input.removeEventListener('keydown', onKeydown);
        };
        const onConfirm = () => {
            hideModal('rename-modal');
            cleanup();
            resolve(input.value);
        };
        const onCancel = () => {
            hideModal('rename-modal');
            cleanup();
            resolve(null);
        };
        const onKeydown = (e) => {
            if (e.key === 'Enter') onConfirm();
            else if (e.key === 'Escape') onCancel();
        };

        confirmBtn.addEventListener('click', onConfirm, { once: true });
        cancelBtn.addEventListener('click', onCancel, { once: true });
        input.addEventListener('keydown', onKeydown);

        modal.classList.remove('hidden');
        input.focus();
        input.select();
    });
}

function showMessageModal(title, message) {
    const modal = document.getElementById('message-modal');
    document.getElementById('message-modal-title').textContent = title;
    document.getElementById('message-modal-message').textContent = message;
    modal.classList.remove('hidden');
}

function hideModal(modalId) {
    document.getElementById(modalId)?.classList.add('hidden');
}

// --- tab management ---

function activateTab(tabId) {
    document.querySelectorAll('.tab-content').forEach(tab => {
        tab.classList.remove('active');
    });
    const activeTab = document.getElementById(tabId);
    if (activeTab) {
        activeTab.classList.add('active');
    }

    document.querySelectorAll('.tab-button').forEach(button => {
        button.classList.remove('active');
    });
    document.querySelector(`.tab-button[data-tab="${tabId.replace('-tab', '')}"]`)?.classList.add('active');

    log(`switched to tab: ${tabId}`, 'user');

    if (tabId === 'mods-tab') {
        renderInstalledMods();
    }
    if (tabId === 'downloads-tab') {
        renderDownloadsTab();
    }
    applyTranslations(currentSettings.language);
}

// --- settings management ---
function setNerdMode(enabled) {
    currentSettings.nerdMode = enabled;

    const consoleBtn = document.querySelector('.tab-button[data-tab="console"]');
    const consoleTab = document.getElementById('console-tab');
    if (consoleBtn) consoleBtn.style.display = enabled ? '' : 'none';

    // safety net: if nerd mode just got turned off while the console tab
    // happens to be active, bounce back to mods so nothing orphaned stays visible
    if (!enabled && consoleTab && consoleTab.classList.contains('active')) {
        activateTab('mods-tab');
    }

    const nerdToggle = document.getElementById('nerd-mode-toggle');
    if (nerdToggle) nerdToggle.checked = enabled;
}
// --- appearance / theme customization ---
const DEFAULT_THEME = {
    background: '#121212',
    sidebar: '#1e1e1e',
    modCardOn: '#2d2440',
    modCardOff: '#1e1e1e',
    text: '#e0e0e0',
    accent: '#bb86fc',
    hover: '#a252f8',
    border: '#2c2c2c',
    titleBar: '#1e1e1e',
};
const THEME_KEY_TO_CSS_VAR = {
    background: '--bg-color-dark',
    sidebar: '--sidebar-color',
    modCardOn: '--mod-card-on-color',
    modCardOff: '--mod-card-off-color',
    text: '--primary-text-dark',
    accent: '--accent-color',
    hover: '--accent-hover',
    border: '--border-color-dark',
    titleBar: '--title-bar-color',
};

// Picks readable text colors for whatever background color the user chooses —
// so an arbitrary "mod cards" color never ends up with barely-legible text.
// Computes real WCAG relative luminance and picks whichever of black/white
// text actually gives the higher contrast ratio against that background,
// rather than a rough brightness threshold (which gets mid-tones wrong).
function getContrastTextColors(hexColor) {
    let hex = (hexColor || '#1e1e1e').replace('#', '');
    if (hex.length === 3) hex = hex.split('').map(c => c + c).join('');
    const r = (parseInt(hex.substr(0, 2), 16) || 0) / 255;
    const g = (parseInt(hex.substr(2, 2), 16) || 0) / 255;
    const b = (parseInt(hex.substr(4, 2), 16) || 0) / 255;
    const toLinear = c => (c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
    const luminance = 0.2126 * toLinear(r) + 0.7152 * toLinear(g) + 0.0722 * toLinear(b);
    const contrastWithBlack = (luminance + 0.05) / 0.05;
    const contrastWithWhite = 1.05 / (luminance + 0.05);
    // secondary values are calibrated against the worst-case background (the
    // luminance where black/white text contrast is roughly tied, ~#757575) —
    // #d7d7d7 / #272727 are the tightest values that still clear 3.2:1 there,
    // so muted "secondary" text stays legible no matter what color is picked.
    return contrastWithWhite > contrastWithBlack
        ? { main: '#f5f5f5', secondary: '#d7d7d7' }
        : { main: '#141414', secondary: '#272727' };
}

function applyTheme(theme) {
    let incoming = theme || {};
    // migrate a legacy single "modCard" value (from before on/off colors were
    // split out) into the off-state color, so existing users' saved theme
    // isn't silently discarded
    if (incoming.modCard && !incoming.modCardOn && !incoming.modCardOff) {
        incoming = { ...incoming, modCardOff: incoming.modCard };
    }
    const merged = { ...DEFAULT_THEME, ...incoming };

    for (const [key, cssVar] of Object.entries(THEME_KEY_TO_CSS_VAR)) {
        document.documentElement.style.setProperty(cssVar, merged[key]);
    }

    // each mod-card state gets its own background, so each needs its own
    // independently computed contrast-safe text — a color picked to read
    // well on the "on" background might not read well on "off" at all.
    const onContrast = getContrastTextColors(merged.modCardOn);
    const offContrast = getContrastTextColors(merged.modCardOff);
    document.documentElement.style.setProperty('--mod-card-on-text-color', onContrast.main);
    document.documentElement.style.setProperty('--mod-card-on-text-secondary', onContrast.secondary);
    document.documentElement.style.setProperty('--mod-card-off-text-color', offContrast.main);
    document.documentElement.style.setProperty('--mod-card-off-text-secondary', offContrast.secondary);
    // legacy aliases (= off state) for UI that doesn't have an on/off concept
    // at all — Downloads cards, the archived-mods list, the variant picker
    document.documentElement.style.setProperty('--mod-card-color', merged.modCardOff);
    document.documentElement.style.setProperty('--mod-card-text-color', offContrast.main);
    document.documentElement.style.setProperty('--mod-card-text-secondary', offContrast.secondary);

    // toggle switch knob: when ON, the track is the accent color — if the
    // user picks a light/near-white accent, a hardcoded white knob would
    // wash out against it. Pick whichever of black/white actually
    // contrasts against the current accent color instead.
    const knobOnContrast = getContrastTextColors(merged.accent);
    document.documentElement.style.setProperty('--toggle-knob-on-color', knobOnContrast.main);

    // sync the color pickers to match
    document.querySelectorAll('.color-swatch-row input[type="color"]').forEach(input => {
        const key = input.dataset.themeKey;
        if (key && merged[key]) input.value = merged[key];
    });
    return merged;
}

// --- layout editor: font size, text glow, mod numbers visibility ---
const DEFAULT_LAYOUT = { fontSize: 16, textGlow: false, glowIntensity: 45, glowColor: '#bb86fc', showModNumbers: true };
const FONT_SIZE_MIN = 12;
const FONT_SIZE_MAX = 22;

// fontSize used to be a 'small'/'medium'/'large' preset (3 fixed sizes) —
// now it's a continuous px value from the slider. Old saved settings still
// have the string form, so map those to the equivalent px on load.
function normalizeFontSize(value) {
    if (typeof value === 'number' && isFinite(value)) {
        return Math.max(FONT_SIZE_MIN, Math.min(FONT_SIZE_MAX, value));
    }
    if (value === 'small') return 14;
    if (value === 'large') return 18;
    return 16; // 'medium' or anything unrecognized
}

function applyLayoutSettings(layout) {
    const merged = { ...DEFAULT_LAYOUT, ...(layout || {}) };
    merged.fontSize = normalizeFontSize(merged.fontSize);

    document.documentElement.style.fontSize = `${merged.fontSize}px`;
    const fontSizeSlider = document.getElementById('font-size-slider');
    const fontSizeValue = document.getElementById('font-size-value');
    if (fontSizeSlider) fontSizeSlider.value = merged.fontSize;
    if (fontSizeValue) fontSizeValue.textContent = `${merged.fontSize}px`;

    document.body.classList.toggle('text-glow-on', !!merged.textGlow);
    const glowToggle = document.getElementById('text-glow-toggle');
    if (glowToggle) glowToggle.checked = !!merged.textGlow;

    // glow size scales from 0px (intensity 0) to 24px (intensity 100)
    const glowSizePx = (Math.max(0, Math.min(100, merged.glowIntensity)) / 100) * 24;
    document.documentElement.style.setProperty('--glow-size', `${glowSizePx}px`);
    document.documentElement.style.setProperty('--glow-color', merged.glowColor);

    const intensitySlider = document.getElementById('glow-intensity-slider');
    const intensityValue = document.getElementById('glow-intensity-value');
    if (intensitySlider) intensitySlider.value = merged.glowIntensity;
    if (intensityValue) intensityValue.textContent = `${merged.glowIntensity}%`;

    const colorPicker = document.getElementById('glow-color-picker');
    if (colorPicker) colorPicker.value = merged.glowColor;

    // the intensity/color controls only make sense (and only show) once glow is on
    const intensityRow = document.getElementById('glow-intensity-row');
    const colorRow = document.getElementById('glow-color-row');
    if (intensityRow) intensityRow.style.display = merged.textGlow ? 'flex' : 'none';
    if (colorRow) colorRow.style.display = merged.textGlow ? 'flex' : 'none';

    document.body.classList.toggle('hide-mod-numbers', !merged.showModNumbers);
    const numbersToggle = document.getElementById('show-mod-numbers-toggle');
    if (numbersToggle) numbersToggle.checked = merged.showModNumbers !== false;

    return merged;
}

async function loadSettings() {
    log('loading settings...', 'system');
    currentSettings = await window.electronAPI.loadSettings();
    document.getElementById('mod-folder-path').value = currentSettings.modFolderPath || '';
    document.getElementById('trainer-zip-path').value = currentSettings.trainerZipPath || '';
    document.getElementById('spoofer-zip-path').value = currentSettings.spooferZipPath || '';
    const gameLaunchPaths = currentSettings.gameLaunchPaths || {};
    document.getElementById('game-launch-path-steam').value = gameLaunchPaths['Steam'] || '';
    document.getElementById('game-launch-path-epic-games').value = gameLaunchPaths['Epic Games'] || '';
    document.getElementById('game-launch-path-microsoft').value = gameLaunchPaths['Microsoft'] || '';
    updateLanguageDisplay(currentSettings.language || 'english');
    setNerdMode(currentSettings.nerdMode !== false); // default nerdMode true
    applyTranslations(currentSettings.language);
    applyTheme(currentSettings.theme);
    applyLayoutSettings(currentSettings.layout);
    await renderDeployTargets();
    await renderModProfiles();
    log('settings loaded and ui updated.', 'system');
    // Setup nerd mode toggle
    const nerdToggle = document.getElementById('nerd-mode-toggle');
    if (nerdToggle) {
        nerdToggle.checked = currentSettings.nerdMode !== false;
        nerdToggle.onchange = async (e) => {
            setNerdMode(e.target.checked);
            currentSettings.nerdMode = e.target.checked;
            await saveSettings();
        };
    }
}

// --- game install locations (multi-platform deploy targets) ---
async function renderDeployTargets() {
    currentDeployTargets = await window.electronAPI.getDeployTargets();
    const list = document.getElementById('deploy-targets-list');
    const emptyMsg = document.getElementById('no-deploy-targets-message');
    if (!list) return;
    list.innerHTML = '';

    if (!currentDeployTargets || currentDeployTargets.length === 0) {
        if (emptyMsg) emptyMsg.style.display = 'block';
        return;
    }
    if (emptyMsg) emptyMsg.style.display = 'none';

    currentDeployTargets.forEach(target => {
        const item = document.createElement('div');
        item.classList.add('deploy-target-item');
        item.innerHTML = `
            <div style="min-width:0;">
                <span class="deploy-target-platform">${target.platform}</span>
                <span class="deploy-target-path">${target.pakFolderPath}</span>
            </div>
            <button class="deploy-target-remove" data-target-id="${target.id}" title="remove"><i class="fas fa-times"></i></button>
        `;
        list.appendChild(item);
    });
}

// --- mod profiles (named sets of enabled mods) ---
async function renderModProfiles() {
    const select = document.getElementById('mod-profile-select');
    if (!select || !window.electronAPI.listModProfiles) return;
    const profiles = await window.electronAPI.listModProfiles();
    const previousValue = select.value;
    const lang = translations[currentSettings.language.toLowerCase()] || translations.english;
    const placeholder = lang['profile-select-placeholder'] || translations.english['profile-select-placeholder'];
    select.innerHTML = `<option value="" data-translate="profile-select-placeholder">${placeholder}</option>` +
        profiles.map(p => `<option value="${p.name}">${p.name}</option>`).join('');
    if (profiles.some(p => p.name === previousValue)) select.value = previousValue;
}

async function saveSettings() {
    log('saving settings...', 'system');
    const settingsToSave = {
        modFolderPath: document.getElementById('mod-folder-path').value,
        trainerZipPath: document.getElementById('trainer-zip-path').value,
        spooferZipPath: document.getElementById('spoofer-zip-path').value,
        gameLaunchPaths: {
            'Steam': document.getElementById('game-launch-path-steam').value,
            'Epic Games': document.getElementById('game-launch-path-epic-games').value,
            'Microsoft': document.getElementById('game-launch-path-microsoft').value
        },
        language: document.getElementById('current-language-text').textContent,
        nerdMode: currentSettings.nerdMode !== false, // default true if undefined
        theme: currentSettings.theme || DEFAULT_THEME,
        layout: currentSettings.layout || DEFAULT_LAYOUT
    };
    const result = await window.electronAPI.saveSettings(settingsToSave);
    if (result.success) {
        currentSettings = { ...currentSettings, ...settingsToSave };
        log('settings saved successfully.', 'success');
        applyTranslations(currentSettings.language);
    } else {
        const lang = currentSettings.language.toLowerCase();
        log(`failed to save settings: ${result.error}`, 'error');
        showMessageModal(translations[lang]['error-title'], `failed to save settings: ${result.error}`);
    }
}

// --- language management ---
const languages = { english: 'us', russian: 'ru', german: 'de', spanish: 'es', chinese: 'cn' };
function updateLanguageDisplay(lang) {
    const langKey = lang.toLowerCase();
    document.getElementById('current-language-flag').src = `https://flagcdn.com/w20/${languages[langKey]}.png`;
    document.getElementById('current-language-flag').alt = `${lang} flag`;
    document.getElementById('current-language-text').textContent = lang;
}

// --- mod management ---
function getPakchunkNumber(modName) {
    const record = installedModsData[modName];
    if (!record) return '';
    const filesByTarget = record.filesByTarget || record.installedFilesByTarget || {};
    const firstTargetFiles = Object.values(filesByTarget)[0];
    if (!firstTargetFiles) return '';
    for (const f of firstTargetFiles) {
        const m = /pakchunk0*(\d+)/i.exec(f.original || '');
        if (m) return m[1];
    }
    return '';
}

// --- archived mods: view/restore/permanently-delete mods set aside from Install Mods ---
async function refreshArchivedModsCount() {
    const badge = document.getElementById('archived-mods-count');
    if (!badge || !window.electronAPI.getArchivedMods) return;
    const archived = await window.electronAPI.getArchivedMods();
    badge.textContent = archived.length > 0 ? `(${archived.length})` : '';
}

async function renderArchivedModsModal() {
    const list = document.getElementById('archived-mods-list');
    const noMsg = document.getElementById('no-archived-mods-message');
    if (!list) return;
    list.innerHTML = '';

    const archived = await window.electronAPI.getArchivedMods();
    await refreshArchivedModsCount();

    if (!archived || archived.length === 0) {
        if (noMsg) noMsg.style.display = 'block';
        return;
    }
    if (noMsg) noMsg.style.display = 'none';

    archived.forEach(mod => {
        const row = document.createElement('div');
        row.classList.add('mod-item');
        row.innerHTML = `
            <div style="flex:1;min-width:0;">
                <span class="mod-item-name">${stripModExtension(mod.name)}</span>
                <div class="mod-item-author text-xs">${formatFileSize(mod.size)}</div>
            </div>
            <button class="archived-restore-btn font-semibold py-1.5 px-3 rounded-md transition duration-200" style="border: 1px solid var(--accent-color); margin-right: 0.5rem;"><i class="fas fa-rotate-left mr-1"></i> restore</button>
            <button class="archived-delete-btn" title="Delete permanently" style="background:none;border:none;cursor:pointer;font-size:1.1em;color:#e0555f;"><i class="fas fa-trash-alt"></i></button>
        `;

        row.querySelector('.archived-restore-btn').addEventListener('click', async () => {
            const result = await window.electronAPI.restoreArchivedMod(mod.name);
            if (result.success) {
                log(`restored '${mod.name}' from the archive.`, 'success');
            } else {
                showMessageModal('Error', result.error || 'Could not restore this mod.');
            }
            await renderArchivedModsModal();
        });

        row.querySelector('.archived-delete-btn').addEventListener('click', async () => {
            const confirmed = await showConfirmationModal('Delete permanently', `Permanently delete "${stripModExtension(mod.name)}"? This can't be undone.`);
            if (!confirmed) return;
            const result = await window.electronAPI.deleteArchivedMod(mod.name);
            if (!result.success) {
                showMessageModal('Error', result.error || 'Could not delete this file.');
            }
            await renderArchivedModsModal();
        });

        list.appendChild(row);
    });
}

function formatFileSize(bytes) {
    if (!bytes || bytes <= 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let size = bytes;
    while (size >= 1024 && i < units.length - 1) {
        size /= 1024;
        i++;
    }
    return `${size.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

let downloadsTabBusy = false;

function buildSingleModCard(card, mod, displayName, ext) {
    card.innerHTML = `
        <i class="fas fa-file-zipper download-card-icon"></i>
        <div class="download-card-info">
            <div class="download-card-name">
                <span class="download-name-text">${displayName}</span><span class="download-name-ext" style="color:var(--mod-card-text-secondary);">${ext}</span>
            </div>
            <div class="download-card-meta">${formatFileSize(mod.size)} · ${mod.pakFileCount} pakchunk${mod.pakFileCount === 1 ? '' : 's'} found${mod.samplePakNames.length ? ' (e.g. ' + mod.samplePakNames.join(', ') + ')' : ''}</div>
        </div>
        <div class="download-card-actions">
            <button class="download-rename-btn" title="Rename file"><i class="fas fa-pencil-alt"></i></button>
            <button class="download-move-btn"><i class="fas fa-arrow-right mr-1"></i> add to mods folder</button>
        </div>
    `;

    card.querySelector('.download-rename-btn').addEventListener('click', () => {
        startInlineRename(card, mod, ext);
    });

    card.querySelector('.download-move-btn').addEventListener('click', async (e) => {
        const btn = e.currentTarget;
        btn.disabled = true;
        btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> moving...';
        const result = await window.electronAPI.moveDownloadToLibrary(mod.path);
        if (result.success) {
            log(`moved '${mod.name}' into the mods folder.`, 'success');
            await renderDownloadsTab();
        } else {
            btn.disabled = false;
            btn.innerHTML = '<i class="fas fa-arrow-right mr-1"></i> add to mods folder';
            showMessageModal('Could not move file', result.error || 'Something went wrong.');
        }
    });
}

function buildVariantCard(card, mod, displayName, ext) {
    card.classList.add('download-card-variant');
    const lang = translations[currentSettings.language.toLowerCase()] || translations.english;
    const t = (key) => lang[key] || translations.english[key];
    const variantRows = mod.variants.map((v, i) => `
        <label class="variant-option-row">
            <input type="checkbox" class="variant-checkbox" data-folder="${encodeURIComponent(v.folder)}">
            <span class="variant-name-field">
                <i class="fas fa-pencil-alt"></i>
                <input type="text" class="variant-name-input" value="${(v.displayName || v.folder).replace(/"/g, '&quot;')}" title="click to rename — this is what the mod will be saved as">
            </span>
            <span class="variant-meta">${v.pakFileNames.length} ${v.pakFileNames.length === 1 ? t('pakchunk-singular') : t('pakchunk-plural')}</span>
        </label>
    `).join('');

    card.innerHTML = `
        <div style="width:100%;">
            <div style="display:flex;align-items:center;gap:1rem;margin-bottom:0.75rem;">
                <i class="fas fa-layer-group download-card-icon"></i>
                <div class="download-card-info">
                    <div class="download-card-name">
                        <span class="download-name-text">${displayName}</span><span class="download-name-ext" style="color:var(--mod-card-text-secondary);">${ext}</span>
                    </div>
                    <div class="download-card-meta">${formatFileSize(mod.size)} · ${mod.variants.length} ${t('variants-found-suffix')}</div>
                </div>
            </div>
            <p class="variant-note"><i class="fas fa-circle-info mr-1"></i> ${t('variant-note')}</p>
            <div class="variant-list">${variantRows}</div>
            <div style="display:flex;justify-content:flex-end;margin-top:0.75rem;">
                <button class="download-move-btn variant-create-btn" disabled><i class="fas fa-plus mr-1"></i> ${t('create-selected-mods-button')}</button>
            </div>
        </div>
    `;

    const rows = [...card.querySelectorAll('.variant-option-row')];
    const checkboxes = card.querySelectorAll('.variant-checkbox');
    const createBtn = card.querySelector('.variant-create-btn');
    checkboxes.forEach(cb => {
        cb.addEventListener('change', () => {
            createBtn.disabled = ![...checkboxes].some(c => c.checked);
        });
    });
    // don't let the checkbox toggle when clicking into the name field
    card.querySelectorAll('.variant-name-input').forEach(input => {
        input.addEventListener('click', (e) => e.stopPropagation());
    });

    createBtn.addEventListener('click', async () => {
        const selected = rows
            .filter(row => row.querySelector('.variant-checkbox').checked)
            .map(row => ({
                folder: decodeURIComponent(row.querySelector('.variant-checkbox').dataset.folder),
                name: row.querySelector('.variant-name-input').value.trim(),
            }));
        if (selected.length === 0) return;
        createBtn.disabled = true;
        createBtn.innerHTML = '<i class="fas fa-spinner fa-spin mr-1"></i> creating...';
        const { results } = await window.electronAPI.createVariantMods(mod.path, selected);
        const succeeded = results.filter(r => r.success);
        const failed = results.filter(r => !r.success);
        if (succeeded.length > 0) {
            log(`created ${succeeded.length} variant mod(s) from '${mod.name}'.`, 'success');
        }
        if (failed.length > 0) {
            showMessageModal('Some variants failed', failed.map(f => `${f.folder}: ${f.error}`).join('\n'));
        }
        await renderDownloadsTab();
    });
}

async function renderDownloadsTab() {
    if (downloadsTabBusy) return;
    downloadsTabBusy = true;
    try {
        const pathText = document.getElementById('downloads-path-text');
        const list = document.getElementById('downloads-list');
        const noMsg = document.getElementById('no-downloads-message');
        if (!list) return;

        const downloadsPath = await window.electronAPI.getDownloadsPath();
        if (pathText) pathText.textContent = downloadsPath;

        list.innerHTML = `<p class="text-gray-400 text-center"><i class="fas fa-spinner fa-spin mr-2"></i>scanning...</p>`;
        if (noMsg) noMsg.style.display = 'none';

        const result = await window.electronAPI.scanDownloadsForMods();
        list.innerHTML = '';

        if (!result.success) {
            list.innerHTML = `<p class="text-gray-400 text-center">${result.error || 'could not scan the downloads folder.'}</p>`;
            return;
        }

        if (!result.mods || result.mods.length === 0) {
            if (noMsg) noMsg.style.display = 'block';
            return;
        }
        if (noMsg) noMsg.style.display = 'none';

        result.mods.forEach(mod => {
            const card = document.createElement('div');
            card.classList.add('download-card');
            const displayName = stripModExtension(mod.name);
            const ext = mod.name.slice(displayName.length);

            if (mod.isMultiVariant) {
                buildVariantCard(card, mod, displayName, ext);
            } else {
                buildSingleModCard(card, mod, displayName, ext);
            }

            list.appendChild(card);
        });
    } finally {
        downloadsTabBusy = false;
    }
}

function startInlineRename(card, mod, ext) {
    const nameDiv = card.querySelector('.download-card-name');
    const currentDisplayName = stripModExtension(mod.name);
    nameDiv.innerHTML = `<input type="text" class="download-rename-input" value="${currentDisplayName}"><span style="color:var(--mod-card-text-secondary);">${ext}</span>`;
    const input = nameDiv.querySelector('input');
    input.focus();
    input.select();

    const commit = async () => {
        const newName = input.value.trim();
        if (!newName || newName === currentDisplayName) {
            await renderDownloadsTab();
            return;
        }
        const result = await window.electronAPI.renameDownloadFile(mod.path, newName);
        if (result.success) {
            log(`renamed '${mod.name}' to '${result.newName}'.`, 'success');
        } else {
            showMessageModal('Rename failed', result.error || 'Could not rename this file.');
        }
        await renderDownloadsTab();
    };
    input.addEventListener('blur', commit, { once: true });
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') input.blur();
        else if (e.key === 'Escape') { input.removeEventListener('blur', commit); renderDownloadsTab(); }
    });
}

async function renderInstalledMods() {
    log('refreshing mod library.', 'system');

    const availableMods = await window.electronAPI.getAvailableMods();
    installedModsData = await window.electronAPI.getInstalledMods();
    refreshArchivedModsCount();

    const installedModsListDiv = document.getElementById('installed-mods-list');
    if (!installedModsListDiv) return;
    installedModsListDiv.innerHTML = '';

    const lang = currentSettings.language ? currentSettings.language.toLowerCase() : 'english';

    if (Object.keys(installedModsData).length === 0) {
        const noModsMessage = document.createElement('p');
        noModsMessage.classList.add('text-gray-400', 'text-center');
        noModsMessage.textContent = translations[lang]['no-mods-installed'] || 'No mods in your library yet. Click "Install Mods" to add one.';
        installedModsListDiv.appendChild(noModsMessage);
        return;
    }

    // --- Favorite/star mods ---
    let favorites = [];
    try { favorites = JSON.parse(localStorage.getItem('favoriteMods') || '[]'); } catch { favorites = []; }

    // --- Custom display names (cosmetic rename only — never touches the actual file) ---
    let modDisplayNames = {};
    try { modDisplayNames = JSON.parse(localStorage.getItem('modDisplayNames') || '{}'); } catch { modDisplayNames = {}; }
    function getDisplayName(modName) {
        const custom = modDisplayNames[modName];
        return custom && custom.trim() ? custom.trim() : stripModExtension(modName);
    }
    async function renameMod(modName) {
        const current = modDisplayNames[modName] || stripModExtension(modName);
        const input = await showRenameModal(current);
        if (input === null) return; // cancelled
        const trimmed = input.trim();
        if (!trimmed || trimmed === stripModExtension(modName)) {
            delete modDisplayNames[modName]; // back to the default name
        } else {
            modDisplayNames[modName] = trimmed;
        }
        localStorage.setItem('modDisplayNames', JSON.stringify(modDisplayNames));
        renderInstalledMods();
    }

    // --- search + sort (controls live on the main mods tab now) ---
    const searchInput = document.getElementById('mod-library-search');
    const sortSelect = document.getElementById('mod-library-sort');
    const searchTerm = (searchInput?.value || '').trim().toLowerCase();
    const sortMode = sortSelect?.value || 'alphabetical';

    let mods = availableMods.filter(m => Object.prototype.hasOwnProperty.call(installedModsData, m.name));
    if (searchTerm) {
        mods = mods.filter(mod => {
            const name = getDisplayName(mod.name).toLowerCase();
            const author = (mod.metadata?.author || '').toLowerCase();
            return name.includes(searchTerm) || author.includes(searchTerm);
        });
    }

    mods = [...mods].sort((a, b) => {
        const afav = favorites.includes(a.name), bfav = favorites.includes(b.name);
        if (afav && !bfav) return -1;
        if (!afav && bfav) return 1;
        if (sortMode === 'alphabetical') {
            return getDisplayName(a.name).localeCompare(getDisplayName(b.name), undefined, { sensitivity: 'base' });
        }
        return 0; // 'recent': keep backend order
    });

    if (mods.length === 0) {
        const noMatch = document.createElement('p');
        noMatch.classList.add('text-gray-400', 'text-center');
        noMatch.textContent = `No mods match "${searchTerm}".`;
        installedModsListDiv.appendChild(noMatch);
        return;
    }

    mods.forEach(mod => {
        const modName = mod.name;
        const metadata = mod.metadata || {};
        const isEnabled = !!mod.installed;
        const pakchunkNumber = getPakchunkNumber(modName);

        const modItem = document.createElement('div');
        modItem.classList.add('mod-item', isEnabled ? 'mod-item-installed' : 'mod-item-not-installed');

        let previewHtml = '';
        if (metadata.preview) {
            previewHtml = `<img src="${metadata.preview}" alt="preview" style="width:48px;height:48px;object-fit:cover;border-radius:0.25rem;margin-right:1rem;">`;
        }

        modItem.innerHTML = `
            <div style="display:flex;align-items:center;gap:1rem;flex:1;min-width:0;">
                <label class="toggle-switch small">
                    <input type="checkbox" class="mod-toggle-checkbox" data-mod-name="${modName}" data-mod-path="${mod.path}" ${isEnabled ? 'checked' : ''}>
                    <span class="slider"></span>
                </label>
                ${previewHtml}
                <div style="flex:1;min-width:0;">
                    <span class="mod-item-name">${getDisplayName(modName)}</span>
                    ${metadata.author ? `<div class="mod-item-author text-xs">by ${metadata.author}</div>` : ''}
                </div>
            </div>
            <span class="mod-pakchunk-number">${pakchunkNumber}</span>
            <button class="mod-rename-button" title="Rename" style="background:none;border:none;cursor:pointer;font-size:1.1em;margin-right:0.5rem;"><i class="fas fa-pencil-alt"></i></button>
            <button class="mod-archive-button" title="Archive (hide from Install Mods, keep the file)" style="background:none;border:none;cursor:pointer;font-size:1.1em;margin-right:0.5rem;"><i class="fas fa-box-archive"></i></button>
            <button class="mod-delete-button" title="Remove from library" style="background:none;border:none;cursor:pointer;font-size:1.1em;color:#e0555f;"><i class="fas fa-trash-alt"></i></button>
        `;

        modItem.querySelector('.mod-toggle-checkbox').addEventListener('change', async (e) => {
            const checkbox = e.target;
            checkbox.disabled = true;
            const path_ = checkbox.dataset.modPath;
            const result = checkbox.checked
                ? await window.electronAPI.installMod(modName, path_)
                : await window.electronAPI.uninstallMod(modName);
            if (!result.success) {
                showMessageModal('Error', result.error || 'Something went wrong toggling this mod.');
                checkbox.checked = !checkbox.checked; // revert on failure
            }
            checkbox.disabled = false;
            await renderInstalledMods();
        });

        modItem.querySelector('.mod-rename-button').addEventListener('click', (e) => {
            e.stopPropagation();
            renameMod(modName);
        });

        modItem.querySelector('.mod-archive-button').addEventListener('click', async (e) => {
            e.stopPropagation();
            const confirmed = await showConfirmationModal('Archive mod', `Archive "${getDisplayName(modName)}"? It'll be uninstalled and hidden from Install Mods, but you can restore it anytime from the Archived Mods list.`);
            if (!confirmed) return;
            const result = await window.electronAPI.archiveMod(modName);
            if (!result.success) {
                showMessageModal('Error', result.error || 'Could not archive this mod.');
            } else {
                log(`archived '${modName}'.`, 'success');
            }
            await renderInstalledMods();
        });

        modItem.querySelector('.mod-delete-button').addEventListener('click', async (e) => {
            e.stopPropagation();
            const confirmed = await showConfirmationModal('Remove mod', `Remove "${getDisplayName(modName)}" from your mod library? It'll be uninstalled from the game, but the file stays in your mods folder — you can re-add it anytime from Install Mods.`);
            if (!confirmed) return;
            const result = await window.electronAPI.deleteMod(modName);
            if (!result.success) {
                showMessageModal('Error', result.error || 'Could not remove this mod.');
            }
            await renderInstalledMods();
        });

        installedModsListDiv.appendChild(modItem);
    });
}

// --- conversor tab logic ---
const modNameInput = document.getElementById('mod-name-input');
const allFilesPathInput = document.getElementById('all-files-path');
const convertButton = document.getElementById('convert-button');
let selectedConversionFiles = [];

function checkConvertButtonStatus() {
    const isReady = modNameInput?.value.trim() && selectedConversionFiles.length === 4;
    if (convertButton) {
        convertButton.disabled = !isReady;
        convertButton.classList.toggle('highlight', isReady);
    }
}

function resetConversorForm() {
    modNameInput.value = '';
    allFilesPathInput.value = '';
    selectedConversionFiles = [];
    checkConvertButtonStatus();
}

// --- console tab enhancements ---
let logFilter = 'all';
function filterConsoleLog() {
    const entries = document.querySelectorAll('.console-log-entry');
    entries.forEach(entry => {
        if (logFilter === 'all') entry.style.display = '';
        else if (logFilter === 'error') entry.style.display = entry.classList.contains('error') ? '' : 'none';
        else if (logFilter === 'warn') entry.style.display = entry.classList.contains('warn') ? '' : 'none';
    });
}
document.addEventListener('DOMContentLoaded', () => {
    const copyBtn = document.getElementById('copy-log-button');
    const showErrorsBtn = document.getElementById('show-errors-button');
    const showWarningsBtn = document.getElementById('show-warnings-button');
    const showAllBtn = document.getElementById('show-all-log-button');
    if (copyBtn) copyBtn.onclick = () => {
        const logText = Array.from(document.querySelectorAll('.console-log-entry'))
            .filter(e => e.style.display !== 'none')
            .map(e => e.textContent).join('\n');
        navigator.clipboard.writeText(logText);
    };
    if (showErrorsBtn) showErrorsBtn.onclick = () => { logFilter = 'error'; filterConsoleLog(); };
    if (showWarningsBtn) showWarningsBtn.onclick = () => { logFilter = 'warn'; filterConsoleLog(); };
    if (showAllBtn) showAllBtn.onclick = () => { logFilter = 'all'; filterConsoleLog(); };
});
// Patch log to respect filter
const origLog = log;
log = function (message, type = 'info') {
    origLog(message, type);
    filterConsoleLog();
};

// --- initialization and event listeners ---
window.addEventListener('error', function (e) {
    log('JS Error: ' + e.message + '\n' + (e.error && e.error.stack ? e.error.stack : ''), 'error');
});
document.addEventListener('DOMContentLoaded', async () => {
    console.log("renderer script: domcontentloaded event fired.");

    try {
        await loadSettings();

        // signal to main process that renderer is ready
        window.electronAPI.rendererReady();

        // attach title bar listeners ONCE, never overwrite sidebar/titlebar
        document.getElementById('minimize-button')?.addEventListener('click', () => window.electronAPI.minimizeWindow());
        document.getElementById('maximize-button')?.addEventListener('click', () => window.electronAPI.maximizeWindow());
        document.getElementById('close-button')?.addEventListener('click', () => window.electronAPI.closeWindow());
        document.getElementById('discord-button')?.addEventListener('click', () => window.electronAPI.openDiscordInvite());
        initUpdateChecker();

        // Robust event delegation for tab buttons and title bar
        document.getElementById('sidebar')?.addEventListener('click', (e) => {
            const btn = e.target.closest('.tab-button');
            if (btn && btn.dataset.tab) {
                activateTab(`${btn.dataset.tab}-tab`);
            }
        });
        // Custom title bar buttons
        document.getElementById('custom-title-bar-buttons')?.addEventListener('click', (e) => {
            const btn = e.target.closest('.title-bar-button');
            if (!btn) return;
            if (btn.id === 'minimize-button') window.electronAPI.minimizeWindow();
            if (btn.id === 'maximize-button') window.electronAPI.maximizeWindow();
            if (btn.id === 'close-button') window.electronAPI.closeWindow();
        });

        // settings listeners
        document.getElementById('select-mod-folder')?.addEventListener('click', async () => {
            const folderPath = await window.electronAPI.openFolderDialog();
            if (folderPath) {
                document.getElementById('mod-folder-path').value = folderPath;
                await saveSettings();
            }
        });

        document.getElementById('select-trainer-zip')?.addEventListener('click', async () => {
            const filePaths = await window.electronAPI.openFileDialog([{ name: 'Zip Archive', extensions: ['zip'] }]);
            if (filePaths && filePaths.length > 0) {
                document.getElementById('trainer-zip-path').value = filePaths[0];
                await saveSettings();
            }
        });

        document.getElementById('select-spoofer-zip')?.addEventListener('click', async () => {
            const filePaths = await window.electronAPI.openFileDialog([{ name: 'Zip Archive', extensions: ['zip'] }]);
            if (filePaths && filePaths.length > 0) {
                document.getElementById('spoofer-zip-path').value = filePaths[0];
                await saveSettings();
            }
        });

        // per-platform game launch executable overrides
        const gameLaunchBrowseButtons = [
            ['select-game-launch-steam', 'game-launch-path-steam'],
            ['select-game-launch-epic-games', 'game-launch-path-epic-games'],
            ['select-game-launch-microsoft', 'game-launch-path-microsoft']
        ];
        gameLaunchBrowseButtons.forEach(([btnId, inputId]) => {
            document.getElementById(btnId)?.addEventListener('click', async () => {
                const filePaths = await window.electronAPI.openFileDialog([{ name: 'Executable', extensions: ['exe'] }]);
                if (filePaths && filePaths.length > 0) {
                    document.getElementById(inputId).value = filePaths[0];
                    await saveSettings();
                }
            });
        });

        // trainer/spoofer quick-launch buttons: extract fresh from the configured
        // zip and launch the exe every time, since the exe self-deletes after each
        // run. Launches now retry automatically (and indefinitely) in the main
        // process if the attempt dies early, so this can run for a while — the
        // button stays clickable the whole time and clicking it again cancels
        // instead of queuing a second launch.
        const activeToolLaunches = { trainer: false, spoofer: false };

        async function launchTool(button, launchFn, label) {
            const lang = currentSettings.language.toLowerCase();
            const originalHtml = button.innerHTML;
            activeToolLaunches[label] = true;
            button.classList.add('tool-launching');
            button.title = 'click to cancel';
            button.innerHTML = '<i class="fas fa-spinner fa-spin"></i> launching...';
            try {
                const result = await launchFn();
                if (result.success) {
                    log(`${label} launched.${result.message ? ' ' + result.message : ''}`, 'success');
                    if (result.message) {
                        showMessageModal(translations[lang]['success-title'] || 'success', result.message);
                    }
                } else {
                    const wasCancelled = /cancelled/i.test(result.error || '');
                    log(`${wasCancelled ? '' : 'failed to launch '}${label}${wasCancelled ? ' cancelled' : ''}: ${result.error}`, wasCancelled ? 'system' : 'error');
                    if (!wasCancelled) {
                        showMessageModal(translations[lang]['error-title'] || 'error', result.error);
                    }
                }
            } finally {
                activeToolLaunches[label] = false;
                button.classList.remove('tool-launching');
                button.title = '';
                button.innerHTML = originalHtml;
            }
        }
        document.getElementById('launch-trainer-btn')?.addEventListener('click', (e) => {
            if (activeToolLaunches.trainer) {
                window.electronAPI.cancelToolLaunch('trainer');
                return;
            }
            launchTool(e.currentTarget, () => window.electronAPI.launchTrainer(), 'trainer');
        });
        document.getElementById('launch-spoofer-btn')?.addEventListener('click', (e) => {
            if (activeToolLaunches.spoofer) {
                window.electronAPI.cancelToolLaunch('spoofer');
                return;
            }
            launchTool(e.currentTarget, () => window.electronAPI.launchSpoofer(), 'spoofer');
        });
        // launching the game gets a 10s countdown first, so trainer/spoofer
        // have time to finish injecting before the game process starts
        document.getElementById('launch-game-btn')?.addEventListener('click', async (e) => {
            const platform = document.getElementById('launch-game-platform')?.value || 'Steam';
            const button = e.currentTarget;
            const lang = currentSettings.language.toLowerCase();
            const originalHtml = button.innerHTML;

            showMessageModal(
                translations[lang]['warning-title'] || 'warning',
                'do not launch the game again — there is a 10 second delay before it starts, to make sure the trainer/spoofer finish injecting first. clicking launch again during the countdown will not speed this up.'
            );
            log('waiting 10s before launching the game so trainer/spoofer can finish injecting...', 'system');

            button.disabled = true;
            for (let secondsLeft = 10; secondsLeft > 0; secondsLeft--) {
                button.innerHTML = `<i class="fas fa-hourglass-half"></i> launching in ${secondsLeft}s...`;
                await new Promise(r => setTimeout(r, 1000));
            }
            button.innerHTML = originalHtml;
            await launchTool(button, () => window.electronAPI.launchGame(platform), `game (${platform})`);
        });

        // auto-detect game install locations across steam/epic/xbox
        document.getElementById('auto-detect-targets-btn')?.addEventListener('click', async (event) => {
            const lang = currentSettings.language.toLowerCase();
            const btn = event.currentTarget;
            const originalHtml = btn.innerHTML;
            btn.disabled = true;
            btn.innerHTML = '<i class="fas fa-spinner fa-spin mr-2"></i> scanning...';
            try {
                const result = await window.electronAPI.detectGameInstalls();
                await renderDeployTargets();
                if (result.success) {
                    if (result.added > 0) {
                        showMessageModal(translations[lang]['success-title'] || 'success', `found ${result.added} new game install location(s).`);
                    } else {
                        showMessageModal(translations[lang]['info-title'] || 'info', 'no new install locations found. if the game is installed somewhere unusual, add it manually below.');
                    }
                } else {
                    showMessageModal(translations[lang]['error-title'], `detection failed: ${result.error}`);
                }
            } finally {
                btn.disabled = false;
                btn.innerHTML = originalHtml;
            }
        });

        // manually add a game install location
        document.getElementById('add-manual-target-btn')?.addEventListener('click', async () => {
            const lang = currentSettings.language.toLowerCase();
            const folderPath = await window.electronAPI.openFolderDialog();
            if (!folderPath) return;
            const platform = document.getElementById('manual-target-platform')?.value || 'Steam';
            const result = await window.electronAPI.addDeployTarget(platform, folderPath);
            await renderDeployTargets();
            if (!result.success) {
                showMessageModal(translations[lang]['error-title'], `failed to add location: ${result.error}`);
            } else if (result.added === 0) {
                showMessageModal(translations[lang]['info-title'] || 'info', 'that folder is already a game install location.');
            }
        });

        // remove a game install location (event delegation, list is re-rendered often)
        document.getElementById('deploy-targets-list')?.addEventListener('click', async (event) => {
            const removeBtn = event.target.closest('.deploy-target-remove');
            if (!removeBtn) return;
            const targetId = removeBtn.dataset.targetId;
            const lang = currentSettings.language.toLowerCase();
            const confirmed = await showConfirmationModal(
                translations[lang]['confirm-action-title'] || 'confirm',
                'remove this game install location? mods currently deployed there will not be automatically uninstalled from it.'
            );
            if (confirmed) {
                await window.electronAPI.removeDeployTarget(targetId);
                await renderDeployTargets();
            }
        });

        // theme color pickers
        document.querySelectorAll('.color-swatch-row input[type="color"]').forEach(input => {
            input.addEventListener('input', (e) => {
                const key = e.target.dataset.themeKey;
                if (!key) return;
                const theme = { ...DEFAULT_THEME, ...(currentSettings.theme || {}) };
                theme[key] = e.target.value;
                currentSettings.theme = theme;
                applyTheme(theme);
            });
            input.addEventListener('change', async () => {
                await saveSettings();
            });
        });
        document.getElementById('reset-theme-button')?.addEventListener('click', async () => {
            currentSettings.theme = { ...DEFAULT_THEME };
            applyTheme(currentSettings.theme);
            await saveSettings();
            log('theme reset to default.', 'system');
        });

        // layout editor: font size slider — live preview while dragging,
        // persist only once the user releases it (same pattern as glow intensity)
        document.getElementById('font-size-slider')?.addEventListener('input', (e) => {
            const layout = { ...DEFAULT_LAYOUT, ...(currentSettings.layout || {}) };
            layout.fontSize = parseInt(e.target.value, 10);
            currentSettings.layout = layout;
            applyLayoutSettings(layout);
        });
        document.getElementById('font-size-slider')?.addEventListener('change', async () => {
            await saveSettings();
        });

        // layout editor: text glow toggle
        document.getElementById('text-glow-toggle')?.addEventListener('change', async (e) => {
            const layout = { ...DEFAULT_LAYOUT, ...(currentSettings.layout || {}) };
            layout.textGlow = e.target.checked;
            currentSettings.layout = layout;
            applyLayoutSettings(layout);
            await saveSettings();
        });

        // layout editor: glow intensity slider — live preview while dragging,
        // persist only once the user releases it (avoids spamming disk writes)
        document.getElementById('glow-intensity-slider')?.addEventListener('input', (e) => {
            const layout = { ...DEFAULT_LAYOUT, ...(currentSettings.layout || {}) };
            layout.glowIntensity = parseInt(e.target.value, 10);
            currentSettings.layout = layout;
            applyLayoutSettings(layout);
        });
        document.getElementById('glow-intensity-slider')?.addEventListener('change', async () => {
            await saveSettings();
        });

        // layout editor: glow color picker
        document.getElementById('glow-color-picker')?.addEventListener('input', (e) => {
            const layout = { ...DEFAULT_LAYOUT, ...(currentSettings.layout || {}) };
            layout.glowColor = e.target.value;
            currentSettings.layout = layout;
            applyLayoutSettings(layout);
        });
        document.getElementById('glow-color-picker')?.addEventListener('change', async () => {
            await saveSettings();
        });

        // layout editor: show mod numbers toggle
        document.getElementById('show-mod-numbers-toggle')?.addEventListener('change', async (e) => {
            const layout = { ...DEFAULT_LAYOUT, ...(currentSettings.layout || {}) };
            layout.showModNumbers = e.target.checked;
            currentSettings.layout = layout;
            applyLayoutSettings(layout);
            await saveSettings();
        });

        // language modal
        document.getElementById('language-selector')?.addEventListener('click', () => {
            const modal = document.getElementById('language-selection-modal');
            modal?.classList.remove('hidden');
            document.querySelectorAll('.language-option').forEach(option => {
                option.classList.toggle('selected', option.dataset.lang.toLowerCase() === currentSettings.language.toLowerCase());
            });
        });
        document.getElementById('language-selection-modal').addEventListener('click', async (event) => {
            const target = event.target.closest('.language-option');
            if (target) {
                const selectedLang = target.dataset.lang;
                updateLanguageDisplay(selectedLang);
                currentSettings.language = selectedLang;
                await saveSettings();
                hideModal('language-selection-modal');
            }
        });

        // uninstall all mods button
        document.getElementById('uninstall-all-mods-button')?.addEventListener('click', async () => {
            const lang = currentSettings.language.toLowerCase();
            const confirmed = await showConfirmationModal(
                translations[lang]['confirm-action-title'],
                translations[lang]['confirm-uninstall-all-mods-message']
            );
            if (confirmed) {
                const result = await window.electronAPI.uninstallAllMods();
                if (result.success) {
                    showMessageModal(translations[lang]['success-title'], `successfully uninstalled ${result.count} non-base mods.`);
                    await renderInstalledMods();
                } else {
                    showMessageModal(translations[lang]['error-title'], `failed to uninstall all mods: ${result.error}`);
                }
            }
        });

        // mod profiles: save the current set of enabled mods, load a saved set
        document.getElementById('save-profile-btn')?.addEventListener('click', async () => {
            const input = document.getElementById('new-profile-name');
            const name = input?.value.trim();
            if (!name) {
                showMessageModal('Profile name required', 'Give this profile a name first.');
                return;
            }
            const result = await window.electronAPI.saveModProfile(name);
            if (result.success) {
                log(`saved mod profile '${name}'.`, 'success');
                input.value = '';
                await renderModProfiles();
                document.getElementById('mod-profile-select').value = name;
            } else {
                showMessageModal('Save failed', result.error || 'Could not save this profile.');
            }
        });

        document.getElementById('load-profile-btn')?.addEventListener('click', async () => {
            const select = document.getElementById('mod-profile-select');
            const name = select?.value;
            if (!name) {
                showMessageModal('No profile selected', 'Pick a profile from the list first.');
                return;
            }
            const confirmed = await showConfirmationModal(
                'Load profile',
                `Load profile "${name}"? Mods not in this profile will be turned off, and mods in this profile will be turned on.`
            );
            if (!confirmed) return;
            const result = await window.electronAPI.loadModProfile(name);
            if (result.success) {
                let msg = `Profile loaded: ${result.enabledCount} enabled, ${result.disabledCount} disabled.`;
                if (result.missingCount > 0) msg += ` ${result.missingCount} mod(s) from this profile are no longer in your mods folder.`;
                showMessageModal('Profile loaded', msg);
                await renderInstalledMods();
            } else {
                showMessageModal('Load failed', result.error || 'Could not load this profile.');
            }
        });

        document.getElementById('delete-profile-btn')?.addEventListener('click', async () => {
            const select = document.getElementById('mod-profile-select');
            const name = select?.value;
            if (!name) {
                showMessageModal('No profile selected', 'Pick a profile from the list first.');
                return;
            }
            const confirmed = await showConfirmationModal('Delete profile', `Delete profile "${name}"? This can't be undone.`);
            if (!confirmed) return;
            const result = await window.electronAPI.deleteModProfile(name);
            if (result.success) {
                log(`deleted mod profile '${name}'.`, 'info');
                await renderModProfiles();
            } else {
                showMessageModal('Delete failed', result.error || 'Could not delete this profile.');
            }
        });

        // mods tab: import new archives directly into the library via a file picker.
        // they land in the library off by default — toggle them on from the main list.
        async function renderAvailableModsPicker() {
            const lang = currentSettings.language.toLowerCase();
            const availableMods = await window.electronAPI.getAvailableMods();
            const modSelectionList = document.getElementById('available-mods-list');
            if (!modSelectionList) return;
            modSelectionList.innerHTML = '';

            const searchInput = document.getElementById('available-mods-search');
            const searchTerm = (searchInput?.value || '').trim().toLowerCase();
            let mods = availableMods;
            if (searchTerm) {
                mods = mods.filter(mod => {
                    const name = stripModExtension(mod.name).toLowerCase();
                    const author = (mod.metadata?.author || '').toLowerCase();
                    return name.includes(searchTerm) || author.includes(searchTerm);
                });
            }
            mods = [...mods].sort((a, b) =>
                stripModExtension(a.name).localeCompare(stripModExtension(b.name), undefined, { sensitivity: 'base' })
            );

            const noModsMessage = document.getElementById('no-available-mods-message');
            if (mods.length === 0) {
                if (noModsMessage) {
                    noModsMessage.style.display = 'block';
                    noModsMessage.textContent = searchTerm
                        ? `No mods match "${searchTerm}".`
                        : (translations[lang]['no-available-mods'] || 'No mod files found in your mods folder.');
                }
                return;
            }
            if (noModsMessage) noModsMessage.style.display = 'none';

            mods.forEach(mod => {
                const isInstalled = !!mod.installed;
                const modItem = document.createElement('div');
                modItem.classList.add('mod-item', isInstalled ? 'mod-item-installed' : 'mod-item-not-installed');
                modItem.innerHTML = `
                    <span class="mod-item-name">${stripModExtension(mod.name)}</span>
                    <button class="mod-toggle-button ${isInstalled ? 'off' : 'on'}" data-mod-name="${mod.name}" data-mod-path="${mod.path}" ${isInstalled ? 'disabled' : ''}>
                        ${isInstalled ? translations[lang]['installed-button'] : translations[lang]['install-button']}
                    </button>
                `;
                modSelectionList.appendChild(modItem);
            });
        }

        document.getElementById('install-mods-button')?.addEventListener('click', async () => {
            const lang = currentSettings.language.toLowerCase();
            if (!currentSettings.modFolderPath) {
                showMessageModal(translations[lang]['error-title'], translations[lang]['pak-folder-not-set'] || 'Set a mods folder in Settings first.');
                return;
            }
            await renderAvailableModsPicker();
            document.getElementById('mod-selection-modal')?.classList.remove('hidden');
        });

        document.getElementById('view-archived-mods-button')?.addEventListener('click', async () => {
            await renderArchivedModsModal();
            document.getElementById('archived-mods-modal')?.classList.remove('hidden');
        });

        document.getElementById('available-mods-search')?.addEventListener('input', () => renderAvailableModsPicker());

        document.getElementById('available-mods-list')?.addEventListener('click', async (event) => {
            const button = event.target.closest('.mod-toggle-button.on');
            if (!button) return;
            const lang = currentSettings.language.toLowerCase();
            const modName = button.dataset.modName;
            const modPath = button.dataset.modPath;
            button.textContent = translations[lang]['installing-button'] || 'installing...';
            button.disabled = true;
            const result = await window.electronAPI.installMod(modName, modPath);
            if (result.success) {
                button.textContent = translations[lang]['installed-button'];
                button.classList.remove('on');
                button.classList.add('off');
                log(`added '${modName}' to the library.`, 'success');
                await renderInstalledMods();
            } else {
                button.textContent = translations[lang]['install-button'];
                button.disabled = false;
                showMessageModal('Install failed', result.error || `Could not add '${modName}' to the library.`);
            }
        });

        if (window.electronAPI && window.electronAPI.onModsFolderChanged) {
            window.electronAPI.onModsFolderChanged(() => renderInstalledMods());
        }
        document.getElementById('mod-library-search')?.addEventListener('input', () => renderInstalledMods());
        document.getElementById('mod-library-sort')?.addEventListener('change', () => renderInstalledMods());

        // downloads tab listeners
        if (window.electronAPI && window.electronAPI.onDownloadsFolderChanged) {
            window.electronAPI.onDownloadsFolderChanged(() => {
                const tab = document.getElementById('downloads-tab');
                if (tab && tab.classList.contains('active')) renderDownloadsTab();
            });
        }
        document.getElementById('rescan-downloads-btn')?.addEventListener('click', () => renderDownloadsTab());
        document.getElementById('change-downloads-path-btn')?.addEventListener('click', async () => {
            const folder = await window.electronAPI.openFolderDialog();
            if (!folder) return;
            await window.electronAPI.setDownloadsPath(folder);
            await renderDownloadsTab();
        });

        // conversor tab listeners
        document.getElementById('select-all-files')?.addEventListener('click', async () => {
            const filePaths = await window.electronAPI.openFileDialog([{ name: 'game files', extensions: ['pak', 'sig', 'ucas', 'utoc'] }]);
            const lang = currentSettings.language.toLowerCase();
            if (filePaths && filePaths.length > 0) {
                const extensions = new Set(filePaths.map(p => p.split('.').pop().toLowerCase()));
                if (filePaths.length === 4 && extensions.has('pak') && extensions.has('sig') && extensions.has('ucas') && extensions.has('utoc')) {
                    selectedConversionFiles = filePaths;
                    allFilesPathInput.value = filePaths.map(p => p.split(/[\\/]/).pop()).join(', ');
                } else {
                    showMessageModal(translations[lang]['error-title'], translations[lang]['invalid-files-selected']);
                    selectedConversionFiles = [];
                    allFilesPathInput.value = '';
                }
                checkConvertButtonStatus();
            }
        });

        modNameInput?.addEventListener('input', checkConvertButtonStatus);

        convertButton?.addEventListener('click', async () => {
            const modName = modNameInput?.value.trim();
            const lang = currentSettings.language.toLowerCase();
            if (!modName || selectedConversionFiles.length !== 4) return;

            convertButton.textContent = 'converting...';
            convertButton.disabled = true;

            const result = await window.electronAPI.convertToMmpackage(modName, selectedConversionFiles);

            if (result.success) {
                showMessageModal(translations[lang]['success-title'], translations[lang]['conversion-success'].replace('{modName}', modName));
                resetConversorForm();
            } else {
                showMessageModal(translations[lang]['error-title'], translations[lang]['conversion-error'].replace('{error}', result.error));
            }

            convertButton.textContent = translations[lang]['convert-button'];
            checkConvertButtonStatus();
        });

        // initial render
        await renderInstalledMods();
        activateTab('mods-tab');

        // --- console tab: export log and clear log ---
        document.getElementById('clear-log-button')?.addEventListener('click', () => {
            if (consoleOutput) consoleOutput.innerHTML = '';
        });
        document.getElementById('export-log-button')?.addEventListener('click', async () => {
            if (!consoleOutput) return;
            const logText = Array.from(consoleOutput.children).map(e => e.textContent).join('\n');
            const filePath = await window.electronAPI.openFileDialog([{ name: 'Text Files', extensions: ['txt'] }]);
            if (filePath && filePath.length > 0) {
                await window.electronAPI.saveTextFile(filePath[0], logText);
                showMessageModal('Export Log', 'Log exported successfully.');
            }
        });

        // --- drag and drop for mods tab (make whole tab a drop zone) ---
        const modsTab = document.getElementById('mods-tab');
        if (modsTab) {
            modsTab.addEventListener('dragover', (event) => {
                event.preventDefault();
                event.dataTransfer.dropEffect = 'copy';
                modsTab.classList.add('ring-4', 'ring-accent-color');
            });
            modsTab.addEventListener('dragleave', () => {
                modsTab.classList.remove('ring-4', 'ring-accent-color');
            });
            modsTab.addEventListener('drop', async (event) => {
                event.preventDefault();
                modsTab.classList.remove('ring-4', 'ring-accent-color');
                const files = Array.from(event.dataTransfer.files);
                const modArchiveFiles = files.filter(f => isSupportedModFile(f.name));
                if (modArchiveFiles.length === 0) {
                    showMessageModal('Error', 'Please drop a supported mod file (.mmpackage, .zip, .7z, .rar).');
                    return;
                }
                for (const file of modArchiveFiles) {
                    // resolve the real filesystem path first — under
                    // contextIsolation, File.path isn't reliably populated
                    // by Chromium; this is Electron's modern replacement
                    const realPath = window.electronAPI.getPathForFile(file);
                    if (!realPath) {
                        log(`Could not resolve a filesystem path for ${file.name}`, 'error');
                        showMessageModal('Error', `Could not read ${file.name} — try dragging it from a real folder instead of a browser download popup.`);
                        continue;
                    }
                    // move it into the mods folder first (e.g. out of Downloads) —
                    // otherwise it'd get "installed" straight from wherever it
                    // was dropped from, and never actually join the library
                    const importResult = await window.electronAPI.importDroppedModFile(realPath);
                    if (!importResult.success) {
                        log(`Failed to move ${file.name} into the mods folder: ${importResult.error}`, 'error');
                        showMessageModal('Error', `Failed to move ${file.name}: ${importResult.error}`);
                        continue;
                    }
                    const result = await window.electronAPI.installMod(file.name, importResult.newPath);
                    if (result.success) {
                        log(`Installed mod: ${file.name}`, 'success');
                    } else {
                        log(`Failed to install mod: ${file.name} - ${result.error}`, 'error');
                        showMessageModal('Error', `Failed to install ${file.name}: ${result.error}`);
                    }
                }
                await renderInstalledMods();
            });
        }

        window.electronAPI.onLogMessage((logEntry) => {
            log(logEntry.message, logEntry.type);
        });
        console.log("renderer: onlogmessage listener set up.");

        // trainer/spoofer now retry indefinitely in the background until they
        // stick — this keeps the button showing real progress instead of a
        // static "launching..." for however long that takes
        window.electronAPI.onToolLaunchProgress?.(({ label, attempt, status, delayMs }) => {
            const btnId = label === 'trainer' ? 'launch-trainer-btn' : label === 'spoofer' ? 'launch-spoofer-btn' : null;
            const btn = btnId && document.getElementById(btnId);
            if (!btn || !activeToolLaunches[label]) return; // only touch it while we're the ones driving it
            if (status === 'trying') {
                btn.innerHTML = attempt > 1
                    ? `<i class="fas fa-spinner fa-spin"></i> attempt ${attempt}...`
                    : `<i class="fas fa-spinner fa-spin"></i> launching...`;
            } else if (status === 'waiting') {
                const secs = Math.max(1, Math.round(delayMs / 1000));
                btn.innerHTML = `<i class="fas fa-clock"></i> retry in ${secs}s...`;
            }
        });

        checkConvertButtonStatus();
    } catch (error) {
        console.error("error during initialization:", error);
        log(`critical error during initialization: ${error.message}`, 'error');
    }
});

// --- update checker (settings tab) ---
function initUpdateChecker() {
    const button = document.getElementById('check-for-updates-button');
    const statusText = document.getElementById('update-status-text');
    const versionLabel = document.getElementById('app-version-label');
    if (!button || !statusText) return;

    let awaitingRestart = false;

    window.electronAPI.getAppVersion().then((version) => {
        if (versionLabel) versionLabel.textContent = `version ${version}`;
    });

    button.addEventListener('click', async () => {
        if (awaitingRestart) {
            window.electronAPI.installUpdate();
            return;
        }
        button.disabled = true;
        statusText.textContent = 'checking for updates...';
        await window.electronAPI.checkForUpdates();
    });

    window.electronAPI.onUpdateStatus((data) => {
        switch (data.status) {
            case 'checking':
                statusText.textContent = 'checking for updates...';
                break;
            case 'available':
                statusText.textContent = `update ${data.version} available, downloading...`;
                window.electronAPI.downloadUpdate();
                break;
            case 'not-available':
                statusText.textContent = 'you are on the latest version.';
                button.disabled = false;
                break;
            case 'downloading':
                statusText.textContent = `downloading update... ${data.percent}%`;
                break;
            case 'downloaded':
                statusText.textContent = 'update downloaded — click below to restart and install.';
                button.innerHTML = '<i class="fas fa-rotate mr-2"></i> restart and install update';
                button.disabled = false;
                awaitingRestart = true;
                break;
            case 'error':
                statusText.textContent = `update check failed: ${data.message}`;
                button.disabled = false;
                break;
        }
    });
}
