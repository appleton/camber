package ignore

import (
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/workspace/path"
)

func TestLRUCache(t *testing.T) {
	t.Run("basic operations", func(t *testing.T) {
		assert := assert.New(t)
		require := require.New(t)

		cache := newLRU(2)

		// Test Add and Get
		p1 := path.Parse("/path1")
		added := cache.Add(p1, false, true)
		assert.True(added, "expected Add to return true for new entry")

		val, ok := cache.Get(p1, false)
		require.True(ok, "expected to find value in cache")
		assert.True(val, "expected value to be true")

		// Test size limit
		p2 := path.Parse("/path2")
		p3 := path.Parse("/path3")
		cache.Add(p2, false, true)
		cache.Add(p3, false, true)

		// p1 should be evicted
		_, ok = cache.Get(p1, false)
		assert.False(ok, "expected p1 to be evicted")
	})

	t.Run("update existing", func(t *testing.T) {
		assert := assert.New(t)

		cache := newLRU(2)
		p1 := path.Parse("/path1")

		cache.Add(p1, false, true)
		added := cache.Add(p1, false, false)
		assert.False(added, "expected Add to return false for existing entry")

		val, ok := cache.Get(p1, false)
		assert.True(ok, "expected to find value in cache")
		assert.False(val, "expected updated value to be false")
	})

	t.Run("directory vs file entries", func(t *testing.T) {
		assert := assert.New(t)

		cache := newLRU(2)
		p1 := path.Parse("/path1")

		cache.Add(p1, true, true)   // as directory
		cache.Add(p1, false, false) // as file

		val, ok := cache.Get(p1, true)
		assert.True(ok, "expected to find directory entry")
		assert.True(val, "expected directory value to be true")

		val, ok = cache.Get(p1, false)
		assert.True(ok, "expected to find file entry")
		assert.False(val, "expected file value to be false")
	})

}

func TestLRUCache_InvalidSize(t *testing.T) {
	assert := assert.New(t)

	assert.Panics(func() {
		_ = newLRU(0)
	}, "expected panic for size <= 0")

	assert.Panics(func() {
		_ = newLRU(-1)
	}, "expected panic for size <= 0")
}
