package ignore

import (
	"container/list"
	"sync"

	"github.com/appleton/camber/pkg/workspace/path"
)

// lruCache implements a thread-safe LRU cache for storing boolean values
// associated with filesystem paths and their directory status.
type lruCache struct {
	size      int
	evictList *list.List
	items     map[cacheKey]*list.Element
	mu        sync.Mutex
}

type cacheKey struct {
	path  string
	isDir bool
}

type entry struct {
	key   cacheKey
	value bool
}

func newLRU(size int) *lruCache {
	if size <= 0 {
		panic("cache size must be greater than 0")
	}
	return &lruCache{
		size:      size,
		evictList: list.New(),
		items:     make(map[cacheKey]*list.Element),
	}
}

// Add inserts a new value into the cache using the path and isDir as a composite key.
// Returns true if a new entry was added, false if an existing entry was updated.
func (c *lruCache) Add(pth path.Path, isDir bool, value bool) bool {
	key := cacheKey{path: pth.String(), isDir: isDir}

	c.mu.Lock()
	defer c.mu.Unlock()

	if ele, exists := c.items[key]; exists {
		c.evictList.MoveToFront(ele)
		ele.Value.(*entry).value = value
		return false
	}

	ele := c.evictList.PushFront(&entry{key: key, value: value})
	c.items[key] = ele

	if c.evictList.Len() > c.size {
		c.removeOldestNoLock()
	}

	return true
}

// Get retrieves a value from the cache using the path and isDir as a composite key.
// Returns the value and true if found, false and false if not found.
func (c *lruCache) Get(pth path.Path, isDir bool) (value bool, ok bool) {
	key := cacheKey{path: pth.String(), isDir: isDir}

	c.mu.Lock()
	defer c.mu.Unlock()

	if ele, exists := c.items[key]; exists {
		c.evictList.MoveToFront(ele)
		return ele.Value.(*entry).value, true
	}
	return false, false
}

func (c *lruCache) removeOldestNoLock() {
	ele := c.evictList.Back()
	if ele != nil {
		c.evictList.Remove(ele)
		delete(c.items, ele.Value.(*entry).key)
	}
}
