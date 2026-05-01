use aegis_protocol::{GitBranchInfo, GitWorktreeInfo, ProjectSearchMatch};
use anyhow::{bail, Context, Result};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::process::Command;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GitStatus {
    pub stdout: String,
    pub stderr: String,
    pub success: bool,
}

pub async fn git_status(project_root: &Path) -> Result<GitStatus> {
    ensure_project_root(project_root)?;
    let output = Command::new("git")
        .arg("status")
        .arg("--short")
        .current_dir(project_root)
        .output()
        .await
        .context("failed to run git status")?;

    Ok(GitStatus {
        stdout: String::from_utf8_lossy(&output.stdout).to_string(),
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        success: output.status.success(),
    })
}

pub async fn git_diff(project_root: &Path) -> Result<GitStatus> {
    ensure_project_root(project_root)?;
    let output = Command::new("git")
        .arg("diff")
        .arg("HEAD")
        .arg("--")
        .current_dir(project_root)
        .output()
        .await
        .context("failed to run git diff")?;
    let mut stdout = String::from_utf8_lossy(&output.stdout).to_string();
    stdout.push_str(&untracked_file_diff(project_root).await?);

    Ok(GitStatus {
        stdout,
        stderr: String::from_utf8_lossy(&output.stderr).to_string(),
        success: output.status.success(),
    })
}

async fn untracked_file_diff(project_root: &Path) -> Result<String> {
    let output = Command::new("git")
        .args(["ls-files", "--others", "--exclude-standard"])
        .current_dir(project_root)
        .output()
        .await
        .context("failed to list untracked files")?;
    if !output.status.success() {
        return Ok(String::new());
    }

    let mut diff = String::new();
    for relative in String::from_utf8_lossy(&output.stdout)
        .lines()
        .map(str::trim)
        .filter(|line| !line.is_empty())
    {
        let path = project_root.join(relative);
        if !path.is_file() || is_probably_binary_or_large(&path)? {
            continue;
        }
        let Ok(content) = std::fs::read_to_string(&path) else {
            continue;
        };
        let display = relative.replace('\\', "/");
        diff.push_str(&format!(
            "\ndiff --git a/{display} b/{display}\nnew file mode 100644\n--- /dev/null\n+++ b/{display}\n@@ -0,0 +1,{} @@\n",
            content.lines().count()
        ));
        for line in content.lines() {
            diff.push('+');
            diff.push_str(line);
            diff.push('\n');
        }
    }
    Ok(diff)
}

pub async fn git_branches(project_root: &Path) -> Result<GitBranchInfo> {
    ensure_project_root(project_root)?;
    let current = Command::new("git")
        .args(["branch", "--show-current"])
        .current_dir(project_root)
        .output()
        .await
        .context("failed to read current git branch")?;
    let branches = Command::new("git")
        .args(["branch", "--format=%(refname:short)"])
        .current_dir(project_root)
        .output()
        .await
        .context("failed to list git branches")?;

    Ok(GitBranchInfo {
        current: String::from_utf8_lossy(&current.stdout)
            .trim()
            .to_string()
            .split_once('\n')
            .map(|(first, _)| first.to_string())
            .or_else(|| {
                let value = String::from_utf8_lossy(&current.stdout).trim().to_string();
                (!value.is_empty()).then_some(value)
            }),
        branches: String::from_utf8_lossy(&branches.stdout)
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
            .map(ToOwned::to_owned)
            .collect(),
    })
}

pub async fn git_worktrees(project_root: &Path) -> Result<Vec<GitWorktreeInfo>> {
    ensure_project_root(project_root)?;
    let output = Command::new("git")
        .args(["worktree", "list", "--porcelain"])
        .current_dir(project_root)
        .output()
        .await
        .context("failed to list git worktrees")?;
    if !output.status.success() {
        bail!("{}", String::from_utf8_lossy(&output.stderr));
    }
    Ok(parse_worktrees(&String::from_utf8_lossy(&output.stdout)))
}

pub async fn git_create_worktree(
    project_root: &Path,
    branch: &str,
    new_branch: &str,
    worktree_name: Option<&str>,
) -> Result<GitWorktreeInfo> {
    ensure_project_root(project_root)?;
    let parent = project_root
        .parent()
        .context("project root has no parent directory")?;
    let safe_branch = new_branch
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect::<String>();
    let safe_name = worktree_name
        .unwrap_or_else(|| safe_branch.trim_matches('-'))
        .chars()
        .map(|ch| {
            if ch.is_ascii_alphanumeric() || ch == '-' {
                ch
            } else {
                '-'
            }
        })
        .collect::<String>();
    let base = if project_root
        .file_name()
        .and_then(|name| name.to_str())
        .is_some_and(|name| name.eq_ignore_ascii_case("Aegis"))
    {
        parent.join("Aegis-worktrees")
    } else {
        parent.join("Aegis")
    };
    let worktree_dir = base.join(safe_name.trim_matches('-'));
    if worktree_dir.exists() {
        bail!("worktree path already exists: {}", worktree_dir.display());
    }
    std::fs::create_dir_all(worktree_dir.parent().unwrap_or(parent))?;
    let output = Command::new("git")
        .args([
            "worktree",
            "add",
            "-b",
            new_branch,
            worktree_dir
                .to_str()
                .context("worktree path is not valid UTF-8")?,
            branch,
        ])
        .current_dir(project_root)
        .output()
        .await
        .context("failed to create git worktree")?;
    if !output.status.success() {
        bail!("{}", String::from_utf8_lossy(&output.stderr));
    }
    Ok(GitWorktreeInfo {
        path: worktree_dir.display().to_string(),
        branch: Some(new_branch.to_string()),
        commit: None,
    })
}

pub fn lexical_search(
    project_root: &Path,
    query: &str,
    limit: usize,
) -> Result<Vec<ProjectSearchMatch>> {
    ensure_project_root(project_root)?;
    let query = query.trim().to_lowercase();
    if query.is_empty() {
        return Ok(Vec::new());
    }

    let mut matches = Vec::new();
    search_dir(
        project_root,
        project_root,
        &query,
        limit.max(1).min(50),
        &mut matches,
    )?;
    Ok(matches)
}

pub fn read_text_file(project_root: &Path, file: &Path, max_bytes: usize) -> Result<String> {
    ensure_project_root(project_root)?;
    let full_path = if file.is_absolute() {
        file.to_path_buf()
    } else {
        project_root.join(file)
    };
    let full_path = full_path
        .canonicalize()
        .with_context(|| format!("file does not exist: {}", full_path.display()))?;
    if !full_path.starts_with(project_root.canonicalize()?) {
        bail!("file is outside project root");
    }
    if is_probably_binary_or_large(&full_path)? {
        bail!("file is binary or too large for inline reading");
    }
    let mut content = std::fs::read_to_string(&full_path)?;
    if content.len() > max_bytes {
        content.truncate(max_bytes);
        content.push_str("\n[truncated]");
    }
    Ok(content)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IdeInstall {
    pub id: String,
    pub label: String,
    pub command: String,
}

pub fn detect_ides() -> Vec<IdeInstall> {
    let mut installs: Vec<IdeInstall> = Vec::new();

    if let Some(explorer) = detect_file_explorer() {
        installs.push(IdeInstall {
            id: "explorer".to_string(),
            label: "File Explorer".to_string(),
            command: explorer.display().to_string(),
        });
    }

    if let Some(code) = detect_vscode() {
        installs.push(IdeInstall {
            id: "code".to_string(),
            label: "VS Code".to_string(),
            command: code.display().to_string(),
        });
    }

    installs.extend(["devenv", "clion"].into_iter().filter_map(|command| {
        let found = which_like(command)?;
        Some(IdeInstall {
            id: command.to_string(),
            label: match command {
                "code" => "VS Code",
                "devenv" => "Visual Studio",
                "clion" => "CLion",
                _ => command,
            }
            .to_string(),
            command: found.display().to_string(),
        })
    }));

    if !installs.iter().any(|install| install.id == "devenv") {
        if let Some(devenv) = detect_visual_studio_with_vswhere() {
            installs.push(IdeInstall {
                id: "devenv".to_string(),
                label: "Visual Studio".to_string(),
                command: devenv.display().to_string(),
            });
        }
    }

    installs
}

pub async fn open_project(command: &str, project_root: &Path) -> Result<()> {
    ensure_project_root(project_root)?;
    Command::new(command)
        .arg(project_root)
        .spawn()
        .with_context(|| format!("failed to open project with {command}"))?;
    Ok(())
}

pub async fn open_file(
    ide_id: &str,
    command: &str,
    project_root: &Path,
    file: &Path,
    line: Option<u32>,
) -> Result<()> {
    ensure_project_root(project_root)?;
    let full_path = if file.is_absolute() {
        file.to_path_buf()
    } else {
        project_root.join(file)
    };
    let full_path = full_path
        .canonicalize()
        .with_context(|| format!("file does not exist: {}", full_path.display()))?;

    if !full_path.starts_with(project_root.canonicalize()?) {
        bail!("file is outside project root");
    }

    let mut command_builder = Command::new(command);
    if ide_id == "explorer" {
        command_builder.arg(format!("/select,{}", full_path.display()));
    } else if ide_id == "code" {
        if let Some(line) = line {
            command_builder
                .arg("-g")
                .arg(format!("{}:{line}", full_path.display()));
        } else {
            command_builder.arg(full_path);
        }
    } else {
        command_builder.arg(full_path);
    }

    command_builder
        .spawn()
        .with_context(|| format!("failed to open file with {command}"))?;
    Ok(())
}

fn ensure_project_root(project_root: &Path) -> Result<()> {
    if !project_root.exists() {
        bail!("project root does not exist");
    }
    if !project_root.is_dir() {
        bail!("project root is not a directory");
    }
    Ok(())
}

fn search_dir(
    project_root: &Path,
    dir: &Path,
    query: &str,
    limit: usize,
    matches: &mut Vec<ProjectSearchMatch>,
) -> Result<()> {
    if matches.len() >= limit {
        return Ok(());
    }

    for entry in
        std::fs::read_dir(dir).with_context(|| format!("failed to read {}", dir.display()))?
    {
        let entry = entry?;
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if should_skip(&name, &path) {
            continue;
        }
        if path.is_dir() {
            search_dir(project_root, &path, query, limit, matches)?;
            continue;
        }
        if !path.is_file() || is_probably_binary_or_large(&path)? {
            continue;
        }

        let content = match std::fs::read_to_string(&path) {
            Ok(content) => content,
            Err(_) => continue,
        };

        for (index, line) in content.lines().enumerate() {
            if line.to_lowercase().contains(query) {
                let relative = path
                    .strip_prefix(project_root)
                    .unwrap_or(&path)
                    .display()
                    .to_string();
                matches.push(ProjectSearchMatch {
                    path: relative,
                    line: index + 1,
                    snippet: line.trim().chars().take(240).collect(),
                });
                if matches.len() >= limit {
                    return Ok(());
                }
            }
        }
    }

    Ok(())
}

fn should_skip(name: &str, path: &Path) -> bool {
    matches!(
        name,
        ".git" | "node_modules" | "vendor" | ".venv" | "dist" | "build" | "target" | "__pycache__"
    ) || name.ends_with(".lock")
        || name.ends_with(".min.js")
        || path.components().any(|component| {
            let part = component.as_os_str().to_string_lossy();
            matches!(part.as_ref(), ".git" | "node_modules" | "target" | "dist")
        })
}

fn is_probably_binary_or_large(path: &Path) -> Result<bool> {
    let metadata = std::fs::metadata(path)?;
    if metadata.len() > 512 * 1024 {
        return Ok(true);
    }
    Ok(matches!(
        path.extension()
            .and_then(|extension| extension.to_str())
            .unwrap_or(""),
        "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "webp"
            | "ico"
            | "pdf"
            | "zip"
            | "gz"
            | "exe"
            | "dll"
            | "pdb"
    ))
}

fn parse_worktrees(output: &str) -> Vec<GitWorktreeInfo> {
    let mut rows = Vec::new();
    let mut current: Option<GitWorktreeInfo> = None;
    for line in output.lines() {
        if let Some(path) = line.strip_prefix("worktree ") {
            if let Some(row) = current.take() {
                rows.push(row);
            }
            current = Some(GitWorktreeInfo {
                path: path.to_string(),
                branch: None,
                commit: None,
            });
        } else if let Some(commit) = line.strip_prefix("HEAD ") {
            if let Some(row) = &mut current {
                row.commit = Some(commit.to_string());
            }
        } else if let Some(branch) = line.strip_prefix("branch refs/heads/") {
            if let Some(row) = &mut current {
                row.branch = Some(branch.to_string());
            }
        }
    }
    if let Some(row) = current {
        rows.push(row);
    }
    rows
}

fn which_like(command: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    for entry in std::env::split_paths(&path) {
        #[cfg(windows)]
        {
            let candidate = entry.join(format!("{command}.cmd"));
            if candidate.is_file() {
                return Some(candidate);
            }
            let candidate = entry.join(format!("{command}.exe"));
            if candidate.is_file() {
                return Some(candidate);
            }
        }
        let candidate = entry.join(command);
        if candidate.is_file() {
            return Some(candidate);
        }
    }
    None
}

fn detect_vscode() -> Option<PathBuf> {
    if let Some(path) = which_like("code") {
        return Some(path);
    }

    #[cfg(windows)]
    {
        let local_app_data = std::env::var_os("LOCALAPPDATA")?;
        let candidate = PathBuf::from(local_app_data)
            .join("Programs")
            .join("Microsoft VS Code")
            .join("Code.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
    }

    None
}

fn detect_file_explorer() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        let windir = std::env::var_os("WINDIR").unwrap_or_else(|| "C:\\Windows".into());
        let candidate = PathBuf::from(windir).join("explorer.exe");
        if candidate.is_file() {
            return Some(candidate);
        }
        return which_like("explorer");
    }

    #[cfg(not(windows))]
    {
        which_like("xdg-open").or_else(|| which_like("open"))
    }
}

fn detect_visual_studio_with_vswhere() -> Option<PathBuf> {
    #[cfg(not(windows))]
    {
        None
    }

    #[cfg(windows)]
    {
        let program_files_x86 = std::env::var_os("ProgramFiles(x86)")?;
        let vswhere = PathBuf::from(program_files_x86)
            .join("Microsoft Visual Studio")
            .join("Installer")
            .join("vswhere.exe");
        if !vswhere.is_file() {
            return None;
        }
        let output = std::process::Command::new(vswhere)
            .args(["-latest", "-products", "*", "-property", "productPath"])
            .output()
            .ok()?;
        if !output.status.success() {
            return None;
        }
        let path = String::from_utf8_lossy(&output.stdout).trim().to_string();
        if path.is_empty() {
            return None;
        }
        let path = PathBuf::from(path);
        path.is_file().then_some(path)
    }
}
