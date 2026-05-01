use aegis_protocol::{ProjectSummary, SessionSummary, StoreOverview};
use anyhow::{Context, Result};
use chrono::Utc;
use directories::ProjectDirs;
use sqlx::{sqlite::SqlitePoolOptions, SqlitePool};
use std::path::PathBuf;
use uuid::Uuid;

#[derive(Clone)]
pub struct Store {
    pool: SqlitePool,
    db_path: PathBuf,
}

impl Store {
    pub async fn open_default() -> Result<Self> {
        let dirs =
            ProjectDirs::from("", "", "Aegis").context("could not resolve app data directory")?;
        let data_dir = dirs.data_dir();
        std::fs::create_dir_all(data_dir).context("failed to create Aegis app data directory")?;
        let db_path = data_dir.join("aegis.db");
        let pool = SqlitePoolOptions::new()
            .max_connections(5)
            .connect_with(
                sqlx::sqlite::SqliteConnectOptions::new()
                    .filename(&db_path)
                    .create_if_missing(true),
            )
            .await
            .context("failed to open SQLite database")?;

        let store = Self { pool, db_path };
        store.migrate().await?;
        Ok(store)
    }

    pub fn db_path(&self) -> &PathBuf {
        &self.db_path
    }

    async fn migrate(&self) -> Result<()> {
        for statement in include_str!("../../../migrations/0001_initial.sql").split(';') {
            let statement = statement.trim();
            if !statement.is_empty() {
                sqlx::query(statement).execute(&self.pool).await?;
            }
        }
        Ok(())
    }

    pub async fn create_session(
        &self,
        project_id: Option<&str>,
        model_id: &str,
        title: &str,
    ) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "insert into sessions(id, project_id, title, model_id, started_at, status) values(?1, ?2, ?3, ?4, ?5, 'running')",
        )
        .bind(&id)
        .bind(project_id.unwrap_or("local"))
        .bind(title)
        .bind(model_id)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(id)
    }

    pub async fn add_project(&self, root_path: &str, name: &str) -> Result<ProjectSummary> {
        let root_path = normalize_path_string(root_path);
        let existing = sqlx::query_as::<_, ProjectRow>(
            "select id, name, root_path, preferred_ide, created_at, last_opened_at from projects where root_path = ?1",
        )
        .bind(&root_path)
        .fetch_optional(&self.pool)
        .await?;

        if let Some(project) = existing {
            let now = Utc::now().to_rfc3339();
            sqlx::query("update projects set last_opened_at = ?1 where id = ?2")
                .bind(&now)
                .bind(&project.id)
                .execute(&self.pool)
                .await?;
            return Ok(ProjectSummary {
                last_opened_at: Some(now),
                ..project.into()
            });
        }

        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "insert into projects(id, name, root_path, created_at, last_opened_at) values(?1, ?2, ?3, ?4, ?5)",
        )
        .bind(&id)
        .bind(name)
        .bind(&root_path)
        .bind(&now)
        .bind(&now)
        .execute(&self.pool)
        .await?;

        Ok(ProjectSummary {
            id,
            name: name.to_string(),
            root_path,
            preferred_ide: None,
            created_at: now.clone(),
            last_opened_at: Some(now),
        })
    }

    pub async fn list_projects(&self) -> Result<Vec<ProjectSummary>> {
        let rows = sqlx::query_as::<_, ProjectRow>(
            "select id, name, root_path, preferred_ide, created_at, last_opened_at from projects order by coalesce(last_opened_at, created_at) desc",
        )
        .fetch_all(&self.pool)
        .await?;
        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn list_sessions(&self, project_id: Option<&str>) -> Result<Vec<SessionSummary>> {
        let rows = if let Some(project_id) = project_id {
            sqlx::query_as::<_, SessionRow>(
                "select s.id, s.project_id, s.title, s.model_id, s.started_at, s.finished_at, s.status, t.user_message
                 from sessions s
                 left join turns t on t.session_id = s.id
                 where s.project_id = ?1
                 order by s.started_at desc
                 limit 50",
            )
            .bind(project_id)
            .fetch_all(&self.pool)
            .await?
        } else {
            sqlx::query_as::<_, SessionRow>(
                "select s.id, s.project_id, s.title, s.model_id, s.started_at, s.finished_at, s.status, t.user_message
                 from sessions s
                 left join turns t on t.session_id = s.id
                 order by s.started_at desc
                 limit 50",
            )
            .fetch_all(&self.pool)
            .await?
        };

        Ok(rows.into_iter().map(Into::into).collect())
    }

    pub async fn overview(&self) -> Result<StoreOverview> {
        Ok(StoreOverview {
            sqlite_path: self.db_path.display().to_string(),
            projects: self.count("projects").await?,
            sessions: self.count("sessions").await?,
            turns: self.count("turns").await?,
            tool_calls: self.count("tool_calls").await?,
            proposals: self.count("proposals").await?,
            index_chunks: self.count("index_chunks").await?,
        })
    }

    async fn count(&self, table: &str) -> Result<i64> {
        let query = format!("select count(*) from {table}");
        let count = sqlx::query_scalar::<_, i64>(&query)
            .fetch_one(&self.pool)
            .await?;
        Ok(count)
    }

    pub async fn create_turn(
        &self,
        session_id: &str,
        user_message: &str,
        prompt_fingerprint: &str,
    ) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "insert into turns(id, session_id, user_message, prompt_fingerprint, started_at, status) values(?1, ?2, ?3, ?4, ?5, 'running')",
        )
        .bind(&id)
        .bind(session_id)
        .bind(user_message)
        .bind(prompt_fingerprint)
        .bind(now)
        .execute(&self.pool)
        .await?;
        Ok(id)
    }

    pub async fn finish_turn(&self, turn_id: &str, status: &str) -> Result<()> {
        sqlx::query("update turns set status = ?1, finished_at = ?2 where id = ?3")
            .bind(status)
            .bind(Utc::now().to_rfc3339())
            .bind(turn_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn finish_session(&self, session_id: &str, status: &str) -> Result<()> {
        sqlx::query("update sessions set status = ?1, finished_at = ?2 where id = ?3")
            .bind(status)
            .bind(Utc::now().to_rfc3339())
            .bind(session_id)
            .execute(&self.pool)
            .await?;
        Ok(())
    }

    pub async fn record_tool_call(
        &self,
        turn_id: &str,
        tool_name: &str,
        args_json: &str,
        approved: bool,
        status: &str,
        result_summary: &str,
    ) -> Result<String> {
        let id = Uuid::new_v4().to_string();
        let now = Utc::now().to_rfc3339();
        sqlx::query(
            "insert into tool_calls(id, turn_id, tool_name, args_json, approved, started_at, finished_at, status, result_summary) values(?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
        )
        .bind(&id)
        .bind(turn_id)
        .bind(tool_name)
        .bind(args_json)
        .bind(if approved { 1 } else { 0 })
        .bind(&now)
        .bind(&now)
        .bind(status)
        .bind(result_summary)
        .execute(&self.pool)
        .await?;
        Ok(id)
    }
}

#[derive(sqlx::FromRow)]
struct ProjectRow {
    id: String,
    name: String,
    root_path: String,
    preferred_ide: Option<String>,
    created_at: String,
    last_opened_at: Option<String>,
}

impl From<ProjectRow> for ProjectSummary {
    fn from(row: ProjectRow) -> Self {
        Self {
            id: row.id,
            name: row.name,
            root_path: normalize_path_string(&row.root_path),
            preferred_ide: row.preferred_ide,
            created_at: row.created_at,
            last_opened_at: row.last_opened_at,
        }
    }
}

fn normalize_path_string(path: &str) -> String {
    path.strip_prefix(r"\\?\").unwrap_or(path).to_string()
}

#[derive(sqlx::FromRow)]
struct SessionRow {
    id: String,
    project_id: String,
    title: Option<String>,
    model_id: Option<String>,
    started_at: String,
    finished_at: Option<String>,
    status: String,
    user_message: Option<String>,
}

impl From<SessionRow> for SessionSummary {
    fn from(row: SessionRow) -> Self {
        Self {
            id: row.id,
            project_id: row.project_id,
            title: row.title,
            model_id: row.model_id,
            started_at: row.started_at,
            finished_at: row.finished_at,
            status: row.status,
            user_message: row.user_message,
        }
    }
}
