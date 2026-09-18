package state

import (
	"context"
	"database/sql"
	"errors"
	"umbratic-veil-console/internal/config"
)

func (s *Store) Connection(ctx context.Context) (config.Connection, error) {
	c := config.DefaultConnection()
	err := s.db.QueryRowContext(ctx, "SELECT host, port, tls FROM connection_settings WHERE id = 1").Scan(&c.Host, &c.Port, &c.TLS)
	if errors.Is(err, sql.ErrNoRows) {
		return c, nil
	}
	return c, err
}
func (s *Store) SaveConnection(ctx context.Context, c config.Connection) error {
	if err := c.Validate(); err != nil {
		return err
	}
	_, err := s.db.ExecContext(ctx, `INSERT INTO connection_settings(id, host, port, tls) VALUES(1, ?, ?, ?)
 ON CONFLICT(id) DO UPDATE SET host=excluded.host, port=excluded.port, tls=excluded.tls`, c.Host, c.Port, c.TLS)
	return err
}
