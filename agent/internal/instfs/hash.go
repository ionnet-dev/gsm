package instfs

import (
	"crypto/sha256"
	"encoding/hex"
	"hash"
)

type shaHasher struct{ hash.Hash }

func newSHA() *shaHasher { return &shaHasher{sha256.New()} }

func (hw *hashingWriter) sum() string {
	if s, ok := hw.h.(*shaHasher); ok {
		return hex.EncodeToString(s.Sum(nil))
	}
	return ""
}
