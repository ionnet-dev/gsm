//go:build !windows

package update

import "os"

// replaceExecutable renames the download over the running binary; the running process keeps its
// mapped inode.
func replaceExecutable(tmp, self string) error { return os.Rename(tmp, self) }

// CleanUp removes leftovers of an earlier update; nothing to do on Unix.
func CleanUp() {}
