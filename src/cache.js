/**
 * Create an LRU cache for stitched tile canvases.
 * On eviction, canvas dimensions are zeroed to free GPU memory.
 *
 * @param {number} [maxSize=6] - Maximum number of cached entries
 * @returns {{ get: (key: string) => any, put: (key: string, value: any) => void, clear: () => void, size: () => number }}
 */
export function createTileCache(maxSize = 6) {
    const map = new Map();

    return {
        get(key) {
            if (!map.has(key)) return undefined;
            // Move to end (most recently used)
            const value = map.get(key);
            map.delete(key);
            map.set(key, value);
            return value;
        },

        put(key, value) {
            if (map.has(key)) {
                map.delete(key);
            } else if (map.size >= maxSize) {
                const oldestKey = map.keys().next().value;
                const evicted = map.get(oldestKey);
                if (evicted && evicted.canvas) {
                    evicted.canvas.width = 0;
                    evicted.canvas.height = 0;
                }
                map.delete(oldestKey);
            }
            map.set(key, value);
        },

        clear() {
            for (const entry of map.values()) {
                if (entry && entry.canvas) {
                    entry.canvas.width = 0;
                    entry.canvas.height = 0;
                }
            }
            map.clear();
        },

        size() {
            return map.size;
        },
    };
}
