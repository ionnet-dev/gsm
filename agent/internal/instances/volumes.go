package instances

import (
	"archive/tar"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strings"

	"github.com/ionnet/gsm/agent/internal/docker"
	"github.com/ionnet/gsm/agent/internal/protocol"
)

// volumesDir holds an instance's template volumes inside its data directory, so the file manager,
// SFTP and backups see them like any other folder.
const volumesDir = "volumes"

var volumeNameRe = regexp.MustCompile(`^[a-z][a-z0-9_-]{0,31}$`)

// VolumeDir is where a template volume lives on the node.
func (m *Manager) VolumeDir(uuid, name string) string {
	return filepath.Join(m.DataDir(uuid), volumesDir, name)
}

// containerPathOK mirrors containerPathProblem in shared/src/api/templates.ts: a clean absolute
// path, not the root, not in /proc, /sys, /dev, /data or /gsm, and none of the image's system dirs.
func containerPathOK(p string) bool {
	if !strings.HasPrefix(p, "/") || p == "/" || path.Clean(p) != p || strings.ContainsAny(p, ":,") {
		return false
	}
	for _, r := range []string{"/proc", "/sys", "/dev", "/data", "/gsm"} {
		if p == r || strings.HasPrefix(p, r+"/") {
			return false
		}
	}
	switch p {
	case "/bin", "/boot", "/etc", "/lib", "/lib32", "/lib64", "/run", "/sbin", "/usr", "/var":
		return false
	}
	return true
}

// seedsVolumes reports whether a spec has a volume filled from the image.
func seedsVolumes(spec *protocol.InstanceSpec) bool {
	for _, v := range spec.Volumes {
		if v.Seed {
			return true
		}
	}
	return false
}

// securityOpts are the container's security options.
func securityOpts(spec *protocol.InstanceSpec) []string {
	if spec.SeccompUnconfined {
		return []string{"seccomp=unconfined"}
	}
	return nil
}

// mountBinds prepares a spec's volumes and host mounts and returns every bind for its container,
// /data first. A volume folder that does not exist yet is created (seeded from the image when the
// spec says so) and owned by the instance user.
func (m *Manager) mountBinds(ctx context.Context, spec *protocol.InstanceSpec, say func(string)) ([]string, error) {
	dataDir := m.DataDir(spec.UUID)
	binds := []string{dataDir + ":/data"}
	// Docker refuses two mounts on one path; say which instead.
	taken := map[string]bool{"/data": true}
	claim := func(p string) error {
		if taken[p] {
			return invalid("two mounts for %s", p)
		}
		taken[p] = true
		return nil
	}
	if len(spec.Volumes) > 0 {
		root := filepath.Join(dataDir, volumesDir)
		if err := os.MkdirAll(root, 0o755); err != nil {
			return nil, err
		}
		m.chown(root, spec)
	}
	for _, v := range spec.Volumes {
		if !volumeNameRe.MatchString(v.Name) || !containerPathOK(v.Path) {
			return nil, invalid("volume %q: bad name or path %q", v.Name, v.Path)
		}
		if err := claim(v.Path); err != nil {
			return nil, err
		}
		dir := m.VolumeDir(spec.UUID, v.Name)
		if _, err := os.Lstat(dir); errors.Is(err, fs.ErrNotExist) {
			if err := m.createVolume(ctx, spec, v, dir, say); err != nil {
				return nil, fmt.Errorf("volume %s: %w", v.Name, err)
			}
		} else if err != nil {
			return nil, err
		}
		real, err := m.volumeRealPath(spec.UUID, v.Name)
		if err != nil {
			return nil, err
		}
		binds = append(binds, real+":"+v.Path)
	}
	for _, mt := range spec.Mounts {
		if !containerPathOK(mt.ContainerPath) {
			return nil, invalid("host mount: bad container path %q", mt.ContainerPath)
		}
		if err := claim(mt.ContainerPath); err != nil {
			return nil, err
		}
		host, err := m.allowedHostPath(mt.HostPath)
		if err != nil {
			return nil, err
		}
		b := host + ":" + mt.ContainerPath
		if mt.ReadOnly {
			b += ":ro"
		}
		binds = append(binds, b)
	}
	return binds, nil
}

// volumeRealPath checks that a volume is a real folder: the game, an install script or an SFTP
// user can put anything in the instance's files, and Docker follows symlinks in a bind's source
// on the node, so volumes/<name> (or volumes itself) as a symlink would expose the node.
func (m *Manager) volumeRealPath(uuid, name string) (string, error) {
	root, err := filepath.EvalSymlinks(m.DataDir(uuid))
	if err != nil {
		return "", err
	}
	dir := m.VolumeDir(uuid, name)
	real, err := filepath.EvalSymlinks(dir)
	if err != nil {
		return "", err
	}
	info, err := os.Stat(real)
	if err != nil {
		return "", err
	}
	if real != filepath.Join(root, volumesDir, name) || !info.IsDir() {
		return "", invalid("volumes/%s must be a folder, not a link or a file", name)
	}
	return real, nil
}

// createVolume makes a volume's folder, filled from the image with Seed. It is built beside its
// final name and renamed into place, so an interrupted copy is never taken for a finished one.
func (m *Manager) createVolume(ctx context.Context, spec *protocol.InstanceSpec, v protocol.VolumeSpec, dir string, say func(string)) error {
	tmp := dir + ".gsm-new"
	_ = os.RemoveAll(tmp)
	if err := os.MkdirAll(tmp, 0o755); err != nil {
		return err
	}
	m.chown(tmp, spec)
	if v.Seed {
		n, err := m.seedFromImage(ctx, spec, v.Path, tmp)
		if err != nil {
			_ = os.RemoveAll(tmp)
			return fmt.Errorf("copying %s from the image: %w", v.Path, err)
		}
		say(fmt.Sprintf("[GSM] volume %s: copied %d files from the image's %s", v.Name, n, v.Path))
	} else {
		say(fmt.Sprintf("[GSM] volume %s: created %s/%s", v.Name, volumesDir, v.Name))
	}
	return os.Rename(tmp, dir)
}

// seedFromImage copies what the spec's image has at src into dir, owned by the instance user, and
// returns how many files it copied. Folders and regular files only; a path the image does not have
// copies nothing.
func (m *Manager) seedFromImage(ctx context.Context, spec *protocol.InstanceSpec, src, dir string) (int, error) {
	name := "gsm-seed-" + spec.UUID
	_ = m.dk.ContainerRemove(ctx, name)
	id, err := m.dk.ContainerCreate(ctx, docker.CreateOptions{
		Name:   name,
		Image:  spec.Image,
		Cmd:    []string{"true"},
		Labels: map[string]string{docker.LabelManaged: "true", "gsm.seed": spec.UUID},
	})
	if err != nil {
		return 0, err
	}
	defer m.dk.ContainerRemove(context.Background(), id)
	rc, err := m.dk.CopyFrom(ctx, id, src)
	if err != nil {
		if docker.IsNotFound(err) {
			return 0, nil
		}
		return 0, err
	}
	defer rc.Close()
	uid, gid := m.Owner(spec)
	return extractTree(rc, path.Base(src), dir, uid, gid, m.Root)
}

// extractTree unpacks a tar whose entries sit under top/ into dir, dropping top. Anything but
// folders and regular files (links, devices) is skipped, as is any entry that would leave dir.
func extractTree(r io.Reader, top, dir string, uid, gid int, chown bool) (int, error) {
	tr := tar.NewReader(r)
	files := 0
	own := func(p string) {
		if chown {
			_ = os.Lchown(p, uid, gid)
		}
	}
	for {
		hdr, err := tr.Next()
		if errors.Is(err, io.EOF) {
			return files, nil
		}
		if err != nil {
			return files, err
		}
		name := path.Clean(strings.TrimPrefix(hdr.Name, "./"))
		var rel string
		switch {
		case name == top:
			continue
		case strings.HasPrefix(name, top+"/"):
			rel = strings.TrimPrefix(name, top+"/")
		default:
			continue
		}
		if rel == "" || strings.HasPrefix(rel, "/") || rel == ".." || strings.HasPrefix(rel, "../") || strings.Contains(rel, "/../") {
			continue
		}
		target := filepath.Join(dir, filepath.FromSlash(rel))
		switch hdr.Typeflag {
		case tar.TypeDir:
			if err := os.MkdirAll(target, 0o755); err != nil {
				return files, err
			}
			own(target)
		case tar.TypeReg:
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				return files, err
			}
			f, err := os.OpenFile(target, os.O_CREATE|os.O_WRONLY|os.O_TRUNC, fs.FileMode(hdr.Mode).Perm()|0o600)
			if err != nil {
				return files, err
			}
			_, err = io.Copy(f, tr)
			if cerr := f.Close(); err == nil {
				err = cerr
			}
			if err != nil {
				return files, err
			}
			own(target)
			files++
		}
	}
}

// allowedHostPath resolves a host mount's path, symlinks included, and checks that it exists and
// lies under one of the roots the agent's config allows (host_mounts).
func (m *Manager) allowedHostPath(p string) (string, error) {
	if len(m.HostMountRoots) == 0 {
		return "", invalid("this node allows no host mounts (host_mounts in the agent's config)")
	}
	if !filepath.IsAbs(p) || filepath.Clean(p) != p || strings.ContainsAny(p, ":,") {
		return "", invalid("host mount %q is not a clean absolute path", p)
	}
	real, err := filepath.EvalSymlinks(p)
	if err != nil {
		return "", invalid("host mount %s: %v", p, err)
	}
	for _, root := range m.HostMountRoots {
		r, err := filepath.EvalSymlinks(root)
		if err != nil {
			continue
		}
		if real == r || strings.HasPrefix(real, r+string(filepath.Separator)) {
			return real, nil
		}
	}
	return "", invalid("host mount %s is not under a directory this node allows (%s)", p, strings.Join(m.HostMountRoots, ", "))
}
