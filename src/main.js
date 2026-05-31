let db = null;

// Элементы UI
const searchInput = document.getElementById('searchInput');
const categorySelect = document.getElementById('categorySelect');
const forumSelect = document.getElementById('forumSelect');
const limitSelect = document.getElementById('limitSelect');
const tableHeader = document.getElementById('tableHeader');
const tableBody = document.getElementById('tableBody');
const prevBtn = document.getElementById('prevBtn');
const nextBtn = document.getElementById('nextBtn');
const pageInfo = document.getElementById('pageInfo');
const btnBrowseDb = document.getElementById('btnBrowseDb');
const btnSearch = document.getElementById('btnSearch');

const btnAll = document.getElementById('btnAll');
const btnRecent = document.getElementById('btnRecent');
const btnLarge = document.getElementById('btnLarge');
const btnSmall = document.getElementById('btnSmall');
const btnToggleSettings = document.getElementById('btnToggleSettings');
const settingsDropdown = document.getElementById('settingsDropdown');

// Импорт методов Tauri (замена window.__TAURI__)
const { invoke } = window.__TAURI__.core;

// Состояние (State) приложения
let currentSearch = '';
let currentCategory = '';
let currentForum = '';
let currentPreset = 'all';
let currentLimit = 20;
let currentOffset = 0;
let totalRows = 0;
let currentSortBy = 'Дата';
let currentSortOrder = 'desc';

// Ссылка на топик форума вынесена в константу из .env
const forumBaseUrl = "https://rutracker.org";
const forumPageQuery = "/forum/viewtopic.php?t=";
// Склеиваем итоговую константу
const forumTopicLink = forumBaseUrl + forumPageQuery;

// Старт приложения: сразу запрашиваем данные из нашего runtime DuckDB
async function startApplication() {
  await updateTable();
}

// Функция вызова нативного диалога и запуска импорта
async function browseDatabaseFile() {
  const tableBody = document.getElementById('tableBody'); // Убедитесь, что элемент объявлен

  try {
    const selectedFile = await invoke("plugin:dialog|open", {
      options: {
        title: "Выберите исходный файл torrents.db (.db3) для импорта",
        filters: [{ name: "SQLite Database", extensions: ["db", "db3", "sqlite", "sqlite3"] }],
        multiple: false,
        directory: false
      }
    });

    if (selectedFile) {
      // Отображаем шаблон загрузки со спиннером
      const loadingTemplate = document.getElementById('importLoadingTemplate');
      const loadingClone = loadingTemplate.content.cloneNode(true);

      tableBody.innerHTML = ''; // Очищаем таблицу
      tableBody.appendChild(loadingClone); // Вставляем анимированный лоадер

      // Запускаем тяжелый процесс импорта в бэкенде
      const msg = await invoke("import_sqlite", { sqlitePath: selectedFile });
      alert(msg);

      // Сбрасываем пагинацию и обновляем интерфейс
      currentOffset = 0;
      await updateTable();
    }
  } catch (err) {
    // Отображаем шаблон ошибки в случае сбоя
    const errorTemplate = document.getElementById('importErrorTemplate');
    const errorClone = errorTemplate.content.cloneNode(true);

    // Безопасно пишем текст ошибки, защищаясь от XSS
    errorClone.querySelector('[data-field="error-text"]').textContent = err;
    tableBody.innerHTML = '';
    tableBody.appendChild(errorClone);
  }
}

// Запрос данных из DuckDB и перерисовка интерфейса с индикацией и сортировкой
async function updateTable() {
  // Блокируем интерфейс на время запроса
  searchInput.disabled = true;
  btnSearch.disabled = true;

  // шаблон поиска
  const searchingTemplate = document.getElementById('tableSearchingTemplate');
  const searchingClone = searchingTemplate.content.cloneNode(true);
  tableBody.innerHTML = '';
  tableBody.appendChild(searchingClone);

  try {
    const res = await invoke("get_data", {
      search: currentSearch,
      category: currentCategory,
      forum: currentForum,
      preset: currentPreset,
      limit: currentLimit,
      offset: currentOffset,
      sortBy: currentSortBy,
      sortOrder: currentSortOrder
    });

    totalRows = res.total;
    // Заполнение выпадающего списка категорий (если он пуст)
    if (categorySelect.children.length <= 1 && res.categories && res.categories.length > 0) {
      res.categories.forEach(cat => {
        const option = document.createElement('option');
        option.value = cat.code;
        option.textContent = cat.name;
        categorySelect.appendChild(option);
      });
    }

    // Рендерим полученные строки торрентов
    renderTableWithGrouping(res.torrents);
    updateTablePagination();

  } catch (err) {
    // Отображаем шаблон ошибки в случае сбоя
    const errorTemplate = document.getElementById('tableDbErrorTemplate');
    const errorClone = errorTemplate.content.cloneNode(true);

    // Безопасно выводим текст ошибки через textContent
    errorClone.querySelector('[data-field="error-text"]').textContent = err;

    tableBody.innerHTML = '';
    tableBody.appendChild(errorClone);
  } finally {
    // Разблокируем интерфейс в любом случае
    searchInput.disabled = false;
    btnSearch.disabled = false;
    searchInput.focus();
  }
}

// Загрузка форумов из реальной БД через DuckDB
// Загрузка форумов из реальной БД через DuckDB
async function updateForumsList() {
  const selectElement = document.getElementById('forumSelect');
  const template = document.getElementById('forumOptionTemplate');

  if (!selectElement || !template) return;

  try {
    // Сохраняем текущий выбранный форум, чтобы он не сбрасывался при обновлении списка
    const previousSelectedForum = selectElement.value;

    selectElement.innerHTML = '<option value="">Все форумы</option>';

    // Вызываем новую быструю команду Rust
    const forums = await invoke("get_forums_by_category", {
      category: currentCategory
    });

    if (forums && forums.length > 0) {
      const fragment = document.createDocumentFragment();

      forums.forEach(forumName => {
        const clone = template.content.cloneNode(true);
        const option = clone.querySelector('[data-field="forum-item"]');

        option.value = forumName;
        option.textContent = forumName;

        fragment.appendChild(clone);
      });

      selectElement.appendChild(fragment);

      // Возвращаем фокус на ранее выбранный форум, если он все еще есть в списке
      selectElement.value = previousSelectedForum;
    }
  } catch (err) {
    console.error("Ошибка обновления списка форумов:", err);
  }
}


// Отрисовка HTML строк таблицы (Чистые 4 колонки, без действий)
function renderTableWithGrouping(torrents) {
  // Обработка пустого результата через шаблон
  if (!torrents || torrents.length === 0) {
    const emptyTemplate = document.getElementById('tableEmptyTemplate');
    tableBody.innerHTML = '';
    tableBody.appendChild(emptyTemplate.content.cloneNode(true));
    return;
  }

  const visibleHeaders = ['Название торрента', 'Размер', 'Дата', 'Форум'];
  const columnClasses = ['col-title', 'col-size', 'col-date', 'col-forum'];

  // Отрисовка заголовков таблицы (остается на чистом DOM, так как структура динамическая)
  if (tableHeader.children.length === 0) {
    visibleHeaders.forEach((col, idx) => {
      const th = document.createElement('th');
      th.textContent = col;
      th.className = columnClasses[idx];
      th.textContent += (currentSortBy === col ? (currentSortOrder === 'asc' ? ' 🔼' : ' 🔽') : '');

      th.addEventListener('click', () => {
        currentSortOrder = (currentSortBy === col) ? (currentSortOrder === 'asc' ? 'desc' : 'asc') : 'asc';
        currentSortBy = col;
        tableHeader.innerHTML = '';
        updateTable();
      });
      tableHeader.appendChild(th);
    });
  }
  // Очищаем таблицу перед наполнением
  tableBody.innerHTML = '';

  const fragment = document.createDocumentFragment();
  const categoryTemplate = document.getElementById('tableCategoryGroupTemplate');
  const rowTemplate = document.getElementById('tableDataRowTemplate');

  let lastCategory = null;
  let dataRowIndex = 0; // Наш счетчик строк внутри текущей категории

  torrents.forEach(row => {
    const currentCategoryName = row.category || 'Без категории';

    // Рендеринг разделителя категории
    if (currentCategoryName !== lastCategory) {
      const catClone = categoryTemplate.content.cloneNode(true);
      const catCell = catClone.querySelector('[data-field="category-name"]');

      catCell.colSpan = visibleHeaders.length;
      catCell.textContent = '📁 Категория: ' + currentCategoryName;

      fragment.appendChild(catClone);
      lastCategory = currentCategoryName;

      // Теперь первая раздача в ЛЮБОЙ категории ВСЕГДА будет светлой (белой)
      dataRowIndex = 0;
    }

    // Рендеринг строки данных торрента
    const rowClone = rowTemplate.content.cloneNode(true);
    const trElement = rowClone.querySelector('.data-row');

    // Логика распределения цветов:
    // dataRowIndex = 0 (четный шаг по счету, % 2 === 0) -> row-odd (белый)
    // dataRowIndex = 1 (нечетный шаг по счету, % 2 === 1) -> row-even (серый)
    if (dataRowIndex % 2 === 1) {
      trElement.classList.add('row-even'); // Серый фон
    } else {
      trElement.classList.add('row-odd');  // Белый фон
    }
    dataRowIndex++; // Увеличиваем индекс только для раздач

    // Заполнение данных
    const aLink = rowClone.querySelector('[data-field="title"]');
    aLink.textContent = row.title;
    aLink.title = row.title;
    aLink.addEventListener('click', (e) => {
      e.preventDefault();
      showTorrentDetails(row);
    });

    rowClone.querySelector('[data-field="size"]').textContent = row.size;
    rowClone.querySelector('[data-field="forum"]').textContent = row.forum;

    const dateCell = rowClone.querySelector('[data-field="date"]');
    if (row.date) {
      dateCell.textContent = row.date.toString().slice(0, 16).replace(/-/g, '.');
    } else {
      dateCell.textContent = '';
    }

    fragment.appendChild(rowClone);
  });

  tableBody.appendChild(fragment);

}


// Показ детальной карточки раздачи
function showTorrentDetails(torrent) {
  const listViewContainer = document.getElementById('listViewContainer');
  const detailsViewContainer = document.getElementById('detailsViewContainer');

  // Скрываем список
  listViewContainer.style.display = 'none';
  detailsViewContainer.style.display = 'flex';

  // Готовим данные
  const cleanHash = torrent.hash.toLowerCase();
  const magnetQuery = "magnet:?xt=urn:btih:" + cleanHash;
  const webUrl = forumTopicLink + torrent.id;

  //  Получаем шаблон из HTML и клонируем его
  const template = document.getElementById('torrentDetailsTemplate');
  const clone = template.content.cloneNode(true);

  //  Безопасно заполняем текстовые поля (защита от инъекций кода в torrent.title)
  clone.querySelector('[data-field="title"]').textContent = torrent.title;
  clone.querySelector('[data-field="id"]').textContent = torrent.id;
  clone.querySelector('[data-field="hash"]').textContent = cleanHash;
  clone.querySelector('[data-field="size"]').textContent = torrent.size;
  //clone.querySelector('[data-field="date"]').textContent = torrent.date;
  // Заменяем строчку заполнения даты в функции showTorrentDetails:
  if (torrent.date) {
    // Приводим к объекту даты (заменяем точки на дефисы, чтобы JS гарантированно её распарсил)
    const dateObj = new Date(torrent.date.toString().replace(/\./g, '-'));

    if (!isNaN(dateObj)) {
      // Встроенный российский формат без секунд
      const ruFormatter = new Intl.DateTimeFormat('ru-RU', {
        day: '2-digit',
        month: '2-digit',
        year: 'numeric',
        hour: '2-digit',
        minute: '2-digit'
      });
      clone.querySelector('[data-field="date"]').textContent = ruFormatter.format(dateObj);
    } else {
      clone.querySelector('[data-field="date"]').textContent = torrent.date;
    }
  } else {
    clone.querySelector('[data-field="date"]').textContent = '';
  }


  clone.querySelector('[data-field="forum"]').textContent = torrent.forum;
  clone.querySelector('[data-field="category"]').textContent = torrent.category;

  // Находим кнопки внутри клонированного фрагмента
  const btnBack = clone.querySelector('[data-action="back"]');
  const btnMagnet = clone.querySelector('[data-action="magnet"]');
  const btnCopy = clone.querySelector('[data-action="copy"]');
  const btnWeb = clone.querySelector('[data-action="web"]');

  // Навешиваем обработчики событий Tauri
  btnBack.addEventListener('click', function () {
    detailsViewContainer.style.display = 'none';
    listViewContainer.style.display = 'flex';
  });

  btnMagnet.addEventListener('click', async function () {
    try {
      await invoke("plugin:opener|open_url", { url: magnetQuery });
    } catch (e) { console.error(e); }
  });

  btnCopy.addEventListener('click', async function () {
    try {
      await invoke("plugin:clipboard-manager|write_text", { text: magnetQuery });
    } catch (e) {
      navigator.clipboard.writeText(magnetQuery);
    }
    const oldText = btnCopy.textContent;
    btnCopy.textContent = '✅ Скопирован';
    setTimeout(() => { btnCopy.textContent = oldText; }, 1200);
  });

  btnWeb.addEventListener('click', async function () {
    try {
      await invoke("plugin:opener|open_url", { url: webUrl });
    } catch (err) { console.error(err); }
  });

  // Очищаем контейнер и вставляем готовый DOM-элемент
  detailsViewContainer.innerHTML = '';
  detailsViewContainer.appendChild(clone);

  // Показываем контейнер
  detailsViewContainer.style.display = 'block';
}

// Обновление пагинации с использованием шаблона
function updateTablePagination() {
  const currentPage = Math.floor(currentOffset / currentLimit) + 1;
  const maxPage = Math.ceil(totalRows / currentLimit) || 1;

  // Получаем и клонируем шаблон информации о страницах
  const template = document.getElementById('paginationInfoTemplate');
  const clone = template.content.cloneNode(true);

  // Безопасно заполняем только числовые показатели
  clone.querySelector('[data-field="current"]').textContent = currentPage;
  clone.querySelector('[data-field="max"]').textContent = maxPage;
  clone.querySelector('[data-field="total"]').textContent = totalRows;

  //  Очищаем контейнер и вставляем готовый DOM-фрагмент
  pageInfo.innerHTML = '';
  pageInfo.appendChild(clone);

  // Управляем активностью кнопок (стили подтянутся из CSS автоматически)
  prevBtn.disabled = (currentOffset === 0);
  nextBtn.disabled = (currentOffset + currentLimit >= totalRows);
}

function setActivePresetButton(activeButton) {
  [btnAll, btnRecent, btnLarge, btnSmall].forEach(btn => btn.classList.remove('active-preset'));
  activeButton.classList.add('active-preset');
}

async function executeSearch() {
  currentSearch = searchInput.value;
  currentOffset = 0;
  // Вместо ручной перезаписи текста кнопке вешается класс спиннера
  btnSearch.classList.add('btn-search-loading');
  try {
    await updateTable();
  } catch (err) {
    console.error(err);
  } finally {
    // Убираем спиннер, оригинальный текст кнопки ("Поиск") возвращается сам
    btnSearch.classList.remove('btn-search-loading');
  }
}

// --- НАВЕШИВАНИЕ СОБЫТИЙ ---
btnToggleSettings.addEventListener('click', (e) => {
  e.stopPropagation();
  settingsDropdown.classList.toggle('show');
});

document.addEventListener('click', (e) => {
  if (!settingsDropdown.contains(e.target) && e.target !== btnToggleSettings) {
    settingsDropdown.classList.remove('show');
  }
});

categorySelect.addEventListener('change', async (e) => {
  currentCategory = e.target.value;
  currentForum = '';
  currentOffset = 0;
  await updateForumsList();
  await updateTable();
});

forumSelect.addEventListener('change', async (e) => {
  currentForum = e.target.value;
  currentOffset = 0;
  await updateTable();
});

btnSearch.addEventListener('click', executeSearch);
searchInput.addEventListener('keydown', async (e) => { if (e.key === 'Enter') { await executeSearch(); } });
btnBrowseDb.addEventListener('click', browseDatabaseFile);
limitSelect.addEventListener('change', (e) => { currentLimit = parseInt(e.target.value, 10); currentOffset = 0; updateTable(); });
prevBtn.addEventListener('click', () => { currentOffset = Math.max(0, currentOffset - currentLimit); updateTable(); });
nextBtn.addEventListener('click', () => { if (currentOffset + currentLimit < totalRows) { currentOffset += currentLimit; updateTable(); } });
btnAll.addEventListener('click', () => { currentPreset = 'all'; currentOffset = 0; setActivePresetButton(btnAll); updateTable(); });
btnRecent.addEventListener('click', () => { currentPreset = 'recent'; currentOffset = 0; setActivePresetButton(btnRecent); updateTable(); });
btnLarge.addEventListener('click', () => { currentPreset = 'large'; currentOffset = 0; setActivePresetButton(btnLarge); updateTable(); });
btnSmall.addEventListener('click', () => { currentPreset = 'small'; currentOffset = 0; setActivePresetButton(btnSmall); updateTable(); });


startApplication();

