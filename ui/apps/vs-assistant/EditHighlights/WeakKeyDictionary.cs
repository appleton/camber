using System;
using System.Collections.Generic;
using System.Linq;
using System.Text;
using System.Threading.Tasks;

namespace Camber.Assistant.EditHighlights
{
    /* Dictionary with weak keys. Used because ConditionalWeakTable isn't iterable. */
    public class WeakKeyDictionary<TKey, TValue> where TKey : class
    {
        private readonly Dictionary<WeakReference<TKey>, TValue> _dict = new Dictionary<WeakReference<TKey>, TValue>();

        public void Add(TKey key, TValue value)
        {
            _dict[new WeakReference<TKey>(key)] = value;
        }

        public bool TryGetValue(TKey key, out TValue value)
        {
            foreach (var kvp in _dict)
            {
                if (kvp.Key.TryGetTarget(out TKey existingKey) && ReferenceEquals(existingKey, key))
                {
                    value = kvp.Value;
                    return true;
                }
            }
            value = default;
            return false;
        }

        public IEnumerable<KeyValuePair<TKey, TValue>> GetLiveEntries()
        {
            foreach (var kvp in _dict)
            {
                if (kvp.Key.TryGetTarget(out TKey key))
                    yield return new KeyValuePair<TKey, TValue>(key, kvp.Value);
            }
        }
    }
}
