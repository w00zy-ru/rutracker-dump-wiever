use duckdb::Connection;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use tauri::{AppHandle, Manager};

#[derive(Serialize, Deserialize, Clone)]
pub struct TorrentRow {
    id: i64,
    hash: String,
    title: String,
    size: String,
    date: String,
    forum: String,
    category: String,
}

// Получение пути к локальной базе данных DuckDB в папке приложения
fn get_db_path(app: &AppHandle) -> PathBuf {
    let mut path = app.path().app_data_dir().unwrap_or_default();
    let _ = fs::create_dir_all(&path);
    path.push("tau_infotor.duckdb");
    path
}

// Инициализация структуры таблиц базы данных
fn init_duckdb_schema(conn: &Connection) -> Result<(), duckdb::Error> {
    conn.execute_batch(
        "CREATE TABLE IF NOT EXISTS category (code_category INTEGER PRIMARY KEY, name_category TEXT, load_category BOOLEAN);
         CREATE TABLE IF NOT EXISTS forum (code_forum INTEGER PRIMARY KEY, name_forum TEXT, category_id INTEGER);
         CREATE TABLE IF NOT EXISTS torrent (file_id BIGINT PRIMARY KEY, hash_info TEXT, title TEXT, size_b BIGINT, date_reg TEXT, forum_id INTEGER);",
    )
}

#[tauri::command]
async fn import_sqlite(app: AppHandle, sqlite_path: PathBuf) -> Result<String, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
    init_duckdb_schema(&conn).map_err(|e| e.to_string())?;

    // Безопасное экранирование одинарных кавычек в системном пути файла
    let safe_sqlite_path = sqlite_path.to_string_lossy().replace('\'', "''");

    // Пакетный перенос данных внутри единой быстрой транзакции
    let import_query = format!(
        "INSTALL sqlite; LOAD sqlite;
         ATTACH '{}' AS sqlite_db (TYPE SQLITE);
         BEGIN TRANSACTION;
         INSERT OR IGNORE INTO category SELECT * FROM sqlite_db.category;
         INSERT OR IGNORE INTO forum SELECT * FROM sqlite_db.forum;
         INSERT OR IGNORE INTO torrent SELECT * FROM sqlite_db.torrent;
         COMMIT;
         DETACH sqlite_db;",
        safe_sqlite_path
    );

    conn.execute_batch(&import_query)
        .map_err(|e| format!("Ошибка выполнения SQL-импорта: {}", e))?;

    Ok("Импорт успешно завершен!".to_string())
}

#[tauri::command]
async fn get_forums_by_category(
    app: AppHandle,
    category: String,
) -> Result<serde_json::Value, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;

    let mut query = "SELECT name_forum FROM forum WHERE name_forum IS NOT NULL".to_string();
    let mut params: Vec<String> = Vec::new();

    // Если категория выбрана, фильтруем форумы по ней
    if !category.is_empty() {
        query.push_str(" AND category_id = ?");
        params.push(category);
    }
    query.push_str(" ORDER BY name_forum ASC");

    let mut stmt = conn.prepare(&query).map_err(|e| e.to_string())?;
    let param_slices: Vec<&str> = params.iter().map(|s| s.as_str()).collect();

    let rows = stmt
        .query_map(duckdb::params_from_iter(param_slices.iter()), |row| {
            row.get::<_, String>(0)
        })
        .map_err(|e| e.to_string())?;

    let forums: Vec<String> = rows.filter_map(|r| r.ok()).collect();
    Ok(serde_json::json!(forums))
}

#[tauri::command]
async fn get_data(
    app: AppHandle,
    search: String,
    category: String,
    forum: String,
    preset: String,
    limit: u32,
    offset: u32,
    sort_by: String,
    sort_order: String,
) -> Result<serde_json::Value, String> {
    let db_path = get_db_path(&app);
    let conn = Connection::open(&db_path).map_err(|e| e.to_string())?;
    init_duckdb_schema(&conn).map_err(|e| e.to_string())?;

    // Динамическая сборка фильтров и массива параметров для защиты от SQL-инъекций
    let mut filter_conditions = " WHERE 1=1 ".to_string();
    let mut query_params: Vec<String> = Vec::new();

    if !search.is_empty() {
        filter_conditions.push_str(" AND t.title ILIKE ? ");
        query_params.push(format!("%{}%", search));
    }
    if !category.is_empty() {
        filter_conditions.push_str(" AND c.code_category = ? ");
        query_params.push(category);
    }
    if !forum.is_empty() {
        // Так как из JS передается текстовое название форума, фильтруем по name_forum
        filter_conditions.push_str(" AND f.name_forum = ? ");
        query_params.push(forum);
    }

    // Обработка встроенных пресетов приложения
    if preset == "recent" {
        filter_conditions
            .push_str(" AND CAST(t.date_reg AS TIMESTAMP) >= CURRENT_DATE - INTERVAL 30 DAY ");
    } else if preset == "large" {
        filter_conditions.push_str(" AND t.size_b > 10737418240 "); // Больше 10 ГБ
    } else if preset == "small" {
        filter_conditions.push_str(" AND t.size_b < 524288000 "); // Меньше 500 МБ
    }

    let from_clause = " FROM torrent t 
                        LEFT JOIN forum f ON t.forum_id = f.code_forum 
                        LEFT JOIN category c ON f.category_id = c.code_category ";

    // 1. Подсчет общего количества строк (для пагинации на фронтенде)
    let count_query = format!("SELECT COUNT(*){}{}", from_clause, filter_conditions);
    let mut count_stmt = conn.prepare(&count_query).map_err(|e| e.to_string())?;

    // Преобразуем вектор String в слайс ссылок для DuckDB params_from_iter
    let param_slices: Vec<&str> = query_params.iter().map(|s| s.as_str()).collect();

    let total: i64 = count_stmt
        .query_row(duckdb::params_from_iter(param_slices.iter()), |row| {
            row.get(0)
        })
        .unwrap_or(0);

    // Валидация направления и поля сортировки
    let sql_order_field = match sort_by.as_str() {
        "Название торрента" => "t.title",
        "Размер" => "t.size_b",
        "Форум" => "f.name_forum",
        _ => "t.date_reg",
    };
    let order_direction = if sort_order.to_lowercase() == "asc" {
        "ASC"
    } else {
        "DESC"
    };

    // 2. Основной запрос получения пачки строк данных
    let data_query = format!(
        "SELECT t.file_id, t.hash_info, t.title, 
         CASE WHEN t.size_b >= 1073741824 THEN ROUND(t.size_b / 1073741824.0, 2) || ' ГБ' ELSE ROUND(t.size_b / 1048576.0, 2) || ' МБ' END,
         t.date_reg, f.name_forum, c.name_category 
         {} {} ORDER BY {} {} LIMIT {} OFFSET {}",
        from_clause, filter_conditions, sql_order_field, order_direction, limit, offset
    );

    let mut stmt = conn.prepare(&data_query).map_err(|e| e.to_string())?;
    let rows = stmt
        .query_map(duckdb::params_from_iter(param_slices.iter()), |row| {
            Ok(TorrentRow {
                id: row.get(0)?,
                hash: row.get(1)?,
                title: row.get(2)?,
                size: row.get(3)?,
                date: row.get(4)?,
                forum: row.get(5)?,
                category: row.get(6)?,
            })
        })
        .map_err(|e| e.to_string())?;

    // Сборка коллекции отфильтрованных торрентов
    let torrents: Vec<TorrentRow> = rows.filter_map(|r| r.ok()).collect();

    // 3. Выборка уникальных категорий для выпадающего списка
    let mut cat_stmt = conn
        .prepare("SELECT code_category, name_category FROM category WHERE name_category IS NOT NULL ORDER BY name_category ASC")
        .map_err(|e| e.to_string())?;

    let cat_rows = cat_stmt
        .query_map([], |row| {
            Ok(serde_json::json!({
                "code": row.get::<_, i64>(0)?.to_string(),
                "name": row.get::<_, String>(1)?
            }))
        })
        .map_err(|e| e.to_string())?;

    let categories: Vec<_> = cat_rows.filter_map(|r| r.ok()).collect();

    // Возвращаем итоговый JSON пакет на фронтенд
    Ok(serde_json::json!({ "total": total, "torrents": torrents, "categories": categories }))
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    #[cfg(target_os = "linux")]
    {
        std::env::set_var("WEBKIT_DISABLE_DMABUF_RENDERER", "1");
    }

    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_clipboard_manager::init())
        .setup(|app| {
            if let Some(window) = app.get_webview_window("main") {
                if let Some(icon) = app.default_window_icon() {
                    let _ = window.set_icon(icon.clone());
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            import_sqlite,
            get_data,
            get_forums_by_category
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
