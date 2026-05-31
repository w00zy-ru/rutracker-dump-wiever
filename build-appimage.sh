#!/bin/bash
# Останавливаем скрипт, если любая команда завершится ошибкой
set -e

# Автоматически считываем актуальную версию из package.json
VERSION=$(node -p "require('./package.json').version")
echo "Текущая версия приложения: $VERSION"

#  Очищаем старый кэш компиляции Rust, чтобы применился свежий JS/HTML код
echo "Полная очистка старого кэша сборки..."
#cd src-tauri && cargo clean && cd ..

# 3. Собираем свежий фронтенд (HTML/CSS/JS)
#npm run build 2>/dev/null || true

echo "Компиляция чистого бинарника"
# Флаг --no-bundle гарантирует, что Tauri просто соберет готовый исполняемый файл и не упадет
#WEBKIT_DISABLE_DMABUF_RENDERER=1 npm run tauri build -- --no-bundle


# Конфигурация путей к файлам
BIN_SOURCE="src-tauri/target/release/infotor-tau"
APPDIR_DIR="src-tauri/target/release/bundle/appimage/infotor-tau.AppDir"
TARGET_DIR="src-tauri/target/release/bundle/appimage"
SRC_ICON="src-tauri/icons/infotor-tau.png"

echo "Создание структуры AppDir с нуля..."
rm -rf "$APPDIR_DIR"
mkdir -p "$APPDIR_DIR/usr/bin"
mkdir -p "$APPDIR_DIR/usr/share/applications"
mkdir -p "$APPDIR_DIR/usr/share/icons/hicolor/128x128/apps"

echo "Копирование скомпилированного бинарника и иконки..."
cp "$BIN_SOURCE" "$APPDIR_DIR/infotor-tau"
cp "$BIN_SOURCE" "$APPDIR_DIR/usr/bin/infotor-tau"
cp "$SRC_ICON" "$APPDIR_DIR/.DirIcon"
cp "$SRC_ICON" "$APPDIR_DIR/infotor-tau.png"
cp "$SRC_ICON" "$APPDIR_DIR/usr/share/icons/hicolor/128x128/apps/infotor-tau.png"

echo "Генерация .desktop файла конфигурации..."
cat <<EOF > "$APPDIR_DIR/infotor-tau.desktop"
[Desktop Entry]
Type=Application
Name=infotor-tau
Exec=infotor-tau
Icon=infotor-tau
Comment=SQLite and DuckDB Torrent Dump Viewer
Categories=Utility;
Terminal=false
StartupWMClass=infotor-tau
EOF

cp "$APPDIR_DIR/infotor-tau.desktop" "$APPDIR_DIR/usr/share/applications/infotor-tau.desktop"

echo "Создание обязательного скрипта запуска AppRun..."
# Этот файл является точкой входа для AppImage. Он запускает наш бинарник.
cat <<'EOF' > "$APPDIR_DIR/AppRun"
#!/bin/sh
SELF=$(readlink -f "$0")
HERE=$(dirname "$SELF")
export PATH="${HERE}/usr/bin:${PATH}"
exec "${HERE}/usr/bin/infotor-tau" "$@"
EOF

# Делаем AppRun исполняемым (критически важно!)
chmod +x "$APPDIR_DIR/AppRun"

echo "Упаковка в AppImage с помощью системного appimagetool..."
mkdir -p "$TARGET_DIR"
VERSION=$VERSION appimagetool "$APPDIR_DIR" "$TARGET_DIR/infotor-tau_${VERSION}_amd64.AppImage"

echo "Cборка завершена: $TARGET_DIR/infotor-tau_${VERSION}_amd64.AppImage"
