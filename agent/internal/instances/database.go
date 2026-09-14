package instances

import (
	"compress/gzip"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"github.com/ionnet/gsm/agent/internal/docker"
	"github.com/ionnet/gsm/agent/internal/instfs"
	"github.com/ionnet/gsm/agent/internal/protocol"
)

// The database server beside an instance: a MariaDB container (gsm-db-<uuid>) on a network only
// it and the game's container share (gsm-net-<uuid>), where the game finds it as db:3306. Its
// files live in <data_dir>/databases/<uuid>, outside the instance's files. It starts before the
// game and stops after an operator stops the game; a restart keeps it running.

const (
	// DatabaseHost is the database server's name on the instance's network.
	DatabaseHost = "db"
	// BackupDump is where a backup's database dump is put in the data directory, and so in the
	// archive; a restore imports it from there.
	BackupDump = ".gsm/database.sql.gz"

	databasePort         = "3306"
	databaseReadyTimeout = 3 * time.Minute
	labelDatabase        = "gsm.database"
	labelDatabaseImage   = "gsm.database.image"
	labelDatabaseMemory  = "gsm.database.memory"
)

var databaseNameRe = regexp.MustCompile(`^[a-z][a-z0-9_]{0,31}$`)

// DatabaseDir is where the instance's database files live on the node.
func (m *Manager) DatabaseDir(uuid string) string { return filepath.Join(m.dirs.Databases, uuid) }

func databaseContainer(uuid string) string { return "gsm-db-" + uuid }
func instanceNetwork(uuid string) string   { return "gsm-net-" + uuid }

func checkDatabase(db *protocol.DatabaseSpec) error {
	if db == nil || db.Engine != "mariadb" {
		return invalid("unknown database engine")
	}
	// Names and passwords end up in SQL and the environment; keep them to what the server sends.
	if db.Image == "" || !databaseNameRe.MatchString(db.Name) || !databaseNameRe.MatchString(db.User) ||
		!safeSecret(db.Password) || !safeSecret(db.RootPassword) {
		return invalid("invalid database spec")
	}
	return nil
}

var secretRe = regexp.MustCompile(`^[A-Za-z0-9_-]{16,200}$`)

func safeSecret(s string) bool { return secretRe.MatchString(s) }

// ensureDatabase starts the instance's database server, creating its network, folder and
// container as needed, and waits until it takes connections. A container made from another image
// or memory limit is made again; the files stay. Call with inst.dbMu held.
func (m *Manager) ensureDatabase(ctx context.Context, uuid string, db *protocol.DatabaseSpec, say func(string)) error {
	if err := checkDatabase(db); err != nil {
		return err
	}
	name := databaseContainer(uuid)
	network := instanceNetwork(uuid)
	if err := m.dk.NetworkEnsure(ctx, network, map[string]string{docker.LabelManaged: "true", labelDatabase: uuid}); err != nil {
		return fmt.Errorf("network: %w", err)
	}
	memory := strconv.Itoa(db.MemoryMb)
	insp, err := m.dk.ContainerInspect(ctx, name)
	switch {
	case err == nil && insp.Running && insp.Labels[labelDatabaseImage] == db.Image && insp.Labels[labelDatabaseMemory] == memory:
		return m.waitDatabase(ctx, name, say)
	case err == nil:
		if insp.Running {
			say("[GSM] database: restarting it with new settings")
			_ = m.dk.ContainerStop(ctx, name, "SIGTERM", 60)
		}
		if err := m.dk.ContainerRemove(ctx, name); err != nil {
			return err
		}
	case !docker.IsNotFound(err):
		return err
	}
	if err := m.ensureImage(ctx, db.Image, say); err != nil {
		return fmt.Errorf("image pull failed: %w", err)
	}
	dir := m.DatabaseDir(uuid)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return err
	}
	say("[GSM] database: starting " + db.Image)
	id, err := m.dk.ContainerCreate(ctx, docker.CreateOptions{
		Name:  name,
		Image: db.Image,
		// Read by the image on its first start only; syncDatabaseUser keeps them true later.
		Env: []string{
			"MARIADB_DATABASE=" + db.Name,
			"MARIADB_USER=" + db.User,
			"MARIADB_PASSWORD=" + db.Password,
			"MARIADB_ROOT_PASSWORD=" + db.RootPassword,
			"MARIADB_AUTO_UPGRADE=1",
		},
		Labels: map[string]string{
			docker.LabelManaged: "true",
			labelDatabase:       uuid,
			labelDatabaseImage:  db.Image,
			labelDatabaseMemory: memory,
		},
		Binds:            []string{dir + ":/var/lib/mysql"},
		Network:          network,
		Aliases:          []string{DatabaseHost},
		MemoryBytes:      int64(db.MemoryMb) << 20,
		RestartOnFailure: true,
	})
	if err != nil {
		return fmt.Errorf("create the database container: %w", err)
	}
	if err := m.dk.ContainerStart(ctx, id); err != nil {
		return fmt.Errorf("start the database container: %w", err)
	}
	if err := m.waitDatabase(ctx, name, say); err != nil {
		return err
	}
	m.syncDatabaseUser(ctx, name, db, say)
	say("[GSM] database: ready")
	return nil
}

// waitDatabase waits until the server takes TCP connections on its network address. The image
// runs its first-time setup with networking off, so a connection means the real server is up. On
// failure the server's last log lines go to the console.
func (m *Manager) waitDatabase(ctx context.Context, name string, say func(string)) error {
	deadline := time.Now().Add(databaseReadyTimeout)
	logs := func() {
		if out, err := m.dk.ContainerLogsTail(context.Background(), name, 20); err == nil {
			for _, l := range strings.Split(out, "\n") {
				say("[GSM] database: " + l)
			}
		}
	}
	for {
		insp, err := m.dk.ContainerInspect(ctx, name)
		if err != nil {
			return err
		}
		if !insp.Running && insp.Status != "restarting" {
			logs()
			return fmt.Errorf("the database stopped (exit code %d); see the console", insp.ExitCode)
		}
		if insp.IPAddress != "" {
			if c, err := net.DialTimeout("tcp", net.JoinHostPort(insp.IPAddress, databasePort), 2*time.Second); err == nil {
				c.Close()
				return nil
			}
		}
		if time.Now().After(deadline) {
			logs()
			return fmt.Errorf("the database did not come up within %s; see the console", databaseReadyTimeout)
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-time.After(time.Second):
		}
	}
}

// syncDatabaseUser makes the database and the game's user match the spec even when the files
// were set up with other values (a renamed database, a new password). A failure is only noted:
// the game may still get in.
func (m *Manager) syncDatabaseUser(ctx context.Context, container string, db *protocol.DatabaseSpec, say func(string)) {
	sql := fmt.Sprintf(
		"CREATE DATABASE IF NOT EXISTS `%[1]s`; CREATE USER IF NOT EXISTS '%[2]s'@'%%' IDENTIFIED BY '%[3]s'; "+
			"ALTER USER '%[2]s'@'%%' IDENTIFIED BY '%[3]s'; GRANT ALL PRIVILEGES ON `%[1]s`.* TO '%[2]s'@'%%';",
		db.Name, db.User, db.Password)
	code, stderr, err := m.dk.Exec(ctx, container, clientCmd("mariadb", "--user=root", "-e", sql), rootEnv(db), nil, nil)
	if err != nil || code != 0 {
		say(fmt.Sprintf("[GSM] database: could not check the game's user (%s)", firstOf(err, stderr)))
	}
}

// stopDatabase stops the database server gracefully; its container and files stay.
func (m *Manager) stopDatabase(ctx context.Context, uuid string) {
	name := databaseContainer(uuid)
	if insp, err := m.dk.ContainerInspect(ctx, name); err == nil && insp.Running {
		_ = m.dk.ContainerStop(ctx, name, "SIGTERM", 60)
	}
}

// stopDatabaseIdle stops the instance's database server unless its game is up.
func (m *Manager) stopDatabaseIdle(inst *instance) {
	inst.dbMu.Lock()
	defer inst.dbMu.Unlock()
	inst.mu.Lock()
	up := inst.containerID != ""
	inst.mu.Unlock()
	if !up {
		m.stopDatabase(context.Background(), inst.uuid)
	}
}

// removeDatabase removes the database container and the instance's network and, with
// deleteFiles, the database's files.
func (m *Manager) removeDatabase(ctx context.Context, uuid string, deleteFiles bool) error {
	_ = m.dk.ContainerRemove(ctx, databaseContainer(uuid))
	if err := m.dk.NetworkRemove(ctx, instanceNetwork(uuid)); err != nil {
		m.log.Warn("cannot remove the instance's network", "uuid", uuid, "err", err)
	}
	if deleteFiles {
		return os.RemoveAll(m.DatabaseDir(uuid))
	}
	return nil
}

// withDatabase runs fn with the database server up: started for it when it was not running, and
// stopped again afterwards unless the game started meanwhile.
func (m *Manager) withDatabase(ctx context.Context, uuid string, db *protocol.DatabaseSpec, fn func(container string) error) error {
	if err := checkDatabase(db); err != nil {
		return err
	}
	inst := m.get(uuid)
	inst.dbMu.Lock()
	defer inst.dbMu.Unlock()
	say := func(text string) { m.consoleLine(inst, text) }
	name := databaseContainer(uuid)
	running := false
	if insp, err := m.dk.ContainerInspect(ctx, name); err == nil && insp.Running {
		running = true
	}
	if running {
		if err := m.waitDatabase(ctx, name, say); err != nil {
			return err
		}
	} else if err := m.ensureDatabase(ctx, uuid, db, say); err != nil {
		return err
	}
	err := fn(name)
	if !running {
		inst.mu.Lock()
		up := inst.containerID != ""
		inst.mu.Unlock()
		if !up {
			m.stopDatabase(context.Background(), uuid)
		}
	}
	return err
}

// clientCmd runs one of the image's clients (mariadb, mariadb-dump; mysql, mysqldump in older
// images) with args.
func clientCmd(tool string, args ...string) []string {
	fallback := map[string]string{"mariadb": "mysql", "mariadb-dump": "mysqldump"}[tool]
	script := `c=$(command -v ` + tool + ` || command -v ` + fallback + `) && exec "$c" "$@"`
	return append([]string{"sh", "-c", script, tool}, args...)
}

// rootEnv signs the clients in as root; the password stays off the command line.
func rootEnv(db *protocol.DatabaseSpec) []string { return []string{"MYSQL_PWD=" + db.RootPassword} }

func firstOf(err error, stderr string) string {
	if err != nil {
		return err.Error()
	}
	if stderr == "" {
		return "no details"
	}
	return stderr
}

// instFS is the instance's files as the file manager sees them.
func (m *Manager) instFS(uuid string) *instfs.FS {
	uid, gid, chown := m.OwnerOf(uuid)
	return &instfs.FS{Root: m.DataDir(uuid), UID: uid, GID: gid, Chown: chown}
}

// resolveFile turns a path in the instance's files into one on the node, refusing anything that
// leaves the instance.
func (m *Manager) resolveFile(uuid, rel string) (string, string, error) {
	abs, clean, err := m.instFS(uuid).Resolve(rel)
	var ie *instfs.InvalidError
	if errors.As(err, &ie) {
		return "", "", invalid("%s", ie.Msg)
	}
	if err == nil && clean == "" {
		return "", "", invalid("a file is needed, not the instance's folder")
	}
	return abs, clean, err
}

// DumpDatabase writes a gzipped SQL dump of the database to rel in the instance's files.
func (m *Manager) DumpDatabase(ctx context.Context, uuid string, db *protocol.DatabaseSpec, rel string) (*protocol.DBDumpResult, error) {
	abs, clean, err := m.resolveFile(uuid, rel)
	if err != nil {
		return nil, err
	}
	root := filepath.Clean(m.DataDir(uuid))
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return nil, err
	}
	for dir := filepath.Dir(abs); len(dir) > len(root) && strings.HasPrefix(dir, root); dir = filepath.Dir(dir) {
		m.chownTo(uuid, dir)
	}
	tmp := abs + ".gsm-tmp"
	f, err := os.OpenFile(tmp, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, 0o640)
	if err != nil {
		return nil, err
	}
	defer os.Remove(tmp)
	gz := gzip.NewWriter(f)
	err = m.withDatabase(ctx, uuid, db, func(container string) error {
		code, stderr, err := m.dk.Exec(ctx, container, clientCmd("mariadb-dump", "--user=root",
			"--single-transaction", "--quick", "--routines", "--triggers", "--events", "--hex-blob", db.Name),
			rootEnv(db), nil, gz)
		if err != nil {
			return err
		}
		if code != 0 {
			return fmt.Errorf("the dump failed (exit code %d): %s", code, stderr)
		}
		return nil
	})
	if cerr := gz.Close(); err == nil {
		err = cerr
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return nil, err
	}
	if err := os.Rename(tmp, abs); err != nil {
		return nil, err
	}
	m.chownTo(uuid, abs)
	info, err := os.Stat(abs)
	if err != nil {
		return nil, err
	}
	return &protocol.DBDumpResult{Path: clean, Size: info.Size()}, nil
}

// ImportDatabase replaces the database's contents with the SQL file at rel in the instance's
// files (gzipped when its name ends in .gz).
func (m *Manager) ImportDatabase(ctx context.Context, uuid string, db *protocol.DatabaseSpec, rel string) error {
	abs, _, err := m.resolveFile(uuid, rel)
	if err != nil {
		return err
	}
	f, err := os.Open(abs)
	if errors.Is(err, fs.ErrNotExist) {
		return invalid("%s does not exist", rel)
	} else if err != nil {
		return err
	}
	defer f.Close()
	if info, err := f.Stat(); err != nil || !info.Mode().IsRegular() {
		return invalid("%s is not a file", rel)
	}
	var r io.Reader = f
	if strings.HasSuffix(strings.ToLower(abs), ".gz") {
		gz, err := gzip.NewReader(f)
		if err != nil {
			return invalid("%s is not gzipped", rel)
		}
		defer gz.Close()
		r = gz
	}
	return m.withDatabase(ctx, uuid, db, func(container string) error {
		reset := fmt.Sprintf("DROP DATABASE IF EXISTS `%[1]s`; CREATE DATABASE `%[1]s`; GRANT ALL PRIVILEGES ON `%[1]s`.* TO '%[2]s'@'%%';", db.Name, db.User)
		code, stderr, err := m.dk.Exec(ctx, container, clientCmd("mariadb", "--user=root", "-e", reset), rootEnv(db), nil, nil)
		if err != nil || code != 0 {
			return fmt.Errorf("could not empty the database: %s", firstOf(err, stderr))
		}
		code, stderr, err = m.dk.Exec(ctx, container, clientCmd("mariadb", "--user=root", db.Name), rootEnv(db), r, nil)
		if err != nil {
			return err
		}
		if code != 0 {
			return fmt.Errorf("the import stopped with an error (the database holds what came before it): %s", stderr)
		}
		return nil
	})
}

// DumpForBackup puts a dump of the database at BackupDump for the archive.
func (m *Manager) DumpForBackup(ctx context.Context, uuid string, db *protocol.DatabaseSpec) error {
	_, err := m.DumpDatabase(ctx, uuid, db, BackupDump)
	return err
}

// RemoveBackupDump deletes the dump a backup put in the data directory.
func (m *Manager) RemoveBackupDump(uuid string) {
	p := filepath.Join(m.DataDir(uuid), filepath.FromSlash(BackupDump))
	_ = os.Remove(p)
	_ = os.Remove(filepath.Dir(p)) // .gsm, when nothing else is in it
}

// RestoreBackupDump imports the dump a restored archive brought, then deletes it. It reports
// whether there was one.
func (m *Manager) RestoreBackupDump(ctx context.Context, uuid string, db *protocol.DatabaseSpec) (bool, error) {
	p := filepath.Join(m.DataDir(uuid), filepath.FromSlash(BackupDump))
	if info, err := os.Lstat(p); err != nil || !info.Mode().IsRegular() {
		return false, nil
	}
	if err := m.ImportDatabase(ctx, uuid, db, BackupDump); err != nil {
		return true, err
	}
	m.RemoveBackupDump(uuid)
	return true, nil
}

func (m *Manager) chownTo(uuid, p string) {
	if uid, gid, chown := m.OwnerOf(uuid); chown {
		_ = os.Lchown(p, uid, gid)
	}
}
