package state

import (
	"context"
	"crypto/subtle"
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"umbratic-veil-console/internal/auth"
	"umbratic-veil-console/internal/config"

	_ "modernc.org/sqlite"
)

type Store struct {
	db       *sql.DB
	dir      string
	lockFile *os.File
}

type Session struct {
	Username  string
	CSRFHash  []byte
	CreatedAt time.Time
	LastSeen  time.Time
	ExpiresAt time.Time
}

type Secrets struct {
	VeilToken    string `json:"veil_token"`
	ControlToken string `json:"control_token"`
	CSRFKey      string `json:"csrf_key"`
}

const (
	SessionIdleTimeout     = 10 * time.Minute
	SessionAbsoluteTimeout = time.Hour
)

func Open(dir string) (*Store, error) {
	if err := secureDirectory(dir); err != nil {
		return nil, err
	}
	lockFile, err := acquireLock(filepath.Join(dir, "console.lock"))
	if err != nil {
		return nil, err
	}
	dbPath := filepath.Join(dir, "console.db")
	db, err := sql.Open("sqlite", dbPath)
	if err != nil {
		lockFile.Close()
		releaseLock(lockFile)
		return nil, err
	}
	db.SetMaxOpenConns(1)
	store := &Store{db: db, dir: dir, lockFile: lockFile}
	if err := migrate(db); err != nil {
		store.Close()
		return nil, fmt.Errorf("initialize Console database: %w", err)
	}
	for _, path := range []string{dbPath, dbPath + "-wal", dbPath + "-shm", filepath.Join(dir, "console.lock")} {
		if err := os.Chmod(path, 0o600); err != nil && !errors.Is(err, os.ErrNotExist) {
			store.Close()
			return nil, err
		}
	}
	return store, nil
}

func secureDirectory(dir string) error {
	info, err := os.Lstat(dir)
	if errors.Is(err, os.ErrNotExist) {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			return fmt.Errorf("create state directory: %w", err)
		}
		info, err = os.Lstat(dir)
	}
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("state path must be a directory, not a symlink")
	}
	if unsafePermissions(info.Mode()) {
		return errors.New("state directory must not be group or world writable")
	}
	if unsafeOwner(info) {
		return errors.New("state directory owner is unsafe")
	}
	if err := validateNoSymlinkPath(dir); err != nil {
		return err
	}
	return os.Chmod(dir, 0o700)
}

func (s *Store) Close() error {
	var first error
	if s.db != nil {
		first = s.db.Close()
	}
	if s.lockFile != nil {
		if err := releaseLock(s.lockFile); first == nil {
			first = err
		}
	}
	return first
}

func (s *Store) IsSetup(ctx context.Context) (bool, error) {
	var count int
	err := s.db.QueryRowContext(ctx, "SELECT count(*) FROM owner").Scan(&count)
	return count == 1, err
}

var ErrSetupComplete = errors.New("Console already has an owner")

func (s *Store) NewSetup(ctx context.Context, now time.Time) (string, error) {
	plain, hash, err := auth.NewToken()
	if err != nil {
		return "", err
	}
	result, err := s.db.ExecContext(ctx, `INSERT INTO setup(id, token_hash, expires_at, used_at)
 SELECT 1, ?, ?, NULL WHERE NOT EXISTS (SELECT 1 FROM owner)
 ON CONFLICT(id) DO UPDATE SET token_hash=excluded.token_hash, expires_at=excluded.expires_at, used_at=NULL
 WHERE NOT EXISTS (SELECT 1 FROM owner)`, hash, now.Add(15*time.Minute).Unix())
	if err != nil {
		return "", err
	}
	count, err := result.RowsAffected()
	if err != nil {
		return "", err
	}
	if count == 0 {
		return "", ErrSetupComplete
	}
	return plain, nil
}

func (s *Store) CreateOwner(ctx context.Context, setupCode, username, verifier string, now time.Time) error {
	if username == "" || len(username) > 64 {
		return errors.New("username must contain 1 to 64 characters")
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	var stored []byte
	var expires int64
	var used sql.NullInt64
	if err := tx.QueryRowContext(ctx, "SELECT token_hash, expires_at, used_at FROM setup WHERE id=1").Scan(&stored, &expires, &used); err != nil {
		return errors.New("setup code is invalid or expired")
	}
	provided := auth.HashToken(setupCode)
	if used.Valid || now.Unix() >= expires || subtle.ConstantTimeCompare(stored, provided) != 1 {
		return errors.New("setup code is invalid or expired")
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO owner(id, username, password_verifier, created_at) VALUES(1, ?, ?, ?)", username, verifier, now.Unix()); err != nil {
		return errors.New("owner already exists")
	}
	if _, err := tx.ExecContext(ctx, "UPDATE setup SET used_at=? WHERE id=1", now.Unix()); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "INSERT INTO audit_events(occurred_at,event,outcome) VALUES(?,?,?)", now.Unix(), "owner.create", "success"); err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) VerifyOwner(ctx context.Context, username, password string) bool {
	var storedUsername, verifier string
	if err := s.db.QueryRowContext(ctx, "SELECT username,password_verifier FROM owner WHERE id=1").Scan(&storedUsername, &verifier); err != nil {
		return false
	}
	if subtle.ConstantTimeCompare([]byte(storedUsername), []byte(username)) != 1 {
		// Keep the expensive work shape for an unknown username.
		_ = auth.VerifyPassword(verifier, password)
		return false
	}
	return auth.VerifyPassword(verifier, password)
}

func (s *Store) CreateSession(ctx context.Context, username string, now time.Time) (token, csrf string, err error) {
	token, tokenHash, err := auth.NewToken()
	if err != nil {
		return "", "", err
	}
	csrf, csrfHash, err := auth.NewToken()
	if err != nil {
		return "", "", err
	}
	_, err = s.db.ExecContext(ctx, "INSERT INTO sessions(token_hash,username,csrf_hash,created_at,last_seen,expires_at) VALUES(?,?,?,?,?,?)",
		tokenHash, username, csrfHash, now.Unix(), now.Unix(), now.Add(SessionAbsoluteTimeout).Unix())
	return token, csrf, err
}

func (s *Store) RotateSession(ctx context.Context, oldToken, username string, now time.Time) (token, csrf string, err error) {
	token, tokenHash, err := auth.NewToken()
	if err != nil {
		return "", "", err
	}
	csrf, csrfHash, err := auth.NewToken()
	if err != nil {
		return "", "", err
	}
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return "", "", err
	}
	defer tx.Rollback()
	if _, err = tx.ExecContext(ctx, "INSERT INTO sessions(token_hash,username,csrf_hash,created_at,last_seen,expires_at) VALUES(?,?,?,?,?,?)",
		tokenHash, username, csrfHash, now.Unix(), now.Unix(), now.Add(SessionAbsoluteTimeout).Unix()); err != nil {
		return "", "", err
	}
	result, err := tx.ExecContext(ctx, "DELETE FROM sessions WHERE token_hash=?", auth.HashToken(oldToken))
	if err != nil {
		return "", "", err
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return "", "", errors.New("session rotation failed")
	}
	return token, csrf, tx.Commit()
}

func (s *Store) Session(ctx context.Context, token string, now time.Time, activity bool) (Session, error) {
	var session Session
	var created, last, expires int64
	err := s.db.QueryRowContext(ctx, "SELECT username,csrf_hash,created_at,last_seen,expires_at FROM sessions WHERE token_hash=?", auth.HashToken(token)).Scan(
		&session.Username, &session.CSRFHash, &created, &last, &expires)
	if err != nil || now.Unix() >= expires || now.Unix()-last >= int64(SessionIdleTimeout.Seconds()) {
		if err == nil {
			_, _ = s.db.ExecContext(ctx, "DELETE FROM sessions WHERE token_hash=?", auth.HashToken(token))
		}
		return Session{}, errors.New("session is invalid or expired")
	}
	if activity {
		_, err = s.db.ExecContext(ctx, "UPDATE sessions SET last_seen=? WHERE token_hash=?", now.Unix(), auth.HashToken(token))
	}
	session.CreatedAt, session.LastSeen, session.ExpiresAt = time.Unix(created, 0), time.Unix(last, 0), time.Unix(expires, 0)
	return session, err
}

func (s *Store) RevokeSession(ctx context.Context, token string) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM sessions WHERE token_hash=?", auth.HashToken(token))
	return err
}

func (s *Store) SavePending(ctx context.Context, cfg config.Veil, now time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "DELETE FROM configurations WHERE status='pending'"); err != nil {
		return err
	}
	var thinking any
	if cfg.ThinkingTokenBudget != nil {
		thinking = *cfg.ThinkingTokenBudget
	}
	parallel := 0
	if cfg.ParallelToolCalls {
		parallel = 1
	}
	_, err = tx.ExecContext(ctx, `INSERT INTO configurations(
status,provider_base_url,model,context_length,max_output_tokens,temperature,top_p,reasoning_effort,thinking_token_budget,
parallel_tool_calls,max_concurrent_requests,max_concurrent_requests_per_user,queue_timeout_ns,model_timeout_ns,request_timeout_ns,max_body_bytes,created_at)
VALUES('pending',?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		cfg.ProviderBaseURL, cfg.Model, cfg.ContextLength, cfg.MaxOutputTokens, cfg.Temperature, cfg.TopP, string(cfg.ReasoningEffort), thinking,
		parallel, cfg.MaxConcurrentRequests, cfg.MaxConcurrentRequestsPerUser, int64(cfg.QueueTimeout),
		int64(cfg.ModelTimeout), int64(cfg.RequestTimeout), cfg.MaxBodyBytes, now.Unix())
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) PromotePending(ctx context.Context, now time.Time) error {
	tx, err := s.db.BeginTx(ctx, nil)
	if err != nil {
		return err
	}
	defer tx.Rollback()
	if _, err := tx.ExecContext(ctx, "DELETE FROM configurations WHERE status='previous'"); err != nil {
		return err
	}
	if _, err := tx.ExecContext(ctx, "UPDATE configurations SET status='previous' WHERE status='current'"); err != nil {
		return err
	}
	result, err := tx.ExecContext(ctx, "UPDATE configurations SET status='current' WHERE status='pending'")
	if err != nil {
		return err
	}
	if changed, _ := result.RowsAffected(); changed != 1 {
		return errors.New("pending configuration is missing")
	}
	_, err = tx.ExecContext(ctx, "INSERT INTO audit_events(occurred_at,event,outcome) VALUES(?,?,?)", now.Unix(), "settings.apply", "success")
	if err != nil {
		return err
	}
	return tx.Commit()
}

func (s *Store) DiscardPending(ctx context.Context) error {
	_, err := s.db.ExecContext(ctx, "DELETE FROM configurations WHERE status='pending'")
	return err
}

func (s *Store) Configuration(ctx context.Context, status string) (config.Veil, bool, error) {
	var cfg config.Veil
	var modelNS, requestNS, queueNS int64
	var reasoning string
	var thinking sql.NullInt64
	var parallel int
	err := s.db.QueryRowContext(ctx, `SELECT provider_base_url,model,context_length,max_output_tokens,temperature,top_p,reasoning_effort,thinking_token_budget,
parallel_tool_calls,max_concurrent_requests,max_concurrent_requests_per_user,queue_timeout_ns,model_timeout_ns,request_timeout_ns,max_body_bytes
FROM configurations WHERE status=?`, status).Scan(
		&cfg.ProviderBaseURL, &cfg.Model, &cfg.ContextLength, &cfg.MaxOutputTokens, &cfg.Temperature, &cfg.TopP, &reasoning, &thinking,
		&parallel, &cfg.MaxConcurrentRequests, &cfg.MaxConcurrentRequestsPerUser, &queueNS, &modelNS, &requestNS, &cfg.MaxBodyBytes)
	if errors.Is(err, sql.ErrNoRows) {
		return config.Veil{}, false, nil
	}
	if err != nil {
		return config.Veil{}, false, err
	}
	effort, err := config.ParseReasoningEffort(reasoning)
	if err != nil {
		return config.Veil{}, false, err
	}
	cfg.ReasoningEffort = effort
	if thinking.Valid {
		value := int(thinking.Int64)
		cfg.ThinkingTokenBudget = &value
	}
	cfg.ParallelToolCalls = parallel != 0
	cfg.QueueTimeout, cfg.ModelTimeout, cfg.RequestTimeout = time.Duration(queueNS), time.Duration(modelNS), time.Duration(requestNS)
	return cfg, true, nil
}

func (s *Store) Audit(ctx context.Context, event, outcome string, now time.Time) {
	_, _ = s.db.ExecContext(ctx, "INSERT INTO audit_events(occurred_at,event,outcome) VALUES(?,?,?)", now.Unix(), event, outcome)
}

func (s *Store) LoadOrCreateSecrets() (Secrets, error) {
	path := filepath.Join(s.dir, "secrets.json")
	payload, err := os.ReadFile(path)
	if err == nil {
		var secrets Secrets
		if json.Unmarshal(payload, &secrets) != nil || secrets.VeilToken == "" || secrets.ControlToken == "" || secrets.CSRFKey == "" {
			return Secrets{}, errors.New("secret store is invalid")
		}
		if info, statErr := os.Stat(path); statErr != nil || unsafeSecretPermissions(info.Mode()) {
			return Secrets{}, errors.New("secret store permissions are unsafe")
		}
		return secrets, nil
	}
	if !errors.Is(err, os.ErrNotExist) {
		return Secrets{}, err
	}
	veilToken, _, err := auth.NewToken()
	if err != nil {
		return Secrets{}, err
	}
	csrfKey, _, err := auth.NewToken()
	if err != nil {
		return Secrets{}, err
	}
	controlToken, _, err := auth.NewToken()
	if err != nil {
		return Secrets{}, err
	}
	secrets := Secrets{VeilToken: veilToken, ControlToken: controlToken, CSRFKey: csrfKey}
	return secrets, s.SaveSecrets(secrets)
}

func (s *Store) SaveSecrets(secrets Secrets) error {
	payload, err := json.Marshal(secrets)
	if err != nil {
		return err
	}
	temporary, err := os.OpenFile(filepath.Join(s.dir, ".secrets.tmp"), os.O_CREATE|os.O_TRUNC|os.O_WRONLY, 0o600)
	if err != nil {
		return err
	}
	tempPath := temporary.Name()
	ok := false
	defer func() {
		temporary.Close()
		if !ok {
			os.Remove(tempPath)
		}
	}()
	if _, err := temporary.Write(payload); err != nil {
		return err
	}
	if err := temporary.Sync(); err != nil {
		return err
	}
	if err := temporary.Close(); err != nil {
		return err
	}
	if err := os.Chmod(tempPath, 0o600); err != nil {
		return err
	}
	if err := os.Rename(tempPath, filepath.Join(s.dir, "secrets.json")); err != nil {
		return err
	}
	ok = true
	directory, err := os.Open(s.dir)
	if err == nil {
		_ = directory.Sync()
		_ = directory.Close()
	}
	return nil
}
