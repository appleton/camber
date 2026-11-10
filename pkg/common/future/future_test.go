package future_test

import (
	"context"
	"errors"
	"fmt"
	"sync"
	"testing"
	"testing/synctest"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"

	"github.com/appleton/camber/pkg/common/future"
)

func TestBasicResolveAndRead(t *testing.T) {
	synctest.Test(t, func(*testing.T) {
		f := future.New[int]()

		done := make(chan bool)
		go func() {
			ctx := context.Background()
			val, err := f.Await(ctx)
			assert.NoError(t, err)
			assert.Equal(t, 42, val)
			done <- true
		}()

		// Let reader start, then resolve
		synctest.Wait()
		f.Resolve(42)

		<-done
	})
}

func TestMultipleReaders(t *testing.T) {
	synctest.Test(t, func(*testing.T) {
		f := future.New[*[]int]()
		numReaders := 20
		var wg sync.WaitGroup
		results := make([]*[]int, numReaders)

		// Start multiple concurrent readers
		for i := 0; i < numReaders; i++ {
			wg.Add(1)
			go func(idx int) {
				defer wg.Done()
				ctx := context.Background()
				val, err := f.Await(ctx)
				results[idx] = val
				assert.NoError(t, err)
			}(i)
		}

		synctest.Wait()
		sharedSlice := &[]int{1, 2, 3}
		f.Resolve(sharedSlice)

		wg.Wait()

		// verify all readers got the exactly the same value (identity, not just equality)
		for i := 0; i < numReaders; i++ {
			assert.Same(t, sharedSlice, results[i], "reader %d got different instance", i)
		}
	})
}

func TestResolveOnce(t *testing.T) {
	synctest.Test(t, func(*testing.T) {
		f := future.New[int]()

		var wg sync.WaitGroup
		numResolvers := 25

		for i := 0; i < numResolvers; i++ {
			wg.Add(1)
			go func(val int) {
				defer wg.Done()
				f.Resolve(val)
			}(i)
		}

		wg.Wait()

		// Read the value - should be consistent
		ctx := context.Background()
		val1, err1 := f.Await(ctx)
		require.NoError(t, err1, "first read failed")

		val2, err2 := f.Await(ctx)
		require.NoError(t, err2, "second read failed")

		require.Equal(t, val1, val2, "inconsistent values")

		// Value should be within expected range (0 to numResolvers-1)
		require.GreaterOrEqual(t, val1, 0, "value below expected range")
		require.Less(t, val1, numResolvers, "value above expected range")
	})
}

func TestContextCancellation(t *testing.T) {
	synctest.Test(t, func(*testing.T) {
		f := future.New[string]()

		ctx, cancel := context.WithCancel(context.Background())

		// Start reader with cancellable context
		done := make(chan struct{})
		var val string
		var err error

		go func() {
			defer close(done)
			val, err = f.Await(ctx)
		}()

		// Let reader start, then cancel context
		synctest.Wait()
		cancel()

		<-done

		require.True(t, errors.Is(err, context.Canceled), "expected context.Canceled, got %v", err)
		require.Empty(t, val, "expected empty string")
	})
}

// ExampleRWFuture_MustGet demonstrates using Done + MustGet when you
// need to compose with multiple channels
func ExampleRWFuture_MustGet() {
	f := future.New[string]()

	// Simulate some other work happening concurrently
	otherWork := make(chan string)
	go func() {
		time.Sleep(1 * time.Millisecond)
		otherWork <- "work_completed"
	}()

	// Simulate future being resolve later
	go func() {
		time.Sleep(1 * time.Second)
		f.Resolve("resolved_value")
	}()

	// Correct usage pattern to compose future with other channels: observe Done()
	// channel before calling MustGet()
	select {
	case <-f.Done():
		value := f.MustGet()
		fmt.Printf("Got future value: %s\n", value)
	case workResult := <-otherWork:
		fmt.Printf("Got other work result: %s\n", workResult)
	case <-time.After(50 * time.Millisecond):
		fmt.Println("Timeout")
	}

	// Output: Got other work result: work_completed
}

// Example_RWFuture_TryGet demonstrates non-blocking attempts to retrieve values
func ExampleRWFuture_TryGet() {
	f := future.New[int]()

	// First attempt - value not yet available
	if value, ok := f.TryGet(); ok {
		fmt.Printf("Unexpected value: %d\n", value)
	} else {
		fmt.Println("Value not available yet")
	}

	// Resolve the future
	f.Resolve(42)

	// Second attempt - value now available
	if value, ok := f.TryGet(); ok {
		fmt.Printf("Got value: %d\n", value)
	} else {
		fmt.Println("Still no value")
	}

	// Output:
	// Value not available yet
	// Got value: 42
}

// ExampleRWFuture_Await demonstrates the usage of Await with context control
func ExampleRWFuture_Await() {
	f := future.New[string]()

	// Example 1: Successful await with background context
	go func() {
		time.Sleep(10 * time.Millisecond)
		f.Resolve("success")
	}()

	ctx := context.Background()
	value, err := f.Await(ctx)
	if err == nil {
		fmt.Printf("Got value: %s\n", value)
	}

	// Example 2: Timeout scenario
	f2 := future.New[int]()
	ctx2, cancel2 := context.WithTimeout(context.Background(), 5*time.Millisecond)
	defer cancel2()

	// will unblock with err if context is cancelled before resolved
	_, err2 := f2.Await(ctx2)
	if err2 != nil {
		fmt.Printf("Timeout error: %v\n", err2)
	}

	// Output:
	// Got value: success
	// Timeout error: context deadline exceeded
}
